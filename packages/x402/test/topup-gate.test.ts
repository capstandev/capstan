// Top-up credits through the real x402 gate (todo 34 R6, fix after review): topupSettleHook is registered on the
// resource server and credits ONLY the request that was really served. A client that pays for a normal priced route
// and writes a top-up URL into paymentPayload.resource.url gets no credits (the SDK never checks that URL). An honest
// POST /v1/credits/topup/20?account=<id> credits $20 once. Fake facilitator (verify and settle always succeed), real
// x402 client signatures, real @x402/hono middleware. Skips without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, schema, type Db } from "@capstan/core";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { topupSettleHook } from "../../tiers/src/credits";
import { createApiKey } from "../../tiers/src/keys";
import type { X402State } from "../src/accepts";
import { clientSpendControls } from "../src/client";
import { createResourceServer, paymentGate } from "../src/gate";
import { NETWORKS, railDefs } from "../src/networks";
import { labelAccount } from "./helpers/chain";

const PG = process.env.DATABASE_URL;
const payer = labelAccount("topup-payer");
const defs = railDefs("testnet");
const tok = (id: keyof typeof defs) => ({ asset: defs[id].asset, decimals: 6, name: defs[id].domain!.name, version: defs[id].domain!.version });

let txn = 0;
function fakeFacilitator(): FacilitatorClient {
  return {
    async verify(p: PaymentPayload) {
      const auth = (p.payload as { authorization?: { from?: string } }).authorization;
      return { isValid: true, payer: auth?.from ?? payer.address };
    },
    async settle(_p: PaymentPayload, r: PaymentRequirements) {
      txn++;
      return { success: true, transaction: `0x${txn.toString(16).padStart(64, "0")}`, network: r.network, payer: payer.address };
    },
    async getSupported() {
      return { kinds: [NETWORKS.baseSepolia].map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: { "eip155:*": ["0x00000000000000000000000000000000000000f1"] } };
    },
  };
}

const state = (): X402State => ({
  usdgEip3009: { "4663": false, "46630": false },
  payTo: { evm: "0x00000000000000000000000000000000000000aa", sol: "So1PayTo1111111111111111111111111111111111" },
  tokens: { "base-usdc": tok("base-usdc") },
  droppedRails: ["rhc-usdg-permit2", "rhc-usdg-eip3009"],
});

(PG ? describe : describe.skip)("top-up hook behind the real gate", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_topup" });
    db = createDb(t.url, { max: 4 });
    drop = async () => {
      await closeDb(db);
      await t.drop();
    };
  }, 30_000);
  afterAll(async () => {
    await drop?.();
  }, 30_000);

  const balance = async (id: string) => (await db.select().from(schema.apiAccounts).where(eq(schema.apiAccounts.id, id)))[0]!.credits;

  test("forged-resource-url-is-not-credited", async () => {
    const rs = createResourceServer(fakeFacilitator());
    rs.onAfterSettle(topupSettleHook(db));
    const app = new Hono();
    app.use(
      "*",
      paymentGate(
        { "GET /v1/funding/forecast": { usd: "0.01", description: "funding forecast" }, "POST /v1/credits/topup/20": { usd: "20", description: "credits" } },
        rs,
        { env: "testnet", state, syncFacilitatorOnStart: true },
      ),
    );
    app.get("/v1/funding/forecast", (c) => c.json({ ok: true }));
    app.post("/v1/credits/topup/20", (c) => c.json({ account: c.req.query("account") }, 202));

    const { id: self } = await createApiKey(db, null);
    const client = new x402Client((_v, reqs) => reqs[0]!);
    client.register(NETWORKS.baseSepolia, new ExactEvmScheme(payer));
    client.setSpendControls(clientSpendControls("testnet", "20")); // our client cap, raised to the $20 pack
    const pay = async (path: string, method: string, forgeUrl?: string) => {
      const r1 = await app.request(path, { method });
      expect(r1.status).toBe(402);
      const payload = await client.createPaymentPayload(decodePaymentRequiredHeader(r1.headers.get("PAYMENT-REQUIRED")!));
      const sent = forgeUrl ? { ...payload, resource: { ...(payload.resource ?? { description: "", mimeType: "" }), url: forgeUrl } } : payload;
      return app.request(path, { method, headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(sent) } });
    };

    // the attack: pay $0.01 for the forecast, claim in resource.url that it was a $20 top-up for my account
    const forged = `http://localhost/v1/credits/topup/20?account=${self}`;
    const a = await pay("/v1/funding/forecast", "GET", forged);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    expect(txn).toBe(1); // the payment did settle
    expect(Number(await balance(self))).toBe(0); // and bought no credits

    // the honest top-up credits $20 once, even when its own resource.url names another route
    const h = await pay(`/v1/credits/topup/20?account=${self}`, "POST", "http://localhost/v1/funding/forecast");
    expect(h.status).toBe(202);
    expect(txn).toBe(2);
    expect(await balance(self)).toBe("20");
  }, 60_000);
});
