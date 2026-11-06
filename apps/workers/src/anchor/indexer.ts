// RootPosted indexer (todo 28): reads the anchor's RootPosted logs with chunked getLogs (2,000 blocks per call,
// backoff on 429) from the deployment block and keeps `root_events` equal to the chain. The public RHC RPC keeps only
// about 10 minutes of state, but getLogs over old ranges works, so history comes from logs plus our own DB.
// Finality: an event is final once its block is at or below min(the chain's `safe` block, head - reorgDepth). On RHC
// the safe block (last batch posted to the parent chain) trails latest by about 6,800 blocks, about 11.6 minutes
// (measured 2026-11-06); 20 blocks alone is only about 2 seconds there. Everything above the final block is rescanned
// each run, so an event that a reorg removed disappears, and a log delivered with removed: true is deleted.
import { schema, type Db, type Logger } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { and, eq, gte, lte, min } from "drizzle-orm";
import type { PublicClient } from "viem";
import { ROOT_POSTED } from "./abi";
import { OPS_ALERT_CHANNEL } from "./anchor";

export const DEFAULT_REORG_DEPTH = 20;

export type IndexerRpc = Pick<PublicClient, "getBlockNumber" | "getBlock" | "getLogs">;

export interface IndexDeps {
  rpc: IndexerRpc;
  db: Db;
  anchor: Hex;
  maxRange: number;
  reorgDepth?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  publish?: (channel: string, payload: unknown) => Promise<void>;
  log?: Logger;
}

const is429 = (e: unknown): boolean => {
  const x = e as { status?: number; cause?: { status?: number }; message?: string };
  return x?.status === 429 || x?.cause?.status === 429 || /\b429\b|rate.?limit|too many requests/i.test(x?.message ?? "");
};

async function withBackoff<T>(fn: () => Promise<T>, deps: IndexDeps): Promise<T> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const tries = deps.maxRetries ?? 6;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!is429(e) || i + 1 >= tries) throw e;
      await sleep(Math.min(30_000, 500 * 2 ** i));
    }
  }
}

export const cursorKey = (anchor: Hex): string => `root-indexer:${anchor.toLowerCase()}`;

export async function indexRoots(fromBlock: bigint, deps: IndexDeps): Promise<{ to: bigint; found: number }> {
  const depth = BigInt(deps.reorgDepth ?? DEFAULT_REORG_DEPTH);
  const head = await deps.rpc.getBlockNumber({ cacheTime: 0 });
  let safe = head;
  try {
    const b = await deps.rpc.getBlock({ blockTag: "safe" });
    if (b?.number !== null && b?.number !== undefined) safe = b.number;
  } catch {
    // no safe tag on this node: the depth alone decides
  }
  const byDepth = head > depth ? head - depth : 0n;
  const finalBlock = safe < byDepth ? safe : byDepth;

  const cur = schema.chainCursors;
  const key = cursorKey(deps.anchor);
  const row = (await deps.db.select().from(cur).where(eq(cur.key, key)).limit(1))[0];
  const scanned = row ? BigInt(row.block) : fromBlock - 1n;
  const ev = schema.rootEvents;
  // rescan from the lowest of: the first unscanned block, the first block above the final block, and the earliest
  // event not marked final yet (so it gets marked final, or deleted if the chain dropped it)
  const pendingFrom = (await deps.db.select({ b: min(ev.blockNumber) }).from(ev).where(eq(ev.final, false)))[0]?.b;
  let start = scanned + 1n < finalBlock + 1n ? scanned + 1n : finalBlock + 1n;
  if (pendingFrom !== null && pendingFrom !== undefined && BigInt(pendingFrom) < start) start = BigInt(pendingFrom);
  if (start < fromBlock) start = fromBlock;

  const roots = schema.receiptRoots;
  const seen = new Set<number>();
  let found = 0;
  const step = BigInt(deps.maxRange);
  for (let a = start; a <= head; a += step) {
    const b = a + step - 1n < head ? a + step - 1n : head;
    const logs = await withBackoff(() => deps.rpc.getLogs({ address: deps.anchor, event: ROOT_POSTED, fromBlock: a, toBlock: b }), deps);
    for (const l of logs) {
      const hour = Number(l.args.hourEpoch);
      if (l.removed) {
        await deps.db.delete(ev).where(and(eq(ev.hourEpoch, hour), eq(ev.txHash, l.transactionHash!)));
        continue;
      }
      found++;
      seen.add(hour);
      const ours = (await deps.db.select().from(roots).where(eq(roots.hourEpoch, hour)).limit(1))[0];
      const root = l.args.root as Hex;
      const matches = ours ? ours.root.toLowerCase() === root.toLowerCase() && ours.leafCount === Number(l.args.leafCount) : null;
      const v = {
        root,
        leafCount: Number(l.args.leafCount),
        prevRoot: l.args.prevRoot as Hex,
        txHash: l.transactionHash!,
        blockNumber: Number(l.blockNumber),
        logIndex: Number(l.logIndex),
        blockHash: l.blockHash,
        final: l.blockNumber! <= finalBlock,
        matches,
      };
      await deps.db.insert(ev).values({ hourEpoch: hour, ...v }).onConflictDoUpdate({ target: ev.hourEpoch, set: v });
      if (matches === false) {
        const a2 = { kind: "anchor.root_event_mismatch", severity: "critical", detail: { hourEpoch: hour, onchain: root, db: ours?.root } };
        if (deps.publish) await deps.publish(OPS_ALERT_CHANNEL, a2);
        else deps.log?.warn("ops alert", a2);
      }
    }
  }
  // a non-final event in the rescanned range that the chain no longer has was reorged away
  const stale = await deps.db
    .select({ h: ev.hourEpoch })
    .from(ev)
    .where(and(eq(ev.final, false), gte(ev.blockNumber, Number(start)), lte(ev.blockNumber, Number(head))));
  for (const s of stale) if (!seen.has(s.h)) await deps.db.delete(ev).where(and(eq(ev.hourEpoch, s.h), eq(ev.final, false)));

  const vals = { block: Number(head), updatedAt: new Date() };
  await deps.db.insert(cur).values({ key, ...vals }).onConflictDoUpdate({ target: cur.key, set: vals });
  return { to: head, found };
}
