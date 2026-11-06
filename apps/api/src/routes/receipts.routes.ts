// Receipts (spec 11, 13.1). GET /v1/receipts/{id} serves one receipt by id (ids are unguessable ulids); /proof gives
// the hour's Merkle proof once the root is anchored; /verify runs the full public check (signature, leaf, proof,
// on-chain root). Listing by owner (GET /v1/receipts?owner=) needs that owner's signature: receipts are public one by
// one, never enumerable by a stranger.
import { createDb, schema, type Db, type RouteSpec } from "@capstan/core";
import { buildTree, createReceiptService, pgReceiptStore, proofFor, verifyFull, type ReceiptService, type SignerWindow } from "@capstan/receipts";
import { errorBody, type Hex, type Receipt } from "@capstan/schema";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Context } from "hono";

export interface ReceiptRouteDeps {
  get(id: string): Promise<Receipt | null>;
  /** The hour's proof. `anchored` false: the hour's root is not on chain yet, the root is this server's tree. */
  proof(id: string): Promise<{ hourEpoch: number; proof: Hex[]; root: Hex | null; anchored?: boolean }>;
  /** The anchored root for an hour from the CapstanReceiptAnchor contract, or null when not posted (or no chain). */
  readRoot?: (hourEpoch: number) => Promise<Hex | null>;
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
        const v = await verifyFull(x.r, { proof: p.proof, root: p.root, signers: x.deps.signers, readRoot: x.deps.readRoot ?? (async () => null) });
        return c.json({ receiptId: x.r.receiptId, ...v });
      },
    },
  ];
}

export function dbReceiptDeps(db: Db, o: { signers: Array<Hex | SignerWindow>; readRoot?: ReceiptRouteDeps["readRoot"]; service?: ReceiptService }): ReceiptRouteDeps {
  const store = pgReceiptStore(db);
  const svc = o.service ?? createReceiptService({ db, signer: { address: "0x0000000000000000000000000000000000000000", signMessage: () => Promise.reject(new Error("this host does not sign receipts")) }, now: () => new Date() });
  return {
    get: (id) => store.get(id),
    async proof(id) {
      const p = await svc.proof(id);
      if (p.root !== null) return { ...p, anchored: true };
      // not anchored yet (or the posted root differs and no proof is served): show the hour's current tree only when
      // nothing is posted for the hour, so the receipt can be checked now and again once the root is on chain
      const [posted] = await db.select().from(schema.receiptRoots).where(eq(schema.receiptRoots.hourEpoch, p.hourEpoch)).limit(1);
      if (posted && posted.status === "posted") return { ...p, anchored: true };
      const leaves = await store.byHour(p.hourEpoch);
      const tree = buildTree(leaves.map((l) => l.leaf));
      return { hourEpoch: p.hourEpoch, proof: proofFor(tree, leaves.findIndex((l) => l.id === id)), root: tree.root, anchored: false };
    },
    signers: o.signers,
    ...(o.readRoot ? { readRoot: o.readRoot } : {}),
    async listByOwner(owner, before, limit) {
      const t = schema.receipts;
      const rows = await db.select({ body: t.body }).from(t).where(before ? and(eq(t.owner, owner), lt(t.id, before)) : eq(t.owner, owner)).orderBy(desc(t.id)).limit(limit);
      return rows.map((r) => r.body as Receipt);
    },
  };
}

let resolved: Promise<ReceiptRouteDeps> | null = null;
async function envDeps(): Promise<ReceiptRouteDeps> {
  const env = process.env;
  if (!env.DATABASE_URL) throw new Error("receipt routes need DATABASE_URL");
  const db = createDb(env.DATABASE_URL, { max: 4 });
  const signers = (env.RECEIPT_SIGNERS ?? "").split(",").map((s) => s.trim()).filter((s): s is Hex => /^0x[0-9a-fA-F]{40}$/.test(s));
  let readRoot: ReceiptRouteDeps["readRoot"];
  if (env.ANCHOR_RPC_URL && env.ANCHOR_ADDRESS) {
    const { createPublicClient, http, parseAbi } = await import("viem");
    const client = createPublicClient({ transport: http(env.ANCHOR_RPC_URL) });
    const abi = parseAbi(["function rootOf(uint64 hourEpoch) view returns (bytes32 root, uint32 leafCount, uint64 postedAt)"]);
    readRoot = async (h) => {
      const [root] = (await client.readContract({ address: env.ANCHOR_ADDRESS as Hex, abi, functionName: "rootOf", args: [BigInt(h)] })) as readonly [Hex, number, bigint];
      return root;
    };
  }
  return dbReceiptDeps(db, { signers, ...(readRoot ? { readRoot } : {}) });
}

export const routes: RouteSpec[] = createReceiptRoutes(() => (resolved ??= envDeps()));
