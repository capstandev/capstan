// Todo 29 money path, through the api boot wiring (gatewayFromEnv, the same call apps/api/src/index.ts makes):
// - topup-credit-lands: a paid POST /v1/credits/topup/20?account=<id> settles AND adds $20 of credit, because the
//   boot wiring registers topupSettleHook on the resource server (before, the payment settled and nothing was credited);
// - detection-at-boot-fails-closed: the USDG EIP-3009 detection runs at boot and writes x402_detections; an unhealthy
//   RHC testnet token is recorded absent and its eip3009 option is never offered (before, the testnet flag was
//   hard-coded true and nothing was detected); a healthy token is offered.
// Fake facilitator (verify and settle succeed) and fake read-only chain clients; real x402 client signatures, real
// @x402/hono middleware, real routes. Skips without DATABASE_URL and REDIS_URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, loadConfig, memoryNonceStore, schema, type Db } from "@capstan/core";
import { createApiKey } from "@capstan/plans";
import type { Hex } from "@capstan/schema";
import { clientSpendControls, NETWORKS, railOf } from "@capstan/x402";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { eq } from "drizzle-orm";
import { labelAccount } from "../../../packages/x402/test/helpers/chain";
import { fakeTestnetChains as chains } from "../../../packages/x402/test/helpers/fake-chain";
import { discoverRoutes } from "../src/app";
import { gatewayFromEnv } from "../src/auth/env";
import { createCreditsRoutes } from "../src/routes/credits.routes";
import { smallApp } from "./gw-helpers";

const PG = process.env.DATABASE_URL;
const REDIS = process.env.REDIS_URL;
const payer = labelAccount("api-boot-topup-payer");
const PAY_TO = { X402_PAY_TO_EVM: "0x00000000000000000000000000000000000000aa", X402_PAY_TO_SOL: "So1PayTo1111111111111111111111111111111111" };

let txn = 0;
const facilitator: FacilitatorClient = {
  async verify(p: PaymentPayload) {
    return { isValid: true, payer: (p.payload as { authorization?: { from?: string } }).authorization?.from ?? payer.address };
  },
  async settle(_p: PaymentPayload, r: PaymentRequirements) {
    txn++;
    return { success: true, transaction: `0x${txn.toString(16).padStart(64, "0")}`, network: r.network, payer: payer.address };
  },
  async getSupported() {
    return { kinds: [NETWORKS.baseSepolia, NETWORKS.rhcTestnet].map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: { "eip155:*": ["0x00000000000000000000000000000000000000f1"] } };
  },
};

(PG && REDIS ? describe : describe.skip)("api boot x402 wiring", () => {
  let db: Db;
  let url: string;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_x402boot" });
    url = t.url;
    db = createDb(t.url, { max: 4 });
    drop = async () => {
      await closeDb(db);
      await t.drop();
    };
  }, 30_000);
  afterAll(async () => {
    await drop?.();
  }, 30_000);

  async function bootApp(eip3009: boolean) {
    const cfg = loadConfig("api", { CAPSTAN_NETWORK: "testnet", DATABASE_URL: url, REDIS_URL: REDIS!, X402_ENABLED: "1", PUBLIC_API_HOST: "api.capstan.test" });
    const specs = (await discoverRoutes()).map((r) => r.spec);
    const gw = await gatewayFromEnv(cfg, PAY_TO, specs, { facilitator, ...chains(eip3009) });
    const credits = createCreditsRoutes(() => ({ db, lock: { lockedOf: async () => ({ amount: 0n, unlockAt: 0n }) }, host: "api.capstan.test", nonces: memoryNonceStore() }));
    return (await smallApp(credits, gw)).app;
  }
  const balance = async (id: string) => (await db.select().from(schema.apiAccounts).where(eq(schema.apiAccounts.id, id)))[0]!.credits;

  test("topup-credit-lands", async () => {
    const app = await bootApp(false);
    const { id } = await createApiKey(db, null);
    const path = `/v1/credits/topup/20?account=${id}`;
    const r1 = await app.request(path, { method: "POST" });
    expect(r1.status).toBe(402);
    const required = decodePaymentRequiredHeader(r1.headers.get("PAYMENT-REQUIRED")!);
    expect(required.accepts[0]!.network).toBe(NETWORKS.baseSepolia);
    expect(required.accepts[0]!.amount).toBe("20000000");
    const client = new x402Client((_v, reqs) => reqs[0]!);
    client.register(NETWORKS.baseSepolia, new ExactEvmScheme(payer));
    client.setSpendControls(clientSpendControls("testnet", "20"));
    const payload = await client.createPaymentPayload(required);
    const before = txn;
    const r2 = await app.request(path, { method: "POST", headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
    expect(r2.status).toBe(202);
    expect(txn).toBe(before + 1); // the payment settled
    expect(await balance(id)).toBe("20"); // and the credit landed
    const ledger = await db.select().from(schema.creditLedger).where(eq(schema.creditLedger.accountId, id));
    expect(ledger.length).toBe(1);
  }, 60_000);

  test("detection-at-boot-fails-closed", async () => {
    const offered = async (app: Awaited<ReturnType<typeof bootApp>>) => {
      const r = await app.request("/v1/credits/topup/5?account=acct-none", { method: "POST" });
      expect(r.status).toBe(402);
      return decodePaymentRequiredHeader(r.headers.get("PAYMENT-REQUIRED")!).accepts.map((a) => railOf(a, "testnet"));
    };
    const row = async () => (await db.select().from(schema.x402Detections).where(eq(schema.x402Detections.chain, NETWORKS.rhcTestnet)))[0];

    // an RHC testnet USDG without a working EIP-3009 surface: recorded absent at boot, eip3009 never offered
    const sick = await bootApp(false);
    expect((await row())?.supported).toBe(false);
    expect(await offered(sick)).toEqual(["base-usdc", "rhc-usdg-permit2"]);

    // a healthy token: detection passes at boot and the eip3009 option is offered last
    const healthy = await bootApp(true);
    expect((await row())?.supported).toBe(true);
    expect(await offered(healthy)).toEqual(["base-usdc", "rhc-usdg-permit2", "rhc-usdg-eip3009"]);
  }, 60_000);
});
