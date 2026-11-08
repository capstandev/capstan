// Security review r1 review-r1:4 F4: a credit top-up whose settle came back settlement_pending (the receipt wait
// timed out or the RPC failed) was charged on chain once the tx mined but never credited, and nothing reconciled it.
// After the fix the boot wiring records the served account and pack when the settle is pending, and the
// topup-reconcile job credits it exactly once when the facilitator's row for that tx turns settled.
// Through the api boot wiring (gatewayFromEnv), real x402 client signatures, a facilitator whose settle answers
// settlement_pending. Needs DATABASE_URL and REDIS_URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, loadConfig, memoryNonceStore, schema, type Db, type JobDeps } from "@capstan/core";
import { createApiKey } from "@capstan/plans";
import { clientSpendControls, NETWORKS } from "@capstan/x402";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { eq } from "drizzle-orm";
import { labelAccount } from "../../../../packages/x402/test/helpers/chain";
import { fakeTestnetChains as chains } from "../../../../packages/x402/test/helpers/fake-chain";
import { discoverRoutes } from "../../src/app";
import { gatewayFromEnv } from "../../src/auth/env";
import { createCreditsRoutes } from "../../src/routes/credits.routes";
import { smallApp } from "../gw-helpers";

const PG = process.env.DATABASE_URL;
const REDIS = process.env.REDIS_URL;
const payer = labelAccount("r1-topup-pending-payer");
const PAY_TO = { X402_PAY_TO_EVM: "0x00000000000000000000000000000000000000aa", X402_PAY_TO_SOL: "So1PayTo1111111111111111111111111111111111" };
const TX = `0x${"ab".repeat(32)}`;

let settleCalls = 0;
const facilitator: FacilitatorClient = {
  async verify(p: PaymentPayload) {
    return { isValid: true, payer: (p.payload as { authorization?: { from?: string } }).authorization?.from ?? payer.address };
  },
  // the broadcast happened, but the receipt wait failed: settlement_pending with the tx hash (twice: the SDK retries once)
  async settle(_p: PaymentPayload, r: PaymentRequirements) {
    settleCalls++;
    return { success: false, errorReason: "settlement_pending", transaction: TX, network: r.network, payer: payer.address };
  },
  async getSupported() {
    return { kinds: [NETWORKS.baseSepolia, NETWORKS.rhcTestnet].map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: { "eip155:*": ["0x00000000000000000000000000000000000000f1"] } };
  },
};

(PG && REDIS ? describe : describe.skip)("r1 F4: a pending top-up is credited once it settles", () => {
  let db: Db;
  let url: string;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_r1_topup" });
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

  test("settlement_pending, then the tx mines: credited exactly once", async () => {
    const cfg = loadConfig("api", { CAPSTAN_NETWORK: "testnet", DATABASE_URL: url, REDIS_URL: REDIS!, X402_ENABLED: "1", PUBLIC_API_HOST: "api.capstan.test" });
    const specs = (await discoverRoutes()).map((r) => r.spec);
    const gw = await gatewayFromEnv(cfg, PAY_TO, specs, { facilitator, ...chains(false) });
    const credits = createCreditsRoutes(() => ({ db, lock: { lockedOf: async () => ({ amount: 0n, unlockAt: 0n }) }, host: "api.capstan.test", nonces: memoryNonceStore() }));
    const app = (await smallApp(credits, gw)).app;
    const balance = async (id: string) => (await db.select().from(schema.apiAccounts).where(eq(schema.apiAccounts.id, id)))[0]!.credits;

    const { id } = await createApiKey(db, null);
    const path = `/v1/credits/topup/20?account=${id}`;
    const r1 = await app.request(path, { method: "POST" });
    expect(r1.status).toBe(402);
    const required = decodePaymentRequiredHeader(r1.headers.get("PAYMENT-REQUIRED")!);
    const client = new x402Client((_v, reqs) => reqs.find((r) => r.network === NETWORKS.baseSepolia)!);
    client.register(NETWORKS.baseSepolia, new ExactEvmScheme(payer));
    client.setSpendControls(clientSpendControls("testnet", "25"));
    const paid = await app.request(path, { method: "POST", headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(await client.createPaymentPayload(required)) } });
    expect(paid.status).toBe(402); // not settled yet: the response is withheld
    expect(settleCalls).toBeGreaterThan(0);
    expect(Number(await balance(id))).toBe(0);

    // later the tx mines and the facilitator's reconciler marks its row settled
    await db.insert(schema.x402Payments).values({ id: "pay-r1-f4", chain: NETWORKS.baseSepolia, asset: required.accepts.find((a) => a.network === NETWORKS.baseSepolia)!.asset, method: "eip3009", payer: payer.address, amount: "20000000", endpoint: "", txHash: TX, status: "settled", ts: new Date() });

    // the reconcile job (absent before the fix: then nothing ever credits the account)
    const mod = (await import("../../../workers/src/jobs/topup-reconcile.job").catch(() => null)) as { runTopupReconcile?: (d: JobDeps) => Promise<unknown> } | null;
    const deps = { db, redis: null, cache: null, log: { info() {}, warn() {}, error() {}, debug() {} }, now: () => new Date() } as unknown as JobDeps;
    await mod?.runTopupReconcile?.(deps);
    expect(Number(await balance(id))).toBe(20);
    // run again: never credited twice
    await mod?.runTopupReconcile?.(deps);
    expect(Number(await balance(id))).toBe(20);
  }, 60_000);

  test("a dropped payment is never credited, is closed once and alerts once", async () => {
    const plans = await import("@capstan/plans");
    if (!("reconcilePendingTopups" in plans)) throw new Error("no pending top-up reconciler");
    const p = plans as unknown as typeof import("../../../../packages/tiers/src/credits");
    const { id } = await createApiKey(db, null);
    const tx = `0x${"cd".repeat(32)}`;
    const ref = p.pendingTopupRef({ network: NETWORKS.baseSepolia, transaction: tx, amount: "5000000", decimals: 6 });
    await db.insert(schema.creditLedger).values({ id: `pend-${id}`, accountId: id, delta: "0", reason: p.TOPUP_PENDING_REASON, ref, ts: new Date(Date.now() - 20 * 60_000) });
    const alerts: { kind: string }[] = [];
    const alerted = new Set<string>();
    // still pending after 20 minutes: one alert, however many runs
    for (let i = 0; i < 3; i++) await p.reconcilePendingTopups(db, { now: Date.now, alerted, alert: (a) => void alerts.push(a) });
    expect(alerts.map((a) => a.kind)).toEqual(["x402.topup_pending"]);
    await db.insert(schema.x402Payments).values({ id: "pay-r1-f4-dropped", chain: NETWORKS.baseSepolia, asset: "0x0", method: "eip3009", payer: payer.address, amount: "5000000", endpoint: "", txHash: tx, status: "dropped", ts: new Date() });
    for (let i = 0; i < 2; i++) await p.reconcilePendingTopups(db, { now: Date.now, alerted, alert: (a) => void alerts.push(a) });
    expect(alerts.map((a) => a.kind)).toEqual(["x402.topup_pending", "x402.topup_not_credited"]);
    expect(Number((await db.select().from(schema.apiAccounts).where(eq(schema.apiAccounts.id, id)))[0]!.credits)).toBe(0);
  });
});
