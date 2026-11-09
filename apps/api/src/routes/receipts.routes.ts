// Receipts (spec 11, 13.1). GET /v1/receipts/{id} serves one receipt by id (ids are unguessable ulids); /proof gives
// the hour's Merkle proof once the root is anchored; /verify runs the full public check (signature, leaf, proof,
// on-chain root). Listing by owner (GET /v1/receipts?owner=) needs that owner's signature: receipts are public one by
// one, never enumerable by a stranger.
import { createDb, schema, type Db, type RouteSpec } from "@capstan/core";
import { buildTree, pgReceiptStore, proofFor, verifyFull, type SignerWindow } from "@capstan/receipts";
import { CHAINS, DEPLOYMENTS, errorBody, LOCAL_CHAIN_ID, type Hex, type Receipt } from "@capstan/schema";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Context } from "hono";

export interface ReceiptRouteDeps {
  get(id: string): Promise<Receipt | null>;
  /** The hour's proof. `anchored` false: the hour's root is not on chain yet, the root is this server's tree. */
  proof(id: string): Promise<{ hourEpoch: number; proof: Hex[]; root: Hex | null; anchored?: boolean }>;
  /** The anchored root for an hour from the CapstanReceiptAnchor contract, or null when not posted (or no chain). */
  readRoot?: (hourEpoch: number) => Promise<Hex | null>;
  /** The anchor's latestHour(): an empty hour at or below it is never anchored. */
  latestHour?: () => Promise<number | null>;
  now?: () => number;
  signers: Array<Hex | SignerWindow>;
  listByOwner(owner: Hex, before: string | null, limit: number): Promise<Receipt[]>;
}

const ID = /^[0-9A-Za-z_-]{1,64}$/;
const ctxGet = (c: Context, k: string): unknown => (c as unknown as { get(k: string): unknown }).get(k);

export function createReceiptRoutes(getDeps: () => Promise<ReceiptRouteDeps> | ReceiptRouteDeps): RouteSpec[] {
  type One = { ok: false; res: Response } | { ok: true; r: Receipt; deps: ReceiptRouteDeps };
  const one = async (c: Context): Promise<One> => {
    const id = c.req.param("id") ?? "";
    if (!ID.test(id)) return { ok: false, res: c.json(errorBody("INVALID_INPUT", "bad receipt id"), 400) };
    const deps = await getDeps();
    const r = await deps.get(id);
    if (!r) return { ok: false, res: c.json(errorBody("NOT_FOUND", "No receipt with this id."), 404) };
    return { ok: true, r, deps };
  };
  return [
    {
      method: "GET",
      path: "/receipts",
      auth: "owner_sig",
      description: "Your receipts, newest first (needs your signature)",
      async handler(c) {
        const owner = ctxGet(c, "owner");
        const q = c.req.query("owner");
        if (typeof owner !== "string" || !q || q.toLowerCase() !== owner.toLowerCase()) return c.json(errorBody("UNAUTHORIZED", "Listing receipts needs the owner's signature."), 401);
        const before = c.req.query("before") ?? null;
        if (before !== null && !ID.test(before)) return c.json(errorBody("INVALID_INPUT", "bad cursor"), 400);
        const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
        const list = await (await getDeps()).listByOwner(owner.toLowerCase() as Hex, before, limit);
        return c.json({ receipts: list, next: list.length === limit ? list.at(-1)!.receiptId : null });
      },
    },
    {
      method: "GET",
      path: "/receipts/:id",
      auth: "public",
      description: "One receipt by id",
      async handler(c) {
        const x = await one(c);
        return x.ok ? c.json(x.r) : x.res;
      },
    },
    {
      method: "GET",
      path: "/receipts/:id/proof",
      auth: "public",
      description: "Merkle proof of a receipt in its hourly anchored root",
      async handler(c) {
        const x = await one(c);
        if (!x.ok) return x.res;
        return c.json({ receiptId: x.r.receiptId, ...(await x.deps.proof(x.r.receiptId)) });
      },
    },
    {
      method: "GET",
      path: "/receipts/:id/verify",
      auth: "public",
      description: "Full check of a receipt: signature, leaf, proof and the on-chain root",
      async handler(c) {
        const x = await one(c);
        if (!x.ok) return x.res;
        const p = await x.deps.proof(x.r.receiptId);
        // never valid without the chain (security r1 F1): with no anchor reader every root reads as not posted, so a
        // receipt is at best "pending" and an old empty hour is "unanchored"
        const v = await verifyFull(x.r, { proof: p.proof, root: p.root, signers: x.deps.signers, readRoot: x.deps.readRoot ?? (async () => null), ...(x.deps.latestHour ? { latestHour: x.deps.latestHour } : {}), nowMs: (x.deps.now ?? Date.now)() });
        return c.json({ receiptId: x.r.receiptId, ...v });
      },
    },
  ];
}

