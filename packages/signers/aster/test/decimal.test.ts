// R7 (todo 14): exponent forms never reach a fee field.
import { describe, expect, test } from "bun:test";
import { AsterSignError, decimalString, queryString } from "../src";

describe("aster decimals", () => {
  test("no-exponent", () => {
    for (const bad of ["1e-7", "1e-05", "2E-4", "0.0002e0", "-0.0002", "+0.0002", " 0.0002", "0.0002 ", ".0002", "0002", "0x1", "", "NaN", "Infinity"]) {
      expect(() => decimalString(bad)).toThrow(AsterSignError);
    }
    expect(() => decimalString(0.0002 as unknown as string)).toThrow(AsterSignError);
    for (const ok of ["0.0002", "0.0003", "0.001", "0", "70000", "0.00010000"]) expect(decimalString(ok)).toBe(ok);
    // the trap: JS prints small floats as exponents
    expect(String(0.0000001)).toBe("1e-7");
    // a float in any parameter is refused, so String(0.0002) can never be signed
    expect(() => queryString([["feeRate", 0.0002]])).toThrow(AsterSignError);
    expect(() => queryString([["maxFeeRate", 1e-7]])).toThrow(AsterSignError);
    expect(queryString([["feeRate", decimalString("0.0002")]])).toBe("feeRate=0.0002");
  });
});
