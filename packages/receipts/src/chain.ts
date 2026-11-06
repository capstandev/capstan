// Receipt issuing and the per-owner hash chain (spec 11): each receipt carries the hash of the owner's previous
// receipt. `issue` reads the owner's head and appends under a per-owner lock, so concurrent calls give one linear chain.
// Receipts with owner null (for example a refusal before any wallet is known) are not chained: prevReceiptHash null.
import type { Hex, Receipt } from "@capstan/schema";
import { receiptHash, receiptLeaf } from "./hash";
import { type ReceiptSigner, signReceipt } from "./sign";

export type ReceiptDraft = Omit<Receipt, "v" | "receiptId" | "ts" | "brand" | "prevReceiptHash" | "sig">;

export interface ReceiptStore {
  head(owner: Hex | null): Promise<{ id: string; hash: Hex } | null>;
  append(r: Receipt, leaf: Hex, hourEpoch: number): Promise<void>;
  byHour(hourEpoch: number): Promise<{ id: string; leaf: Hex; ts: string }[]>;
  get(id: string): Promise<Receipt | null>;
}

export type OwnerLock = (owner: string, fn: () => Promise<Receipt>) => Promise<Receipt>;

export interface IssueDeps {
  store: ReceiptStore;
  signer: ReceiptSigner;
  now: () => Date;
  id: () => string;
  lock: OwnerLock;
}

/** Chain key of an owner: the lowercased address, so checksum case never forks a chain. */
export const ownerKey = (owner: Hex | null): string | null => (owner === null ? null : owner.toLowerCase());

/** floor(unix seconds / 3600) of an ISO time. */
export function hourEpochOf(ts: string): number {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) throw new Error(`hourEpochOf: not an ISO time: ${ts}`);
  return Math.floor(ms / 1000 / 3600);
}

/** Compare two receipts by (ts, receiptId): the order of leaves in an hour and of links in a chain. */
export function byTsThenId(a: { ts: string; id?: string; receiptId?: string }, b: { ts: string; id?: string; receiptId?: string }): number {
  const ta = Date.parse(a.ts);
  const tb = Date.parse(b.ts);
  if (ta !== tb) return ta - tb;
  const ia = a.receiptId ?? a.id ?? "";
  const ib = b.receiptId ?? b.id ?? "";
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** In-process store for tests and the SDK. The Postgres store is pgReceiptStore (src/pg). */
export function memoryStore(): ReceiptStore {
  const rows = new Map<string, { r: Receipt; leaf: Hex; hour: number }>();
  const heads = new Map<string, { id: string; hash: Hex }>();
  return {
    async head(owner) {
      const k = ownerKey(owner);
      return k === null ? null : (heads.get(k) ?? null);
    },
    async append(r, leaf, hour) {
      if (rows.has(r.receiptId)) throw new Error(`receipt ${r.receiptId} already stored`);
      rows.set(r.receiptId, { r, leaf, hour });
      const k = ownerKey(r.owner);
      if (k !== null) heads.set(k, { id: r.receiptId, hash: receiptHash(r) });
    },
    async byHour(hour) {
      return [...rows.values()]
        .filter((x) => x.hour === hour)
        .map((x) => ({ id: x.r.receiptId, leaf: x.leaf, ts: x.r.ts }))
        .sort(byTsThenId);
    },
    async get(id) {
      return rows.get(id)?.r ?? null;
    },
  };
}

/** A per-key async mutex: calls for one key run one at a time in arrival order; different keys run in parallel. */
export function memoryLock(): OwnerLock {
  const tails = new Map<string, Promise<unknown>>();
  return (key, fn) => {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

/** Issue one signed receipt: sets v, id, ts, brand and prevReceiptHash (from the owner's head, under the lock), signs, stores. */
export async function issue(draft: ReceiptDraft, deps: IssueDeps): Promise<Receipt> {
  const k = ownerKey(draft.owner);
  const run = async (): Promise<Receipt> => {
    const head = k === null ? null : await deps.store.head(draft.owner);
    const ts = deps.now().toISOString();
    const body: Omit<Receipt, "sig"> = { v: 1, receiptId: deps.id(), ts, brand: "capstan", ...draft, prevReceiptHash: head?.hash ?? null };
    const signed = await signReceipt(body, deps.signer);
    await deps.store.append(signed, receiptLeaf(signed), hourEpochOf(ts));
    return signed;
  };
  return k === null ? run() : deps.lock(k, run);
}

/**
 * Check every owner's chain in (ts, receiptId) order: the first receipt links to null, every later one to the hash of
 * the one before. Owner-null receipts must link to null. Reports the first receipt whose link is wrong.
 */
export function verifyChain(receipts: Receipt[]): { ok: boolean; brokenAt?: string } {
  const sorted = [...receipts].sort(byTsThenId);
  const last = new Map<string, Hex>();
  for (const r of sorted) {
    const k = ownerKey(r.owner);
    const want = k === null ? null : (last.get(k) ?? null);
    const got = r.prevReceiptHash ?? null;
    if ((want === null) !== (got === null) || (want !== null && got !== null && want.toLowerCase() !== got.toLowerCase())) return { ok: false, brokenAt: r.receiptId };
    if (k !== null) last.set(k, receiptHash(r));
  }
  return { ok: true };
}
