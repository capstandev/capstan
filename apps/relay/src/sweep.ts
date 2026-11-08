// Pending-order sweep (security r2 R2-RELAY-03). A relay that stops between the order row and the venue answer (a
// SIGKILL, a crash, a failed row update) leaves the row "pending" with no venue order id and maybe no receipt. Every
// minute the relay reads rows with no venue answer that are a few minutes old, asks the venue where a keyless read
// exists (Hyperliquid orderStatus by cloid, Lighter tx by hash), writes what it learns, and issues the order receipt
// if the first run did not (receipts are idempotent on request hash and build, so an existing one is returned).
// Nothing is ever sent again. Aster has no keyless account read: its rows become "unknown" with a receipt.
import type { Hex, SignedEnvelope, SubmitResult } from "@capstan/schema";
import type { RelayDeps, StoredBuild } from "./types";

/** Rows younger than this may still be in flight in a live job. */
export const SWEEP_MIN_AGE_MS = 3 * 60_000;
/** Rows older than this are left as they are (the last sweep marked them unknown with a receipt). */
export const SWEEP_MAX_AGE_MS = 24 * 3_600_000;
/** A row still "pending" this long after submit is marked "unknown" even when the venue gave no answer. */
export const SWEEP_UNKNOWN_AFTER_MS = 10 * 60_000;
export const SWEEP_INTERVAL_MS = 60_000;

export interface SweepResult {
  checked: number;
  settled: number;
  markedUnknown: number;
  receipts: number;
}

type SweepDeps = Pick<RelayDeps, "store" | "venues" | "receipts" | "now" | "log">;

/** The envelope stand-in for a receipt draft: the row's payload hash is the receipt's, never one recomputed here. */
const stubEnvelope = (b: StoredBuild, payloadHash: Hex): SignedEnvelope => ({ buildId: b.build.buildId, venue: b.venue, encoding: b.build.encoding, signedBody: null, signature: "0x", signerRef: "", payloadHash }) as unknown as SignedEnvelope;

export async function sweepPendingOrders(deps: SweepDeps, o: { limit?: number } = {}): Promise<SweepResult> {
  const now = deps.now();
  const rows = await deps.store.unsettledOrders(new Date(now - SWEEP_MAX_AGE_MS), new Date(now - SWEEP_MIN_AGE_MS), o.limit ?? 200);
  const out: SweepResult = { checked: 0, settled: 0, markedUnknown: 0, receipts: 0 };
  for (const row of rows) {
    out.checked++;
    try {
      const b = await deps.store.getBuild(row.buildId);
      const venue = deps.venues.get(row.venue);
      if (!b || !venue) continue;
      const seen = venue.lookup ? await venue.lookup(b, row.signedPayloadHash).catch(() => null) : null;
      let result: SubmitResult;
      if (seen && seen.status !== "unknown") {
        result = seen;
        await deps.store.updateOrder(row.id, { status: seen.status, venueOrderId: seen.venueOrderId ?? row.venueOrderId });
        out.settled++;
      } else {
        result = { status: "unknown", venueOrderId: row.venueOrderId, txHash: null, venueResponse: { status: "unknown", recordedBy: "relay pending-order sweep" } };
        if (row.status === "pending" && now - row.submittedAt.getTime() >= SWEEP_UNKNOWN_AFTER_MS) {
          await deps.store.updateOrder(row.id, { status: "unknown" });
          out.markedUnknown++;
        } else if (row.status === "unknown") continue; // its receipt was issued when it was marked
      }
      await deps.receipts.issue({ ...venue.draft(b, stubEnvelope(b, row.signedPayloadHash), result, row.signedPayloadHash), signedPayloadHash: row.signedPayloadHash });
      out.receipts++;
    } catch (e) {
      deps.log?.("pending-order sweep: row failed", { orderId: row.id, error: (e as Error).message });
    }
  }
  if (out.checked) deps.log?.("pending-order sweep", { ...out });
  return out;
}

/** Run the sweep every SWEEP_INTERVAL_MS (one at a time). Returns a stop function. */
export function startPendingSweep(deps: SweepDeps, o: { intervalMs?: number } = {}): () => void {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepPendingOrders(deps);
    } catch (e) {
      deps.log?.("pending-order sweep failed", { error: (e as Error).message });
    } finally {
      running = false;
    }
  }, o.intervalMs ?? SWEEP_INTERVAL_MS);
  t.unref?.();
  return () => clearInterval(t);
}
