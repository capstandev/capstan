// R8, R9: Aster userCommissions paging and zero-fee rows; the signed client and the VPS-only gate.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { logger, schema, type JobDeps } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { recoverDigestSigner, parseQuery, digestTrade } from "@capstan/signer-aster";
import type { VenueHttp } from "@capstan/venue-client";
import { eq } from "drizzle-orm";
import { wallet } from "../../../../packages/eligibility/test/helpers";
import { asterReconEnabled, reconcileAster, signedAsterBuilderReports, ASTER_COMMISSIONS_PATH, type AsterBuilderReports, type AsterCommissionRow } from "../../src/reconcile";
import { runReconciler } from "../../src/jobs/builder-reconciler.job";
import { collector, fakeCsv, fakeHl, PG, plant, type Planted } from "./helpers";

const DAY = "2026-11-04";
const T0 = Date.parse(`${DAY}T00:00:00Z`);
const ASTER_BUILDER = "0x00000000000000000000000000000000000000ab" as Hex;
const OWNER = "0x00000000000000000000000000000000000000cd" as Hex;

function pages(rows: AsterCommissionRow[], size = 1000) {
  const calls: { start: number; end: number; page: number; limit: number }[] = [];
  const reports: AsterBuilderReports = {
    builder: ASTER_BUILDER,
    async userCommissions(start, end, page, limit) {
      calls.push({ start, end, page, limit });
      const slice = rows.slice((page - 1) * size, page * size);
      return { rows: slice, hasMore: page * size < rows.length };
    },
  };
  return { reports, calls };
}

const row = (i: number, over: Partial<AsterCommissionRow> = {}): AsterCommissionRow => ({ tradeId: 500000 + i, insertTime: T0 + 1000 + i, orderId: 600000 + i, symbol: "BTCUSDT", feeAsset: "USDT", marginAsset: "USDT", builderFee: "0.01", userAddress: OWNER, ...over });

