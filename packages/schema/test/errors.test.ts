// R17: every error code has an HTTP status and the error body shape { error: { code, message, receiptId? } }.
import { describe, expect, test } from "bun:test";
import { CapstanError, ERROR_CODE_LIST, ERROR_CODES, errorBody, httpStatus } from "../src/errors";

const SPEC_13_1 = ["GEO_REFUSED", "DECLARATION_MISSING", "POLICY_BREACH", "BUILDER_APPROVAL_REQUIRED", "HL_AGENT_SLOTS_FULL", "HL_BUILDER_APPROVALS_FULL", "ASTER_DEPOSIT_REQUIRED", "LIGHTER_NO_ACCOUNT", "VENUE_DATA_ONLY", "MARKET_NOT_EXECUTABLE", "BUILD_EXPIRED", "PAYLOAD_MISMATCH", "DUPLICATE_PAYLOAD", "VENUE_RATE_LIMITED", "VENUE_ERROR"];
const ADDED = ["FEE_FREE_UNAVAILABLE", "STALE_QUOTE", "DEPEG_FLAG", "LIGHTER_KEY_INDEX_EXHAUSTED", "ASTER_NONCE_EXPIRED", "X402_PAYMENT_REQUIRED", "X402_SETTLEMENT_PENDING", "X402_PAYMENTS_PAUSED", "X402_PAYMENTS_UNAVAILABLE", "AGENT_KILLED", "RETIRED_AGENT", "UNSUPPORTED_VENUE", "INVALID_INPUT", "UNAUTHORIZED"];

describe("errors", () => {
  test("shape", () => {
    for (const c of [...SPEC_13_1, ...ADDED]) expect(ERROR_CODE_LIST).toContain(c as never);
    for (const code of ERROR_CODE_LIST) {
      const s = httpStatus(code);
      expect(Number.isInteger(s) && s >= 400 && s < 600, code).toBe(true);
      const body = errorBody(code);
      expect(Object.keys(body)).toEqual(["error"]);
      expect(Object.keys(body.error)).toEqual(["code", "message"]);
      expect(body.error.code).toBe(code);
      expect(body.error.message.length).toBeGreaterThan(0);
      const withReceipt = errorBody(code, "m", "01RECEIPT");
      expect(withReceipt).toEqual({ error: { code, message: "m", receiptId: "01RECEIPT" } });
    }
    // refusals are 403 (spec 10)
    for (const c of ["GEO_REFUSED", "DECLARATION_MISSING", "VENUE_DATA_ONLY", "MARKET_NOT_EXECUTABLE", "POLICY_BREACH", "BUILDER_APPROVAL_REQUIRED"] as const) expect(ERROR_CODES[c].status).toBe(403);
    expect(ERROR_CODES.X402_PAYMENT_REQUIRED.status).toBe(402);
    // the x402 gate answers 503 when payments are paused or a route has no rail left
    expect(ERROR_CODES.X402_PAYMENTS_PAUSED.status).toBe(503);
    expect(ERROR_CODES.X402_PAYMENTS_UNAVAILABLE.status).toBe(503);
    expect(ERROR_CODES.VENUE_RATE_LIMITED.status).toBe(429);
    // region copy says "not available in your region" and stops there
    expect(ERROR_CODES.GEO_REFUSED.message).toBe("Not available in your region.");
  });

  test("CapstanError carries code, status and the body", () => {
    const e = new CapstanError("POLICY_BREACH", "maxLeverage", { receiptId: "01R", field: "maxLeverage" });
    expect(e.status).toBe(403);
    expect(e.field).toBe("maxLeverage");
    expect(e.toBody()).toEqual({ error: { code: "POLICY_BREACH", message: "maxLeverage", receiptId: "01R" } });
  });
});
