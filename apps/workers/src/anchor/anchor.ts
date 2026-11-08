// Hourly anchoring (todo 28, spec 11): build the sorted-pair tree of an hour's receipt leaves and post its root to
// CapstanReceiptAnchor with the poster key. Every step checks the chain first, so a re-run is safe:
//   - empty hour: nothing is posted (hours only need to increase, gaps are fine)
//   - root already on chain and equal: recorded, no transaction ('already_posted')
//   - root on chain and different, or a later hour already on chain: the hour is frozen ('mismatch'), a critical
//     ops alert is raised, and it is never posted again
//   - any send or RPC failure: 'failed', the nonce manager resyncs, and the backlog stops so no hour is ever skipped
// The poster key's only power is posting roots; it holds gas only.
import { schema, type Db, type Logger, type ServiceSigner } from "@capstan/core";
import { buildTree, pgReceiptStore } from "@capstan/receipts";
import type { Hex } from "@capstan/schema";
import { and, eq, gt, lte, max, min, sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import { encodeFunctionData, type PublicClient } from "viem";
import { ANCHOR_ABI, RHC_MAINNET, ZERO32 } from "./abi";
import type { NonceManager } from "./nonce";

export const OPS_ALERT_CHANNEL = "ops.alert";
/** KEEP-3: at most this many hours are anchored per run. */
export const MAX_HOURS_PER_RUN = 24;

export type AnchorStatus = "posted" | "already_posted" | "empty" | "mismatch" | "failed";

export type AnchorRpc = Pick<
  PublicClient,
  "getChainId" | "readContract" | "estimateGas" | "getBlock" | "getBalance" | "sendRawTransaction" | "waitForTransactionReceipt"
>;

export interface AnchorDeps {
  db: Db;
  rpc: AnchorRpc;
  signer: ServiceSigner;
  anchor: Hex;
  chainId: number;
  nonces: Pick<NonceManager, "next" | "confirm" | "resync">;
  log: Logger;
  now: () => Date;
  publish?: (channel: string, payload: unknown) => Promise<void>;
  /** ANCHOR_ARMED */
  armed: boolean;
  /** ANCHOR_ARMED_FILE: on 4663 it must exist as well */
  armedFile?: string;
  /** ANCHOR_MIN_BALANCE_WEI: below it an ops alert is raised (posting continues while funds remain) */
  minBalanceWei: bigint;
  receiptTimeoutMs?: number;
  /** how often to poll for the receipt (RHC makes about 10 blocks a second) */
  pollingIntervalMs?: number;
}

export class AnchorRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorRefused";
  }
}

async function alert(deps: Pick<AnchorDeps, "publish" | "log">, a: { kind: string; severity: "critical" | "warning"; detail: unknown }): Promise<void> {
  if (deps.publish) await deps.publish(OPS_ALERT_CHANNEL, a);
  else deps.log.warn("ops alert", a);
}

/** R14: a transaction on Robinhood Chain mainnet needs ANCHOR_ARMED=1 and the armed file to exist. */
export function assertMayBroadcast(chainId: number, armed: boolean, armedFile: string | undefined): void {
  if (chainId !== RHC_MAINNET) return;
  if (!armed) throw new AnchorRefused("anchor: chain 4663 needs ANCHOR_ARMED=1");
  if (!armedFile || !existsSync(armedFile)) throw new AnchorRefused("anchor: chain 4663 needs the ANCHOR_ARMED_FILE to exist");
}

/** R12: the poster key must be the contract's immutable poster(), or the job refuses to start. */
export async function assertPosterMatches(rpc: Pick<PublicClient, "readContract">, anchor: Hex, poster: Hex): Promise<void> {
  const onchain = (await rpc.readContract({ address: anchor, abi: ANCHOR_ABI, functionName: "poster" })) as Hex;
  if (onchain.toLowerCase() !== poster.toLowerCase()) throw new AnchorRefused(`anchor: signer ${poster} is not the contract poster ${onchain}`);
}

async function recordRoot(db: Db, row: { hourEpoch: number; root: Hex; leafCount: number; txHash: Hex | null; status: "posted" | "mismatch"; onchainRoot?: Hex | null; postedAt?: Date | null }): Promise<void> {
  const t = schema.receiptRoots;
  const v = { root: row.root, leafCount: row.leafCount, txHash: row.txHash, status: row.status, onchainRoot: row.onchainRoot ?? null, postedAt: row.postedAt ?? null };
  await db.insert(t).values({ hourEpoch: row.hourEpoch, ...v }).onConflictDoUpdate({ target: t.hourEpoch, set: v });
}