describe.skipIf(!PG)("aster reconciliation", () => {
  let p: Planted;
  beforeAll(async () => {
    p = await plant("aster", { ms: T0 });
  });
  afterAll(() => p?.drop());

  test("paging-and-zero-fee", async () => {
    // 25 rows over 3 pages (the fake answers 10 a page): ours with receipts, one liquidation row (fee "0", no receipt), one fee row with no receipt
    const rows = Array.from({ length: 23 }, (_, i) => row(i));
    rows.push(row(9001, { builderFee: "0", orderId: 999001 })); // liquidation / ADL: no fee, not ours
    rows.push(row(9002, { orderId: 999002, builderFee: "0.25" })); // fee but no receipt
    for (const r of rows.slice(0, 23)) await p.claim({ owner: OWNER, venue: "aster", marketId: "aster:-:BTCUSDT", oid: String(r.orderId), at: T0 + 10 });
    const { reports, calls } = pages(rows, 10);
    const al = collector();
    const rep = await reconcileAster(DAY, { db: p.db, builderReports: reports, publish: al.publish, now: () => new Date(T0 + 26 * 3600_000) });
    expect(calls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(calls.every((c) => c.limit === 1000 && c.start === T0 && c.end === T0 + 86_400_000 - 1)).toBe(true);
    expect(rep.fills).toBe(25); // the zero-fee row counts as a fill
    expect(rep.unmatchedFills).toEqual(["aster:509002"]);
    expect(al.events).toHaveLength(1);
    expect(al.events[0]).toMatchObject({ kind: "reconciler.mismatch", detail: { venue: "aster", reason: "fill_without_receipt", unmatchedFills: 1 } });
    expect(Number(rep.feeUsd)).toBeCloseTo(23 * 0.01 + 0.25, 9);
    const zero = await p.db.select().from(schema.fills).where(eq(schema.fills.id, "aster:509001"));
    expect(zero[0]).toMatchObject({ builderFeeUsd: "0", venue: "aster" });
    // the 90-day window
    await expect(reconcileAster(DAY, { db: p.db, builderReports: reports, now: () => new Date(T0 + 91 * 86_400_000) })).rejects.toThrow("90-day window");
  });

  test("signed client: Mode B query by the builder's agent", async () => {
    const agent = wallet("recon-aster-agent"); // a label-derived test wallet (packages/eligibility/test/helpers)
    const sent: string[] = [];
    const http = {
      async request(method: string, path: string) {
        sent.push(`${method} ${path}`);
        return { httpStatus: 200, headers: new Headers(), text: "", body: { rows: [row(1)], hasMore: false } };
      },
    } as unknown as VenueHttp;
    let n = 1_793_000_000_000_000n;
    const r = signedAsterBuilderReports({ http, network: "Mainnet", builder: ASTER_BUILDER, agent: agent.address, sign: (d) => agent.sign({ hash: d }), nonce: () => n++ });
    const page = await r.userCommissions(T0, T0 + 86_399_999, 2, 1000);
    expect(page).toEqual({ rows: [row(1)], hasMore: false });
    const [method, url] = sent[0]!.split(" ");
    expect(method).toBe("GET");
    expect(url!.startsWith(`${ASTER_COMMISSIONS_PATH}?`)).toBe(true);
    const qs = url!.slice(ASTER_COMMISSIONS_PATH.length + 1);
    const [query, sig] = qs.split("&signature=");
    expect(Object.fromEntries(parseQuery(query!))).toMatchObject({ startTime: String(T0), endTime: String(T0 + 86_399_999), page: "2", limit: "1000", asterChain: "Mainnet", user: ASTER_BUILDER, signer: agent.address });
    expect((await recoverDigestSigner(digestTrade(query!, 1666), sig as Hex))?.toLowerCase()).toBe(agent.address.toLowerCase());
  });

  test("vps-only", async () => {
    expect(asterReconEnabled({})).toMatchObject({ ok: false, reason: expect.stringContaining("only on the VPS") });
    expect(asterReconEnabled({ CAPSTAN_RUNNER: "vps" })).toMatchObject({ ok: false, reason: "ASTER_BUILDER_ADDRESS is not set" });
    expect(asterReconEnabled({ CAPSTAN_RUNNER: "vps", ASTER_BUILDER_ADDRESS: ASTER_BUILDER, ASTER_BUILDER_AGENT_ADDRESS: OWNER, ASTER_BUILDER_AGENT_KEYSTORE: "/k", ASTER_BUILDER_AGENT_PASSWORD_FILE: "/p" })).toEqual({ ok: true });
    // on this Mac the job skips Aster cleanly and the Hyperliquid part still runs
    const hlCalls = fakeHl({});
    await p.order({ owner: OWNER, oid: "123456", status: "open", at: T0 + 5 });
    const deps: JobDeps = { db: p.db, redis: null, cache: null, log: logger("t", { sink: () => {} }), now: () => new Date(`2026-11-05T02:00:00Z`) };
    const env = { HL_BUILDER_ADDRESS: "0x1924b8561eef20e70ede628a296175d358be80e5" };
    const out = await runReconciler(deps, env, { hl: hlCalls.hl, csv: fakeCsv({}).csv });
    expect(out.day).toBe(DAY);
    expect(out.aster).toEqual({ skipped: "aster builder reads run only on the VPS (CAPSTAN_RUNNER=vps)" });
    expect("fills" in out.hyperliquid).toBe(true);
    expect(hlCalls.calls.map((c) => c.owner)).toContain(OWNER);
    // without the HL builder address the HL part is skipped too, and nothing throws
    const none = await runReconciler(deps, {}, { hl: hlCalls.hl, csv: fakeCsv({}).csv });
    expect(none.hyperliquid).toEqual({ skipped: "HL_BUILDER_ADDRESS is not set" });
  });

  test.skipIf(process.env.CAPSTAN_RUNNER !== "vps" || !process.env.ASTER_BUILDER_AGENT_KEYSTORE)("vps: one real userCommissions page (BACKLOG C46)", async () => {
    const out = await runReconciler({ db: p.db, redis: null, cache: null, log: logger("t"), now: () => new Date() });
    expect("fills" in out.aster).toBe(true);
  });
});