/** How long the open (unanchored) hour's tree is reused, and how long an empty chain answer is kept. */
export const OPEN_HOUR_TREE_TTL_MS = 5_000;
export const EMPTY_ROOT_TTL_MS = 30_000;
const MAX_CACHED_HOURS = 16;
/** An anchored hour bigger than this is cached like the open hour (a few seconds), so memory stays bounded. */
const PIN_MAX_LEAVES = 200_000;
/**
 * All cached hour trees together hold at most this many leaves (security r1 F3 residual): the cache is bounded by
 * size, not only by hour count, so 16 big pinned hours cannot hold 3.2 M leaves.
 */
export const MAX_CACHED_LEAVES = 400_000;
/** Hour trees built at once: a caller rotating through many hours waits instead of fanning out database scans. */
export const MAX_TREE_BUILDS = 2;

interface HourTree {
  index: Map<string, number>;
  tree: ReturnType<typeof buildTree>;
  /** The posted root when it equals this tree; null when nothing is posted; "mismatch" when a posted root differs. */
  posted: Hex | null | "mismatch";
}

/**
 * A small LRU of promises with a per-entry expiry; concurrent callers share one load (single flight), a `fresh` call
 * included: it shares a load already in flight instead of starting another. Bounded by entry count and, with
 * `weigh`, by total weight (the newest entry always stays).
 */
export function lruCache<K, V>(max: number, o: { weigh?: (v: V) => number; maxWeight?: number } = {}) {
  type Entry = { until: number; p: Promise<V>; loading: boolean; weight: number };
  const m = new Map<K, Entry>();
  let weight = 0;
  const drop = (k: K) => {
    const e = m.get(k);
    if (e) weight -= e.weight;
    m.delete(k);
  };
  const evict = () => {
    while (m.size > 1 && (m.size > max || weight > (o.maxWeight ?? Number.POSITIVE_INFINITY))) drop(m.keys().next().value as K);
  };
  return async (k: K, now: number, load: () => Promise<{ value: V; ttlMs: number }>, fresh = false): Promise<V> => {
    const hit = m.get(k);
    if (hit && (hit.loading || (hit.until > now && !fresh))) {
      m.delete(k);
      m.set(k, hit);
      return hit.p;
    }
    if (hit) drop(k);
    const entry: Entry = { until: Number.POSITIVE_INFINITY, p: Promise.resolve(undefined as V), loading: true, weight: 0 };
    entry.p = load().then(
      (r): V => {
        entry.until = now + r.ttlMs;
        entry.loading = false;
        if (m.get(k) === entry) {
          entry.weight = o.weigh ? o.weigh(r.value) : 0;
          weight += entry.weight;
          evict();
        }
        return r.value;
      },
      (e): Promise<V> => {
        if (m.get(k) === entry) m.delete(k);
        return Promise.reject(e);
      },
    );
    m.set(k, entry);
    evict();
    return entry.p;
  };
}

/** At most `n` loads at once; the rest wait their turn. */
function semaphore(n: number) {
  let free = n;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (free > 0) free--;
    else await new Promise<void>((r) => waiting.push(r));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else free++;
    }
  };
}

/**
 * Security r1 F3: the public /proof and /verify routes are bounded. Each hour's tree is built once from id and leaf
 * only (never the receipt bodies) and cached: an anchored hour for good (it can never change), the open hour for
 * OPEN_HOUR_TREE_TTL_MS. A posted chain root is cached for good too; an empty answer for EMPTY_ROOT_TTL_MS.
 */