/** Anchor one hour. */
export async function anchorHour(hourEpoch: number, deps: AnchorDeps): Promise<{ status: AnchorStatus; txHash?: Hex }> {
  assertMayBroadcast(deps.chainId, deps.armed, deps.armedFile);
  const cid = await deps.rpc.getChainId();
  if (cid !== deps.chainId) throw new AnchorRefused(`anchor: RPC chain id ${cid} differs from ANCHOR_CHAIN_ID ${deps.chainId}`);

  const t = schema.receiptRoots;
  const prior = (await deps.db.select().from(t).where(eq(t.hourEpoch, hourEpoch)).limit(1))[0];
  if (prior?.status === "mismatch") return { status: "mismatch" };

  const leaves = await pgReceiptStore(deps.db).byHour(hourEpoch);
  if (!leaves.length) return { status: "empty" };
  const tree = buildTree(leaves.map((l) => l.leaf));
  const root = tree.root;
  const count = leaves.length;

  const [onRoot, onCount] = (await deps.rpc.readContract({ address: deps.anchor, abi: ANCHOR_ABI, functionName: "rootOf", args: [BigInt(hourEpoch)] })) as readonly [Hex, number, bigint];
  if (onRoot !== ZERO32) {
    if (onRoot.toLowerCase() === root.toLowerCase() && Number(onCount) === count) {
      await recordRoot(deps.db, { hourEpoch, root, leafCount: count, txHash: (prior?.txHash as Hex | undefined) ?? null, status: "posted", postedAt: prior?.postedAt ?? deps.now() });
      return { status: "already_posted" };
    }
    await recordRoot(deps.db, { hourEpoch, root, leafCount: count, txHash: null, status: "mismatch", onchainRoot: onRoot });
    await alert(deps, { kind: "anchor.root_mismatch", severity: "critical", detail: { hourEpoch, db: root, onchain: onRoot, dbCount: count, onchainCount: Number(onCount) } });
    return { status: "mismatch" };
  }
  const latest = Number(await deps.rpc.readContract({ address: deps.anchor, abi: ANCHOR_ABI, functionName: "latestHour" }));
  const root0 = (await deps.rpc.readContract({ address: deps.anchor, abi: ANCHOR_ABI, functionName: "rootOf", args: [0n] })) as readonly [Hex, number, bigint];
  const anyPosted = latest > 0 || root0[0] !== ZERO32;
  if (anyPosted && latest >= hourEpoch) {
    // a later hour is already on chain: this hour can never be posted (roots strictly increase)
    await recordRoot(deps.db, { hourEpoch, root, leafCount: count, txHash: null, status: "mismatch", onchainRoot: null });
    await alert(deps, { kind: "anchor.hour_unpostable", severity: "critical", detail: { hourEpoch, latestOnChain: latest } });
    return { status: "mismatch" };
  }

  const balance = await deps.rpc.getBalance({ address: deps.signer.address });
  if (balance < deps.minBalanceWei) {
    await alert(deps, { kind: "anchor.poster_low_balance", severity: "warning", detail: { poster: deps.signer.address, balanceWei: balance.toString(), minWei: deps.minBalanceWei.toString() } });
  }

  if (!deps.signer.signTransaction) throw new AnchorRefused("anchor: the poster signer cannot sign transactions");
  let nonce: number | null = null;
  try {
    const data = encodeFunctionData({ abi: ANCHOR_ABI, functionName: "postRoot", args: [BigInt(hourEpoch), root, count] });
    const gas = await deps.rpc.estimateGas({ account: deps.signer.address, to: deps.anchor, data });
    const block = await deps.rpc.getBlock();
    const base = block.baseFeePerGas ?? 0n;
    const maxPriorityFeePerGas = 0n;
    const maxFeePerGas = base * 2n + 1n;
    nonce = await deps.nonces.next();
    const raw = await deps.signer.signTransaction({ chainId: deps.chainId, to: deps.anchor, data, nonce, gas: (gas * 12n) / 10n, maxFeePerGas, maxPriorityFeePerGas });
    const hash = await deps.rpc.sendRawTransaction({ serializedTransaction: raw });
    const rc = await deps.rpc.waitForTransactionReceipt({ hash, confirmations: 1, timeout: deps.receiptTimeoutMs ?? 120_000, pollingInterval: deps.pollingIntervalMs ?? 1000 });
    if (rc.status !== "success") throw new Error(`postRoot reverted (${hash})`);
    await deps.nonces.confirm(nonce);
    await recordRoot(deps.db, { hourEpoch, root, leafCount: count, txHash: hash, status: "posted", postedAt: deps.now() });
    deps.log.info("anchor posted", { hourEpoch, leafCount: count, txHash: hash });
    return { status: "posted", txHash: hash };
  } catch (e) {
    await deps.nonces.resync();
    deps.log.error("anchor post failed", { hourEpoch, nonce, error: (e as Error).message });
    // r1:6 F10: a failed send is paged, never only logged (the ops-alerts worker dedupes per cause)
    await alert(deps, { kind: "anchor.post_failed", severity: "critical", detail: { hourEpoch, error: (e as Error).message } }).catch(() => undefined);
    return { status: "failed" };
  }
}

