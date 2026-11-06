// R10: /settle twice with one payload sends one transaction; a crash after broadcast leaves a settlement_pending row
// that the reconciler confirms by tx hash (memory store always, Postgres when DATABASE_URL is set).
// R11: /verify writes no state. R16: no broadcast on 8453, 4663 or Solana mainnet unless armed (flag + file + mainnet).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, logger, schema, type Db } from "@capstan/core";
import { NETWORKS } from "@capstan/x402";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFacilitatorApp } from "../src/app";
import { settleArmed } from "../src/env";
import { broadcastTracker, createFacilitatorService, ERR, paymentKey, type ChainProbe } from "../src/service";
import { memoryPaymentStore, pgPaymentStore, type PaymentStore } from "../src/store";

const quiet = logger("test", { sink: () => {} });
const PG = process.env.DATABASE_URL;
const HASH = `0x${"12".repeat(32)}`;

function body(network: string, nonce = "01", amount = "10000") {
  const req: PaymentRequirements = {
    scheme: "exact",
    network: network as PaymentRequirements["network"],
    asset: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
    amount,
    payTo: "0x00000000000000000000000000000000000000aa",
    maxTimeoutSeconds: 60,
    extra: { name: "Global Dollar", version: "1" },
  };
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: { url: "https://api.example.test/v1/funding/forecast" },
    accepted: req,
    payload: { signature: `0x${"ee".repeat(65)}`, authorization: { from: "0x00000000000000000000000000000000000000bb", to: req.payTo, value: amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${nonce.repeat(32)}` } },
  };
  return { x402Version: 2, paymentPayload: payload, paymentRequirements: req };
}

/** Stand-in for the SDK facilitator: each settle reports its hash to the tracker (as the real signer does) and counts sends. */
function stubFacilitator(tracker: ReturnType<typeof broadcastTracker>, mode: { crashAfterBroadcast?: boolean; slowMs?: number } = {}) {
  const calls = { verify: 0, settle: 0, sends: 0 };
  const f = {
    async verify() {
      calls.verify++;
      return { isValid: true, payer: "0x00000000000000000000000000000000000000bb" };
    },
    async settle(_p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
      calls.settle++;
      if (mode.slowMs) await Bun.sleep(mode.slowMs);
      await tracker.onBroadcast(HASH);
      calls.sends++;
      if (mode.crashAfterBroadcast) throw new Error("process died after broadcast");
      return { success: true, transaction: HASH, network: r.network, payer: "0x00000000000000000000000000000000000000bb" };
    },
    getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
  };
  return { f, calls };
}

function makeService(store: PaymentStore, opts: { crash?: boolean; armed?: boolean; probe?: ChainProbe; slowMs?: number } = {}) {
  const tracker = broadcastTracker();
  const { f, calls } = stubFacilitator(tracker, { crashAfterBroadcast: opts.crash, slowMs: opts.slowMs });
  const alerts: unknown[] = [];
  const probe: ChainProbe = opts.probe ?? { receipt: async () => "success", known: async () => true };
  const svc = createFacilitatorService({
    facilitator: f as never,
    store,
    tracker,
    probes: { [NETWORKS.rhcTestnet]: probe, [NETWORKS.rhc]: probe, [NETWORKS.base]: probe, [NETWORKS.baseSepolia]: probe },
    log: quiet,
    alert: (a) => void alerts.push(a),
    isArmed: () => opts.armed ?? false,
  });
  return { svc, calls, alerts };
}

async function idempotencySuite(store: () => Promise<PaymentStore>) {
  // two calls, one transaction
  const s1 = await store();
  const a = makeService(s1);
  const b = body(NETWORKS.rhcTestnet);
  const r1 = await a.svc.settle(b);
  const r2 = await a.svc.settle(b);
  expect(r1.status).toBe(200);
  expect(r1.body.success).toBe(true);
  expect(r2.body).toMatchObject({ success: true, transaction: HASH, network: NETWORKS.rhcTestnet, amount: "10000" });
  expect(a.calls.sends).toBe(1);
  expect((await s1.get(paymentKey(b.paymentPayload)))?.status).toBe("settled");
  // key order in the JSON does not create a second payment
  const reordered = JSON.parse(JSON.stringify({ paymentRequirements: b.paymentRequirements, paymentPayload: b.paymentPayload, x402Version: 2 }));
  await a.svc.settle(reordered);
  expect(a.calls.sends).toBe(1);

  // 20 concurrent calls, one transaction
  const s2 = await store();
  const c = makeService(s2, { slowMs: 20 });
  const b2 = body(NETWORKS.rhcTestnet, "02");
  const rs = await Promise.all(Array.from({ length: 20 }, () => c.svc.settle(b2)));
  expect(c.calls.sends).toBe(1);
  expect(rs.filter((r) => r.body.success).length).toBeGreaterThanOrEqual(1);
  expect(rs.every((r) => r.body.success || r.body.errorReason === ERR.pending)).toBe(true);

  // crash after broadcast: the row is settlement_pending with the hash; nothing is resent
  const s3 = await store();
  let mined: "success" | null = null;
  const d = makeService(s3, { crash: true, probe: { receipt: async () => mined, known: async () => true } });
  const b3 = body(NETWORKS.rhcTestnet, "03");
  const r3 = await d.svc.settle(b3);
  expect(r3.status).toBe(202);
  expect(r3.body).toMatchObject({ success: false, errorReason: ERR.pending, transaction: HASH });
  const row = await s3.get(paymentKey(b3.paymentPayload));
  expect(row).toMatchObject({ status: "settlement_pending", txHash: HASH });
  // a retry before the chain confirms: still pending, no second broadcast
  expect((await d.svc.settle(b3)).body.errorReason).toBe(ERR.pending);
  expect(d.calls.sends).toBe(1);
  // the reconciler confirms it by hash
  mined = "success";
  expect(await d.svc.reconcile()).toEqual({ checked: 1, settled: 1, failed: 0, dropped: 0 });
  expect((await s3.get(paymentKey(b3.paymentPayload)))?.status).toBe("settled");
  const r4 = await d.svc.settle(b3);
  expect(r4.body).toMatchObject({ success: true, transaction: HASH });
  expect(d.calls.sends).toBe(1);
}

describe("facilitator service (memory store)", () => {
  test("idempotent-settle", async () => {
    await idempotencySuite(async () => memoryPaymentStore());
  });

  test("dropped tx is re-claimable only after the reconciler saw nothing on chain", async () => {
    const store = memoryPaymentStore();
    let t = 1_000_000;
    const tracker = broadcastTracker();
    const { f, calls } = stubFacilitator(tracker, { crashAfterBroadcast: true });
    const svc = createFacilitatorService({
      facilitator: f as never,
      store,
      tracker,
      probes: { [NETWORKS.rhcTestnet]: { receipt: async () => null, known: async () => false } },
      log: quiet,
      alert: () => {},
      isArmed: () => false,
      now: () => t,
    });
    const b = body(NETWORKS.rhcTestnet, "04");
    await svc.settle(b);
    expect((await svc.reconcile()).dropped).toBe(0); // too early
    t += 11 * 60 * 1000;
    expect((await svc.reconcile()).dropped).toBe(1);
    await svc.settle(b); // re-claimed: a new attempt is allowed (the authorization nonce still prevents a double charge)
    expect(calls.sends).toBe(2);
  });

  test("verify-no-writes", async () => {
    const store = memoryPaymentStore();
    const { svc, calls } = makeService(store);
    const r = await svc.verify(body(NETWORKS.rhcTestnet));
    expect(r.body.isValid).toBe(true);
    expect(await svc.verify(body(NETWORKS.rhc))).toMatchObject({ status: 200 }); // verify is never gated by arming
    expect(calls.verify).toBe(2);
    expect(store.writes).toBe(0);
    expect(store.rows.size).toBe(0);
    // amount 0 refused at verify and settle
    expect((await svc.verify(body(NETWORKS.rhcTestnet, "05", "0"))).body).toEqual({ isValid: false, invalidReason: ERR.zeroAmount });
    expect((await svc.settle(body(NETWORKS.rhcTestnet, "05", "0"))).body.errorReason).toBe(ERR.zeroAmount);
    expect(store.writes).toBe(0);
  });

  test("mainnet-needs-arming", async () => {
    for (const n of [NETWORKS.rhc, NETWORKS.base, NETWORKS.solana]) {
      const store = memoryPaymentStore();
      const { svc, calls } = makeService(store, { armed: false });
      const r = await svc.settle(body(n, "06"));
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ success: false, errorReason: ERR.notArmed, transaction: "" });
      expect(calls.settle).toBe(0);
      expect(store.writes).toBe(0);
    }
    // testnets are not gated; armed mainnet proceeds
    expect((await makeService(memoryPaymentStore()).svc.settle(body(NETWORKS.baseSepolia, "07"))).status).toBe(200);
    expect((await makeService(memoryPaymentStore(), { armed: true }).svc.settle(body(NETWORKS.rhc, "08"))).status).toBe(200);

    // settleArmed needs all three: the flag, an existing file and CAPSTAN_NETWORK=mainnet
    const dir = mkdtempSync(join(tmpdir(), "capstan-arm-"));
    const file = join(dir, "armed");
    try {
      expect(settleArmed({})).toBe(false);
      expect(settleArmed({ X402_SETTLE_ARMED: "1", X402_SETTLE_ARMED_FILE: file, CAPSTAN_NETWORK: "mainnet" })).toBe(false); // file missing
      writeFileSync(file, "armed\n");
      expect(settleArmed({ X402_SETTLE_ARMED: "1", X402_SETTLE_ARMED_FILE: file, CAPSTAN_NETWORK: "mainnet" })).toBe(true);
      expect(settleArmed({ X402_SETTLE_ARMED: "0", X402_SETTLE_ARMED_FILE: file, CAPSTAN_NETWORK: "mainnet" })).toBe(false);
      expect(settleArmed({ X402_SETTLE_ARMED: "1", X402_SETTLE_ARMED_FILE: file, CAPSTAN_NETWORK: "testnet" })).toBe(false);
      expect(settleArmed({ X402_SETTLE_ARMED: "1", CAPSTAN_NETWORK: "mainnet" })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // .env.example leaves both unset
    const example = await Bun.file(join(import.meta.dir, "../../../.env.example")).text();
    expect(example).not.toMatch(/^X402_SETTLE_ARMED=1/m);
    expect(example).not.toMatch(/^X402_SETTLE_ARMED_FILE=./m);
  });

  test("http status codes", async () => {
    const { svc } = makeService(memoryPaymentStore());
    const app = createFacilitatorApp(svc);
    const post = (p: string, b: unknown) => app.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: typeof b === "string" ? b : JSON.stringify(b) });
    expect((await post("/settle", "not json")).status).toBe(400);
    expect((await post("/verify", { x402Version: 1 })).status).toBe(400);
    expect((await post("/settle", body(NETWORKS.rhc, "09"))).status).toBe(403);
    expect((await post("/verify", body(NETWORKS.rhcTestnet, "0a"))).status).toBe(200);
    expect((await post("/settle", body(NETWORKS.rhcTestnet, "0a"))).status).toBe(200);
    expect((await app.request("/supported")).status).toBe(200);
  });
});

(PG ? describe : describe.skip)("facilitator service (Postgres)", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_fac" });
    db = createDb(t.url, { max: 10 });
    drop = async () => {
      await closeDb(db);
      await t.drop();
    };
  }, 30_000);
  afterAll(async () => {
    await drop?.();
  }, 30_000);

  test("idempotent-settle (postgres)", async () => {
    await idempotencySuite(async () => pgPaymentStore(db));
    const rows = await db.select().from(schema.x402Payments);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.status === "settled" && r.method === "eip3009" && r.endpoint.endsWith("/v1/funding/forecast"))).toBe(true);
  }, 30_000);

  test("verify-no-writes (postgres)", async () => {
    const before = (await db.select().from(schema.x402Payments)).length;
    const { svc } = makeService(pgPaymentStore(db));
    await svc.verify(body(NETWORKS.rhcTestnet, "0b"));
    expect((await db.select().from(schema.x402Payments)).length).toBe(before);
  });
});
