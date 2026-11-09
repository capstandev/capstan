// Per-key nonces. Each Lighter API key has its own nonce, per account and per exchange; the default rule is strict
// previous + 1. Which rejects consume a nonce (docs, core concepts):
//   api               API server reject (bad sig, wrong nonce, rate limit): NOT consumed, resend the same signed tx
//   sequencer_before  sequencer reject before apply (expired, margin changed, market inactive): NOT consumed, and every
//                     higher nonce already sent on that key fails too, so all of them are re-signed from this nonce
//   sequencer_applied reject while applying (bad size or price, duplicate client order index): consumed, a no-op
//   unknown           a "code: 200" with no clear outcome: nothing on this key is signed again until
//                     GET /api/v1/tx?by=hash and nextNonce settle it (else an order can be placed twice)
import { CapstanError } from "@capstan/schema";

export const MAX_NONCE = 2 ** 48 - 1;
export const MAX_SKIP = 2 ** 47 - 1;

export type RejectKind = "api" | "sequencer_before" | "sequencer_applied" | "unknown";

export type RejectAction =
  | { kind: "resend_same"; nonce: number }
  | { kind: "resign_from"; nonce: number; resign: number[] }
  | { kind: "consumed"; nonce: number }
  | { kind: "check_first"; nonce: number };

export interface NonceSource {
  nextNonce(accountIndex: number, apiKeyIndex: number): Promise<number>;
  tx(hash: string): Promise<{ found: boolean; status: number | null }>;
}

/**
 * How long a handed-out nonce is held for its build (security r2 D2-ADP-01, review-r1:2 R1-01 and review-r1:3 F4): a
 * Lighter build is valid 30 s, so a nonce still not seen at the venue after this was never sent (refused after the
 * build, never signed, or expired) and nothing above it can land under the strict previous + 1 rule.
 */
export const RESERVATION_TTL_MS = 45_000;

interface KeyState {
  next: number;
  /** nonce -> when it was handed out */
  inFlight: Map<number, number>;
  /** a nonce given back that was not the newest: the next build re-reads the venue first */
  gap: boolean;
  unknown: Map<number, string | null>; // nonce -> tx hash
  clientOrder: number;
}

const k = (a: number, i: number) => `${a}:${i}`;

