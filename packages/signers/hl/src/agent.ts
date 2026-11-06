// Agent naming, expiry and nonce windows (venue-hyperliquid.md section 7).

export const MAX_AGENT_VALIDITY_MS = 180 * 24 * 60 * 60 * 1000;
export const NONCE_PAST_MS = 2 * 24 * 60 * 60 * 1000;
export const NONCE_FUTURE_MS = 24 * 60 * 60 * 1000;
const SUFFIX = " valid_until ";

/** `${name} valid_until ${ms}`. Refuses an empty name, an expiry in the past, or one more than 180 days ahead. */
export function agentNameWithExpiry(name: string, validUntilMs: number, nowMs: number): string {
  if (typeof name !== "string" || name.length === 0) throw new Error("hl-signer: an expiring agent needs a name");
  if (name.includes(SUFFIX.trim())) throw new Error("hl-signer: agent name already carries valid_until");
  if (!Number.isSafeInteger(validUntilMs) || !Number.isSafeInteger(nowMs)) throw new Error("hl-signer: times must be integer ms");
  if (validUntilMs <= nowMs) throw new Error("hl-signer: valid_until is in the past");
  if (validUntilMs - nowMs > MAX_AGENT_VALIDITY_MS) throw new Error("hl-signer: valid_until is more than 180 days ahead");
  return `${name}${SUFFIX}${validUntilMs}`;
}

/** Split "name valid_until ms" into its parts; `validUntil` null when the name carries no expiry. */
export function parseAgentName(full: string): { name: string; validUntil: number | null } {
  const i = full.lastIndexOf(SUFFIX);
  if (i < 0) return { name: full, validUntil: null };
  const ms = Number(full.slice(i + SUFFIX.length));
  return Number.isSafeInteger(ms) ? { name: full.slice(0, i), validUntil: ms } : { name: full, validUntil: null };
}

/** Nonces are ms timestamps inside (T - 2 d, T + 1 d). Throws outside the window. */
export function assertNonceWindow(nonce: number, nowMs: number): void {
  if (!Number.isSafeInteger(nonce) || nonce <= 0) throw new Error("hl-signer: nonce must be a positive integer ms timestamp");
  if (nonce <= nowMs - NONCE_PAST_MS) throw new Error("hl-signer: nonce is more than 2 days in the past");
  if (nonce >= nowMs + NONCE_FUTURE_MS) throw new Error("hl-signer: nonce is more than 1 day in the future");
}
