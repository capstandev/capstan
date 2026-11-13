// Errors the SDK raises. Every refusal names a code and, where one exists, the field that failed, so a caller (or an
// MCP host) can show the user exactly what was wrong. Messages never carry key material.
export const SDK_ERROR_CODES = [
  "PAYLOAD_MISMATCH", // a server build differs from the intent or the pins
  "BUILD_EXPIRED", // the build's 30 s window has passed
  "POLICY_BREACH", // the agent policy refuses the order (the local copy, or the server and relay: serverCode set)
  "DEPLOYMENT_MISMATCH", // the server's builder addresses or caps differ from the pins in this SDK release
  "TEMPLATE_UNKNOWN", // an onboarding bundle whose template hash is not pinned for this release
  "WALLET_DECLINED", // the user said no at a wallet prompt
  "KEY_NOT_FOUND", // no such key in the local store
  "KEY_REUSED", // an agent address that was used before
  "WEAK_PASSPHRASE", // file key store passphrase under 12 characters
  "UNLOCK_FAILED", // wrong passphrase or damaged key file (says nothing more)
  "X402_REFUSED", // a 402 the spend controls do not allow
  "API_ERROR", // the Capstan API answered with an error body
  "VENUE_ERROR", // a direct-mode venue post failed
  "UNSUPPORTED", // a venue or encoding this SDK release does not handle
  "INVALID_INPUT",
] as const;
export type SdkErrorCode = (typeof SDK_ERROR_CODES)[number];

export class SdkError extends Error {
  readonly code: SdkErrorCode;
  readonly field?: string;
  /** For a server answer (API_ERROR, or POLICY_BREACH from the server): its error code and HTTP status. */
  readonly serverCode?: string;
  readonly status?: number;
  readonly receiptId?: string;
  /** The server's Retry-After in ms, when it named one (a 429 the SDK did not, or could no longer, retry). */
  readonly retryAfterMs?: number;
  constructor(code: SdkErrorCode, message?: string, opts: { field?: string; serverCode?: string; status?: number; receiptId?: string; retryAfterMs?: number } = {}) {
    super(message ?? code);
    this.name = "SdkError";
    this.code = code;
    if (opts.field !== undefined) this.field = opts.field;
    if (opts.serverCode !== undefined) this.serverCode = opts.serverCode;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.receiptId !== undefined) this.receiptId = opts.receiptId;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export function refuse(code: SdkErrorCode, field: string, message?: string): never {
  throw new SdkError(code, message ?? `${code}: ${field}`, { field });
}
