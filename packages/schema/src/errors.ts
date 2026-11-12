// Every API error code with its HTTP status. Error body shape (spec 13.1): { error: { code, message, receiptId? } }.
export const ERROR_CODES = {
  // spec 13.1
  GEO_REFUSED: { status: 403, message: "Not available in your region." },
  DECLARATION_MISSING: { status: 403, message: "A signed eligibility declaration is required." },
  POLICY_BREACH: { status: 403, message: "The request breaches the agent policy." },
  BUILDER_APPROVAL_REQUIRED: { status: 403, message: "The builder fee approval is missing or too low." },
  HL_AGENT_SLOTS_FULL: { status: 409, message: "Every Hyperliquid agent slot is in use." },
  HL_BUILDER_APPROVALS_FULL: { status: 409, message: "The account already has the maximum number of builder approvals." },
  ASTER_DEPOSIT_REQUIRED: { status: 409, message: "The wallet must complete an Aster deposit first." },
  LIGHTER_NO_ACCOUNT: { status: 404, message: "No Lighter account exists for this address." },
  VENUE_DATA_ONLY: { status: 403, message: "This venue is data only." },
  MARKET_NOT_EXECUTABLE: { status: 403, message: "This market is not executable." },
  BUILD_EXPIRED: { status: 410, message: "The build has expired. Build again." },
  PAYLOAD_MISMATCH: { status: 422, message: "The signed payload does not match the build." },
  DUPLICATE_PAYLOAD: { status: 409, message: "This signed payload was already submitted." },
  VENUE_RATE_LIMITED: { status: 429, message: "The venue rate budget is used up. Try again shortly." },
  VENUE_ERROR: { status: 502, message: "The venue returned an error." },
  // research and plan additions
  FEE_FREE_UNAVAILABLE: { status: 409, message: "Fee-free routing is not available for this route." },
  STALE_QUOTE: { status: 409, message: "Market data is too old to quote." },
  DEPEG_FLAG: { status: 409, message: "A stablecoin price gap flags this comparison." },
  LIGHTER_KEY_INDEX_EXHAUSTED: { status: 409, message: "No free Lighter API key index is left." },
  ASTER_NONCE_EXPIRED: { status: 422, message: "The Aster nonce is outside the accepted window." },
  X402_PAYMENT_REQUIRED: { status: 402, message: "Payment required." },
  X402_SETTLEMENT_PENDING: { status: 409, message: "The payment settlement is still pending." },
  X402_PAYMENTS_PAUSED: { status: 503, message: "Payments are paused." },
  X402_PAYMENTS_UNAVAILABLE: { status: 503, message: "No payment rail is available for this route." },
  AGENT_KILLED: { status: 403, message: "This agent was stopped." },
  RETIRED_AGENT: { status: 403, message: "This agent is retired. Onboard a new one." },
  UNSUPPORTED_VENUE: { status: 400, message: "Unsupported venue." },
  INVALID_INPUT: { status: 400, message: "The request is not valid." },
  UNAUTHORIZED: { status: 401, message: "A valid signature or key is required." },
  NOT_FOUND: { status: 404, message: "Not found." },
  INTERNAL_ERROR: { status: 500, message: "Internal error." },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;
export const ERROR_CODE_LIST = Object.keys(ERROR_CODES) as ErrorCode[];

export interface ErrorBody {
  error: { code: ErrorCode; message: string; receiptId?: string };
}

export function errorBody(code: ErrorCode, message?: string, receiptId?: string): ErrorBody {
  const body: ErrorBody = { error: { code, message: message ?? ERROR_CODES[code].message } };
  if (receiptId) body.error.receiptId = receiptId;
  return body;
}

export function httpStatus(code: ErrorCode): number {
  return ERROR_CODES[code].status;
}

/** Throwable carrier for an API error. Messages never carry key material or user input verbatim. */
export class CapstanError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly receiptId?: string;
  readonly field?: string;
  /** How long the caller should wait before a retry (sent as Retry-After); set on VENUE_RATE_LIMITED. */
  readonly retryAfterMs?: number;
  constructor(code: ErrorCode, message?: string, opts?: { receiptId?: string; field?: string; retryAfterMs?: number }) {
    super(message ?? ERROR_CODES[code].message);
    this.name = "CapstanError";
    this.code = code;
    this.status = ERROR_CODES[code].status;
    if (opts?.receiptId) this.receiptId = opts.receiptId;
    if (opts?.field) this.field = opts.field;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
  toBody(): ErrorBody {
    return errorBody(this.code, this.message, this.receiptId);
  }
}

/**
 * Idle timeout for every Bun.serve (G4-01). Bun's default (10 s) closes the socket of any request that sends no byte
 * for 10 s, so a caller got a reset instead of an answer. 60 s sits above the longest wait one request makes (an 8 s
 * venue budget cap, a 10 s venue fetch, a 10 s relay answer, the relay's 30 s safety lane) and below the proxy (Caddy
 * sets no response timeout; its idle timeout is 5 min). Bun allows at most 255.
 */
export const SERVER_IDLE_TIMEOUT_S = 60;