/**
 * The hourly run (cron :05 UTC): every non-empty hour after the last recorded one, up to the hour that just ended,
 * in order, at most MAX_HOURS_PER_RUN. Stops at the first failure so a later hour never jumps over an unposted one.
 */
export async function anchorBacklog(deps: AnchorDeps): Promise<{ hourEpoch: number; status: AnchorStatus; txHash?: Hex }[]> {
  const ended = Math.floor(deps.now().getTime() / 3_600_000) - 1;
  const last = (await deps.db.select({ h: max(schema.receiptRoots.hourEpoch) }).from(schema.receiptRoots))[0]?.h ?? null;
  const r = schema.receipts;
  const cond = last === null ? lte(r.hourEpoch, ended) : and(gt(r.hourEpoch, Number(last)), lte(r.hourEpoch, ended));
  const hours = await deps.db
    .selectDistinct({ h: r.hourEpoch })
    .from(r)
    .where(cond)
    .orderBy(sql`${r.hourEpoch} asc`)
    .limit(MAX_HOURS_PER_RUN);
  const out: { hourEpoch: number; status: AnchorStatus; txHash?: Hex }[] = [];
  for (const { h } of hours) {
    let res: { status: AnchorStatus; txHash?: Hex };
    try {
      res = await anchorHour(h, deps);
    } catch (e) {
      // an RPC or chain-id error before the send (r1:6 F10): page it, then let the job fail as before
      if (!(e instanceof AnchorRefused)) await alert(deps, { kind: "anchor.post_failed", severity: "critical", detail: { hourEpoch: h, error: (e as Error).message } }).catch(() => undefined);
      throw e;
    }
    out.push({ hourEpoch: h, ...res });
    if (res.status === "failed") break;
  }
  return out;
}

/** Hours of delay before anchoring counts as behind: two missed hourly runs (r1:6 F10). */
export const ANCHOR_LAG_HOURS = 2;

/**
 * How far anchoring is behind, from the database alone (so it works while the RPC is down): the oldest non-empty
 * ended hour after the last recorded root. Null while it is fewer than ANCHOR_LAG_HOURS hours behind.
 */
export async function anchorLag(db: Db, now: Date): Promise<{ oldestUnanchored: number; latestRecorded: number | null; hoursBehind: number } | null> {
  const ended = Math.floor(now.getTime() / 3_600_000) - 1;
  const lastRaw = (await db.select({ h: max(schema.receiptRoots.hourEpoch) }).from(schema.receiptRoots))[0]?.h ?? null;
  const last = lastRaw === null ? null : Number(lastRaw);
  const r = schema.receipts;
  const cond = last === null ? lte(r.hourEpoch, ended) : and(gt(r.hourEpoch, last), lte(r.hourEpoch, ended));
  const oldest = (await db.select({ h: min(r.hourEpoch) }).from(r).where(cond))[0]?.h ?? null;
  if (oldest === null) return null;
  const hoursBehind = ended - Number(oldest);
  return hoursBehind >= ANCHOR_LAG_HOURS ? { oldestUnanchored: Number(oldest), latestRecorded: last, hoursBehind } : null;
}
