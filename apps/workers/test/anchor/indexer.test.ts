// R9: chunked getLogs (2,000 blocks) with backoff, survives a 429, idempotent. R10: events become final only after
// the reorg depth, a reorged-away event is deleted, and a log delivered with removed: true is deleted.
import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@capstan/core";
import { eq } from "drizzle-orm";
import { keccak256, toHex, type PublicClient } from "viem";
import { postRootDirect } from "../../../../packages/receipts/test/anvil";
import { indexRoots, type IndexerRpc } from "../../src/anchor";
import { ANVIL, fixture, pastHour, PG, T, type Fixture } from "./fixture";

const run = PG && ANVIL ? describe : describe.skip;
let fx: Fixture | null = null;
afterEach(async () => {
  await fx?.drop();
  fx = null;
}, T);

const mine = (rpc: PublicClient, n: number) => rpc.request({ method: "anvil_mine" as never, params: [toHex(n)] as never });

/** Wraps the real client: records every getLogs range and can fail the first calls with a 429. */
function spy(rpc: PublicClient, opts: { fail429?: number; extraLogs?: (l: unknown[]) => unknown[]; noSafeTag?: boolean } = {}) {
  const ranges: [bigint, bigint][] = [];
  let fails = opts.fail429 ?? 0;
  const wrapped: IndexerRpc = {
    getBlockNumber: rpc.getBlockNumber,
    getBlock: (async (a?: { blockTag?: string }) => {
      if (opts.noSafeTag && a?.blockTag === "safe") throw new Error("unknown block tag");
      return rpc.getBlock(a as never);
    }) as unknown as IndexerRpc["getBlock"],
    getLogs: (async (args: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([args.fromBlock, args.toBlock]);
      if (fails > 0) {
        fails--;
        throw Object.assign(new Error("HTTP request failed. Status: 429"), { status: 429 });
      }
      const logs = await rpc.getLogs(args as never);
      return opts.extraLogs ? opts.extraLogs(logs as unknown[]) : logs;
    }) as IndexerRpc["getLogs"],
  };
  return { rpc: wrapped, ranges };
}