export function dbReceiptDeps(db: Db, o: { signers: Array<Hex | SignerWindow>; readRoot?: ReceiptRouteDeps["readRoot"]; latestHour?: ReceiptRouteDeps["latestHour"]; now?: () => number; limits?: { maxCachedLeaves?: number; maxTreeBuilds?: number }; forkChain?: boolean }): ReceiptRouteDeps {
  const store = pgReceiptStore(db);
  const now = o.now ?? Date.now;
  // a fork chain (ops/fork) is snapshotted and reverted, so a posted root can go away and be posted again with more
  // leaves: there nothing read from the chain is cached and no hour tree is pinned
  const fork = o.forkChain === true;
  const emptyTtl = fork ? 0 : EMPTY_ROOT_TTL_MS;
  const postedTtl = fork ? 0 : Number.POSITIVE_INFINITY;
  const trees = lruCache<number, HourTree>(MAX_CACHED_HOURS, { weigh: (t) => Math.max(1, t.index.size), maxWeight: o.limits?.maxCachedLeaves ?? MAX_CACHED_LEAVES });
  const builds = semaphore(o.limits?.maxTreeBuilds ?? MAX_TREE_BUILDS);
  const hourTree = (hourEpoch: number, fresh = false) =>
    trees(hourEpoch, now(), () => builds(async () => {
      const leaves = await store.byHour(hourEpoch);
      const tree = buildTree(leaves.map((l) => l.leaf));
      const [row] = await db.select().from(schema.receiptRoots).where(eq(schema.receiptRoots.hourEpoch, hourEpoch)).limit(1);
      const isPosted = row !== undefined && row.status === "posted";
      const posted: HourTree["posted"] = !isPosted ? null : (row!.root as string).toLowerCase() === tree.root.toLowerCase() ? (row!.root as Hex) : "mismatch";
      return { value: { index: new Map(leaves.map((l, i) => [l.id, i])), tree, posted }, ttlMs: isPosted && leaves.length <= PIN_MAX_LEAVES && !fork ? Number.POSITIVE_INFINITY : OPEN_HOUR_TREE_TTL_MS };
    }), fresh);
  const roots = lruCache<number, Hex | null>(4 * MAX_CACHED_HOURS);
  const ZERO_ROOT = /^0x0*$/;
  const readRoot = o.readRoot
    ? (h: number) =>
        roots(h, now(), async () => {
          const r = await o.readRoot!(h);
          // a posted root never changes (the anchor only appends hours); "not posted" is asked again soon
          return { value: r, ttlMs: r && !ZERO_ROOT.test(r) ? postedTtl : emptyTtl };
        })
    : undefined;
  const latestCache = lruCache<0, number | null>(1);
  const latestHour = o.latestHour ? () => latestCache(0, now(), async () => ({ value: await o.latestHour!(), ttlMs: emptyTtl })) : undefined;
  return {
    get: (id) => store.get(id),
    async proof(id) {
      const hourEpoch = await store.hourOf(id);
      if (hourEpoch === null) throw new Error(`receipt ${id} not found`);
      let t = await hourTree(hourEpoch);
      // a receipt newer than the cached open-hour tree: build the hour again once (a new id exists only once)
      if (!t.index.has(id) && t.posted === null) t = await hourTree(hourEpoch, true);
      const index = t.index.get(id);
      // a posted root that differs from the rebuilt tree means the hour changed after anchoring: no proof is served
      if (t.posted === "mismatch") return { hourEpoch, proof: [], root: null, anchored: true };
      // a receipt that is not in its hour's tree (stored after the hour was anchored, or not loaded yet): no proof,
      // so it verifies as not valid, never an error (security r1 F3 residual)
      if (index === undefined) return { hourEpoch, proof: [], root: t.posted ?? null, anchored: t.posted !== null };
      if (t.posted !== null) return { hourEpoch, proof: proofFor(t.tree, index), root: t.posted, anchored: true };
      // not anchored yet: the hour's current tree, so the receipt can be checked now and again once the root is on chain
      return { hourEpoch, proof: proofFor(t.tree, index), root: t.tree.root, anchored: false };
    },
    signers: o.signers,
    ...(readRoot ? { readRoot } : {}),
    ...(latestHour ? { latestHour } : {}),
    async listByOwner(owner, before, limit) {
      const t = schema.receipts;
      const rows = await db.select({ body: t.body }).from(t).where(before ? and(eq(t.owner, owner), lt(t.id, before)) : eq(t.owner, owner)).orderBy(desc(t.id)).limit(limit);
      return rows.map((r) => r.body as Receipt);
    },
  };
}

let resolved: Promise<ReceiptRouteDeps> | null = null;