export class NonceTracker {
  private keys = new Map<string, KeyState>();
  constructor(
    private readonly reader: NonceSource,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private state(accountIndex: number, apiKeyIndex: number): KeyState {
    const s = this.keys.get(k(accountIndex, apiKeyIndex));
    if (!s) throw new CapstanError("INVALID_INPUT", `nonce tracker not seeded for ${accountIndex}:${apiKeyIndex}`);
    return s;
  }

  /** Seed from the venue's nextNonce (weight 6). Must run before the first next(). */
  async seed(accountIndex: number, apiKeyIndex: number): Promise<void> {
    const n = await this.reader.nextNonce(accountIndex, apiKeyIndex);
    checkNonce(n);
    this.keys.set(k(accountIndex, apiKeyIndex), { next: n, inFlight: new Map(), gap: false, unknown: new Map(), clientOrder: 0 });
  }

  seeded(accountIndex: number, apiKeyIndex: number): boolean {
    return this.keys.has(k(accountIndex, apiKeyIndex));
  }

  /** The nonce for the next tx on this key (strict previous + 1). Refused while an outcome is unknown. */
  next(accountIndex: number, apiKeyIndex: number): number {
    const s = this.state(accountIndex, apiKeyIndex);
    if (s.unknown.size) throw new CapstanError("INVALID_INPUT", `key ${accountIndex}:${apiKeyIndex} has a tx with an unknown outcome; resolve it before signing again`);
    // never hand out a nonce a live build still holds (a refresh can move `next` below fresh reservations, gate G-2)
    let n = s.next;
    while (s.inFlight.has(n)) n++;
    checkNonce(n);
    s.next = n + 1;
    s.inFlight.set(n, this.now());
    return n;
  }

  /**
   * Give back a nonce whose build was refused after it was made (policy, quote check, store): the newest one simply
   * goes back, so the next build carries it; an older one leaves a gap the next refresh() closes from the venue.
   */
  release(accountIndex: number, apiKeyIndex: number, nonce: number): void {
    const s = this.keys.get(k(accountIndex, apiKeyIndex));
    if (!s || !s.inFlight.has(nonce)) return;
    s.inFlight.delete(nonce);
    if (s.next === nonce + 1) s.next = nonce;
    else s.gap = true;
  }

  /**
   * Before handing out a nonce (security r2 D2-ADP-01): when a nonce was given back out of order, or one was handed out
   * longer ago than RESERVATION_TTL_MS, read the venue's nextNonce. Reservations below it landed (or were consumed) and
   * are dropped. A reservation at or above it that is past its build life was never sent, so nothing after it can
   * land: signing restarts from the venue's nextNonce. Only stale reservations are dropped (gate G-2): a fresh one is
   * still held by a live build that may yet be sent, so next() skips past it rather than handing its nonce out again.
   * Nothing changes while an outcome is unknown.
   */
  async refresh(accountIndex: number, apiKeyIndex: number): Promise<void> {
    const s = this.state(accountIndex, apiKeyIndex);
    if (s.unknown.size) return;
    const t = this.now();
    const stale = [...s.inFlight].filter(([, at]) => t - at > RESERVATION_TTL_MS).map(([n]) => n);
    if (!s.gap && !stale.length) return;
    const venueNext = checkNonce(await this.reader.nextNonce(accountIndex, apiKeyIndex));
    for (const n of [...s.inFlight.keys()]) if (n < venueNext) s.inFlight.delete(n);
    if (s.gap || stale.some((n) => n >= venueNext)) {
      s.next = venueNext;
      for (const n of stale) s.inFlight.delete(n);
    } else s.next = Math.max(s.next, venueNext);
    s.gap = false;
  }

  /** A client order index per key: increasing, 1 .. 2^48 - 1, millisecond-based so restarts do not repeat it. */
  nextClientOrderIndex(accountIndex: number, apiKeyIndex: number): number {
    const s = this.state(accountIndex, apiKeyIndex);
    const v = Math.max(s.clientOrder + 1, this.now() % MAX_NONCE);
    s.clientOrder = v >= MAX_NONCE ? 1 : v;
    return s.clientOrder;
  }

  /** Jump ahead with the SkipNonce attribute. Jumps of 2^47 - 1 or more are refused (venue rule). */
  skipTo(accountIndex: number, apiKeyIndex: number, target: number): void {
    const s = this.state(accountIndex, apiKeyIndex);
    checkNonce(target);
    if (target <= s.next) throw new CapstanError("INVALID_INPUT", "a skip must move the nonce forward");
    if (target - s.next >= MAX_SKIP) throw new CapstanError("INVALID_INPUT", "nonce skip jumps must stay under 2^47 - 1");
    s.next = target;
  }

  /** The venue accepted the tx with this nonce. */
  onAccepted(accountIndex: number, apiKeyIndex: number, nonce: number): void {
    this.state(accountIndex, apiKeyIndex).inFlight.delete(nonce);
  }

  /** Classify a reject and say what the caller must do. */
  onReject(accountIndex: number, apiKeyIndex: number, nonce: number, kind: RejectKind, txHash: string | null = null): RejectAction {
    const s = this.state(accountIndex, apiKeyIndex);
    switch (kind) {
      case "api":
        return { kind: "resend_same", nonce };
      case "sequencer_before": {
        const resign = [...s.inFlight.keys()].filter((n) => n > nonce).sort((a, b) => a - b);
        for (const n of resign) s.inFlight.delete(n);
        s.inFlight.delete(nonce);
        s.next = nonce;
        return { kind: "resign_from", nonce, resign };
      }
      case "sequencer_applied":
        s.inFlight.delete(nonce);
        return { kind: "consumed", nonce };
      case "unknown":
        s.unknown.set(nonce, txHash);
        return { kind: "check_first", nonce };
    }
  }

  /**
   * Settle an unknown outcome: found by hash, or the venue's nextNonce has moved past it, means consumed; otherwise
   * the nonce was not used and signing resumes from it.
   */
  async resolveUnknown(accountIndex: number, apiKeyIndex: number, nonce: number): Promise<"consumed" | "not_applied"> {
    const s = this.state(accountIndex, apiKeyIndex);
    if (!s.unknown.has(nonce)) throw new CapstanError("INVALID_INPUT", `nonce ${nonce} has no unknown outcome`);
    const hash = s.unknown.get(nonce) ?? null;
    const byHash = hash ? await this.reader.tx(hash) : { found: false, status: null };
    const venueNext = await this.reader.nextNonce(accountIndex, apiKeyIndex);
    s.unknown.delete(nonce);
    s.inFlight.delete(nonce);
    if (byHash.found || venueNext > nonce) {
      s.next = Math.max(s.next, venueNext);
      return "consumed";
    }
    s.next = Math.min(s.next, venueNext);
    return "not_applied";
  }
}

export function checkNonce(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0 || n >= MAX_NONCE) throw new CapstanError("INVALID_INPUT", `nonce ${n} is outside 0 .. 2^48 - 2`);
  return n;
}
