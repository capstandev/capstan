// Receipt service (todo 28): issues signed, per-owner chained receipts into Postgres, idempotent on requestHash +
// buildId, publishes the receipt id on PUBSUB.receipts(owner) after the row commits, and serves Merkle proofs for
// the anchored hour. It never loads a key: the caller passes the signer (a ServiceSigner from a keystore).
import { PUBSUB, schema, ulid, type Db } from "@capstan/core";
import type { Hex, Receipt } from "@capstan/schema";
import { eq } from "drizzle-orm";
import { issue, ownerKey, type ReceiptDraft } from "./chain";
import { idemKeyOf, pgReceiptStore } from "./pg/store";
import type { ReceiptSigner } from "./sign";
import { buildTree, proofFor } from "./tree";

export interface ReceiptServiceDeps {
  db: Db;
  signer: ReceiptSigner;
  now: () => Date;
  id?: () => string;
  publish?: (channel: string, payload: unknown) => Promise<void>;
}

export interface ReceiptService {
  issue(draft: ReceiptDraft): Promise<Receipt>;
  get(id: string): Promise<Receipt | null>;
  proof(id: string): Promise<{ hourEpoch: number; proof: Hex[]; root: Hex | null }>;
}

const isUniqueViolation = (e: unknown): boolean => {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.code === "23505" || x?.cause?.code === "23505";
};

export function createReceiptService(deps: ReceiptServiceDeps): ReceiptService {
  const id = deps.id ?? (() => ulid(deps.now().getTime()));
  const read = pgReceiptStore(deps.db);

  async function issueOnce(draft: ReceiptDraft): Promise<{ r: Receipt; fresh: boolean }> {
    const key = idemKeyOf(draft);
    return deps.db.transaction(async (tx) => {
      const store = pgReceiptStore(tx);
      const k = ownerKey(draft.owner);
      if (k !== null) await store.lockOwner(k);
      const existing = await store.byIdem(key);
      if (existing) return { r: existing, fresh: false };
      // the owner lock is already held by this transaction, so the in-process lock is a pass-through
      const r = await issue(draft, { store, signer: deps.signer, now: deps.now, id, lock: (_k, fn) => fn() });
      return { r, fresh: true };
    });
  }

  return {
    async issue(draft) {
      let out: { r: Receipt; fresh: boolean };
      try {
        out = await issueOnce(draft);
      } catch (e) {
        // two owner-null receipts with the same key raced: the loser returns the winner's receipt
        if (!isUniqueViolation(e)) throw e;
        const existing = await read.byIdem(idemKeyOf(draft));
        if (!existing) throw e;
        out = { r: existing, fresh: false };
      }
      if (out.fresh && out.r.owner !== null && deps.publish) {
        await deps.publish(PUBSUB.receipts(out.r.owner.toLowerCase()), { receiptId: out.r.receiptId });
      }
      return out.r;
    },
    get: (rid) => read.get(rid),
    async proof(rid) {
      const hourEpoch = await read.hourOf(rid);
      if (hourEpoch === null) throw new Error(`receipt ${rid} not found`);
      const leaves = await read.byHour(hourEpoch);
      const index = leaves.findIndex((l) => l.id === rid);
      const tree = buildTree(leaves.map((l) => l.leaf));
      const roots = await deps.db.select().from(schema.receiptRoots).where(eq(schema.receiptRoots.hourEpoch, hourEpoch)).limit(1);
      const posted = roots[0] && roots[0].status === "posted" ? (roots[0].root as Hex) : null;
      // a posted root that differs from the rebuilt tree means the hour changed after anchoring: no proof is served
      const root = posted !== null && posted.toLowerCase() === tree.root.toLowerCase() ? posted : null;
      return { hourEpoch, proof: proofFor(tree, index), root };
    },
  };
}