/**
 * The anchor reader for this host (security r1 F1): the address comes from the deployment record of the network's
 * chain (contracts/deployments, DEPLOYMENTS), never from a free env value, and the RPC's eth_chainId is checked
 * before any answer is used. Only a local network (CAPSTAN_NETWORK=local) may name ANCHOR_ADDRESS and ANCHOR_CHAIN_ID.
 * Returns null when the anchor is not deployed: /verify then never reads valid.
 *
 * A fork stack (ops/fork, CAPSTAN_FORK_DEPLOYMENTS) adds its throwaway record to DEPLOYMENTS through loadConfig; that
 * path refuses a chain with a committed record and any RPC that is not loopback, so it never applies on a real host.
 * For such a record `fork` is true and the caller reads the chain on every check (gate 2026-11-08 S3, S13: an empty
 * answer was kept 30 s, so a root posted seconds after a first /verify still read not_posted, and a root the fork
 * reverted and posted again stayed cached for good). The address still comes only from DEPLOYMENTS; ANCHOR_ADDRESS
 * stays local-network only.
 */
export async function anchorReaderFromEnv(env: Record<string, string | undefined>): Promise<{ readRoot: NonNullable<ReceiptRouteDeps["readRoot"]>; latestHour: NonNullable<ReceiptRouteDeps["latestHour"]>; fork: boolean } | null> {
  const network = env.CAPSTAN_NETWORK ?? "local";
  const local = network === "local";
  const chainId = network === "mainnet" ? CHAINS.rhc.chainId : network === "testnet" ? CHAINS.rhcTestnet.chainId : Number(env.ANCHOR_CHAIN_ID ?? LOCAL_CHAIN_ID);
  const record = DEPLOYMENTS[chainId] as (typeof DEPLOYMENTS)[number] & { fork?: boolean } | undefined;
  const deployed = record?.contracts.CapstanReceiptAnchor?.address;
  const fork = record?.fork === true && !!deployed;
  const address = (deployed ?? (local ? env.ANCHOR_ADDRESS : undefined)) as Hex | undefined;
  const rpcUrl = env.ANCHOR_RPC_URL ?? (network === "mainnet" ? CHAINS.rhc.publicRpc : network === "testnet" ? CHAINS.rhcTestnet.publicRpc : undefined);
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || !rpcUrl) return null;
  const { createPublicClient, http, parseAbi } = await import("viem");
  const client = createPublicClient({ transport: http(rpcUrl) });
  const abi = parseAbi(["function rootOf(uint64 hourEpoch) view returns (bytes32 root, uint32 leafCount, uint64 postedAt)", "function latestHour() view returns (uint64)"]);
  let checked: Promise<void> | null = null;
  const checkChain = () =>
    (checked ??= client.getChainId().then((id) => {
      if (id !== chainId) throw new Error(`anchor RPC serves chain ${id}, not ${chainId}`);
    })).catch((e) => ((checked = null), Promise.reject(e)));
  return {
    fork,
    async readRoot(h) {
      await checkChain();
      const [root] = (await client.readContract({ address, abi, functionName: "rootOf", args: [BigInt(h)] })) as readonly [Hex, number, bigint];
      return root;
    },
    async latestHour() {
      await checkChain();
      return Number((await client.readContract({ address, abi, functionName: "latestHour" })) as bigint);
    },
  };
}

async function envDeps(): Promise<ReceiptRouteDeps> {
  const env = process.env;
  if (!env.DATABASE_URL) throw new Error("receipt routes need DATABASE_URL");
  const db = createDb(env.DATABASE_URL, { max: 4 });
  const signers = (env.RECEIPT_SIGNERS ?? "").split(",").map((s) => s.trim()).filter((s): s is Hex => /^0x[0-9a-fA-F]{40}$/.test(s));
  return receiptDepsWith(db, signers, await anchorReaderFromEnv(env));
}

/** The route deps for an anchor reader: a fork record's reader is never answered from a cache. */
export function receiptDepsWith(db: Db, signers: Array<Hex | SignerWindow>, anchor: Awaited<ReturnType<typeof anchorReaderFromEnv>>): ReceiptRouteDeps {
  if (!anchor) return dbReceiptDeps(db, { signers });
  const { fork, readRoot, latestHour } = anchor;
  return dbReceiptDeps(db, { signers, readRoot, latestHour, ...(fork ? { forkChain: true } : {}) });
}

export const routes: RouteSpec[] = createReceiptRoutes(() => (resolved ??= envDeps()));
