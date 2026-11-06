// Nonce manager for a service key (todo 28, REL-5). The next nonce per (key, chain) lives in `service_nonces` and is
// handed out under SELECT ... FOR UPDATE, so two posts in flight get consecutive nonces. resync() resets it from the
// chain's pending transaction count: on start and after any failure, so a crash or a dropped transaction never leaves
// a gap and a restart never reuses a nonce.
import { schema, type Db } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { and, eq } from "drizzle-orm";
import type { PublicClient } from "viem";

export class NonceManager {
  private readonly inflight = new Set<number>();

  constructor(
    private readonly db: Db,
    private readonly rpc: Pick<PublicClient, "getTransactionCount">,
    private readonly key: string,
    private readonly address: Hex,
    private readonly chainId: number,
  ) {
    if (!/^[a-z0-9-]+$/.test(key)) throw new Error("NonceManager: key is a service name like 'anchor-poster'");
  }

  private where() {
    const t = schema.serviceNonces;
    return and(eq(t.key, this.key), eq(t.chainId, this.chainId));
  }

  private pending(): Promise<number> {
    return this.rpc.getTransactionCount({ address: this.address, blockTag: "pending" });
  }

  /** The next nonce to sign with; consecutive calls (even concurrent ones) get consecutive values. */
  async next(): Promise<number> {
    const t = schema.serviceNonces;
    const start = await this.pending();
    await this.db.insert(t).values({ key: this.key, chainId: this.chainId, nextNonce: start }).onConflictDoNothing();
    const n = await this.db.transaction(async (tx) => {
      const rows = await tx.select().from(t).where(this.where()).for("update");
      const cur = Math.max(rows[0]!.nextNonce, start);
      await tx.update(t).set({ nextNonce: cur + 1 }).where(this.where());
      return cur;
    });
    this.inflight.add(n);
    return n;
  }

  /** A transaction with nonce `n` was mined. */
  async confirm(n: number): Promise<void> {
    this.inflight.delete(n);
  }

  /** Nonces handed out and not confirmed yet. */
  inFlight(): number[] {
    return [...this.inflight].sort((a, b) => a - b);
  }

  /** Reset the next nonce to the chain's pending count (start-up and after any failure). */
  async resync(): Promise<number> {
    const t = schema.serviceNonces;
    const p = await this.pending();
    await this.db
      .insert(t)
      .values({ key: this.key, chainId: this.chainId, nextNonce: p })
      .onConflictDoUpdate({ target: [t.key, t.chainId], set: { nextNonce: p } });
    this.inflight.clear();
    return p;
  }

  /** The stored next nonce (null before the first use). */
  async stored(): Promise<number | null> {
    const rows = await this.db.select().from(schema.serviceNonces).where(this.where());
    return rows[0]?.nextNonce ?? null;
  }
}