run("root indexer", () => {
  test(
    "chunked-idempotent",
    async () => {
      fx = await fixture("indexer");
      const h = pastHour(30);
      await fx.db.insert(schema.receiptRoots).values({ hourEpoch: h, root: keccak256(toHex("r0")), leafCount: 1, status: "posted" });
      await postRootDirect(fx.rpc, fx.poster, fx.anchor, h, keccak256(toHex("r0")), 1);
      await mine(fx.rpc, 4500);
      await postRootDirect(fx.rpc, fx.poster, fx.anchor, h + 1, keccak256(toHex("r1")), 2);
      await mine(fx.rpc, 30);
      const s = spy(fx.rpc, { fail429: 2 });
      const slept: number[] = [];
      const r = await indexRoots(fx.deployBlock, { rpc: s.rpc, db: fx.db, anchor: fx.anchor, maxRange: 2000, sleep: async (ms) => void slept.push(ms) });
      expect(r.found).toBe(2);
      expect(slept).toEqual([500, 1000]); // backoff on the two 429s, then success
      for (const [a, b] of s.ranges) expect(b - a + 1n <= 2000n).toBe(true);
      expect(s.ranges.length).toBeGreaterThanOrEqual(3 + 2); // 4,500+ blocks need 3 chunks, plus the 2 retries
      const rows = await fx.db.select().from(schema.rootEvents);
      expect(rows.length).toBe(2);
      expect(rows.find((x) => x.hourEpoch === h)!.matches).toBe(true);
      expect(rows.find((x) => x.hourEpoch === h + 1)!.matches).toBeNull(); // no DB root for that hour
      expect(rows.find((x) => x.hourEpoch === h + 1)!.prevRoot).toBe(keccak256(toHex("r0")));
      // a second run reads only from the cursor (minus the unfinal window) and changes nothing
      const again = spy(fx.rpc);
      await indexRoots(fx.deployBlock, { rpc: again.rpc, db: fx.db, anchor: fx.anchor, maxRange: 2000 });
      expect((await fx.db.select().from(schema.rootEvents)).length).toBe(2);
      expect(again.ranges.length).toBe(1);
      // an on-chain root that differs from the DB root raises a critical alert
      const alerts: unknown[] = [];
      await fx.db.update(schema.receiptRoots).set({ root: keccak256(toHex("different")) }).where(eq(schema.receiptRoots.hourEpoch, h));
      await fx.db.update(schema.rootEvents).set({ final: false }).where(eq(schema.rootEvents.hourEpoch, h));
      await indexRoots(fx.deployBlock, { rpc: fx.rpc, db: fx.db, anchor: fx.anchor, maxRange: 2000, publish: async (_c, p) => void alerts.push(p) });
      expect(alerts).toEqual([expect.objectContaining({ kind: "anchor.root_event_mismatch", severity: "critical" })]);
    },
    T,
  );

  test(
    "reorg",
    async () => {
      fx = await fixture("reorg");
      const h = pastHour(40);
      await postRootDirect(fx.rpc, fx.poster, fx.anchor, h, keccak256(toHex("a")), 1);
      const ev = async (hour: number) => (await fx!.db.select().from(schema.rootEvents).where(eq(schema.rootEvents.hourEpoch, hour)))[0];
      const evBlock = BigInt((await indexRoots(fx.deployBlock, { rpc: fx.rpc, db: fx.db, anchor: fx.anchor, maxRange: 2000, reorgDepth: 20 })).to);
      expect((await ev(h))!.final).toBe(false);
      // a node without a safe tag: the depth decides, final exactly 20 blocks deep
      const noSafe = spy(fx.rpc, { noSafeTag: true });
      await mine(fx.rpc, 19);
      await indexRoots(fx.deployBlock, { rpc: noSafe.rpc, db: fx.db, anchor: fx.anchor, maxRange: 2000, reorgDepth: 20 });
      expect((await ev(h))!.final).toBe(false);
      await mine(fx.rpc, 1);
      await indexRoots(fx.deployBlock, { rpc: noSafe.rpc, db: fx.db, anchor: fx.anchor, maxRange: 2000, reorgDepth: 20 });
      expect((await ev(h))!.final).toBe(true);
      expect((await fx.rpc.getBlockNumber()) - evBlock).toBe(20n);
      // with a safe tag (anvil: latest - 32; RHC: about 6,800 blocks behind) finality waits for the safe block
      await fx.db.update(schema.rootEvents).set({ final: false }).where(eq(schema.rootEvents.hourEpoch, h));
      await indexRoots(fx.deployBlock, { rpc: fx.rpc, db: fx.db, anchor: fx.anchor, maxRange: 2000, reorgDepth: 20 });
      expect((await ev(h))!.final).toBe(false);
      await mine(fx.rpc, 12);
      await indexRoots(fx.deployBlock, { rpc: fx.rpc, db: fx.db, anchor: fx.anchor, maxRange: 2000, reorgDepth: 20 });
      expect((await ev(h))!.final).toBe(true);

      // a reorg: the block holding the h+1 event disappears (anvil snapshot and revert), the chain moves on
      const snap = await fx.rpc.request({ method: "evm_snapshot" as never, params: [] as never });
      await postRootDirect(fx.rpc, fx.poster, fx.anchor, h + 1, keccak256(toHex("b")), 1);
      await indexRoots(fx.deployBlock, { rpc: fx.rpc, db: fx.db, anchor: fx.anchor, maxRange: 2000, reorgDepth: 20 });
      expect((await ev(h + 1))!.final).toBe(false);
      await fx.rpc.request({ method: "evm_revert" as never, params: [snap] as never });
      await mine(fx.rpc, 3);
      await indexRoots(fx.deployBlock, { rpc: fx.rpc, db: fx.db, anchor: fx.anchor, maxRange: 2000, reorgDepth: 20 });
      expect(await ev(h + 1)).toBeUndefined();
      expect((await ev(h))!.final).toBe(true); // final events are kept

      // a log delivered with removed: true is deleted
      await postRootDirect(fx.rpc, fx.poster, fx.anchor, h + 2, keccak256(toHex("c")), 1);
      await indexRoots(fx.deployBlock, { rpc: fx.rpc, db: fx.db, anchor: fx.anchor, maxRange: 2000, reorgDepth: 20 });
      expect(await ev(h + 2)).toBeDefined();
      const s = spy(fx.rpc, { extraLogs: (logs) => logs.map((l) => ({ ...(l as object), removed: (l as { args: { hourEpoch: bigint } }).args.hourEpoch === BigInt(h + 2) })) });
      await indexRoots(fx.deployBlock, { rpc: s.rpc, db: fx.db, anchor: fx.anchor, maxRange: 2000, reorgDepth: 20 });
      expect(await ev(h + 2)).toBeUndefined();
    },
    T,
  );
});
