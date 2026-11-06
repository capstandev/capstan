import { describe, expect, test } from "bun:test";
import { jcs, JcsError } from "../src";

describe("jcs", () => {
  test("rfc8785", () => {
    // RFC 8785 section 3.2.2.3 number vector and appendix B examples.
    expect(jcs([333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001, -0, 1e21, 100000000000000000000])).toBe(
      "[333333333.3333333,1e+30,4.5,0.002,1e-27,0,1e+21,100000000000000000000]",
    );
    // RFC 8785 section 3.2.3: keys sorted by UTF-16 code units.
    const obj = { "€": "Euro Sign", "\r": "Carriage Return", "דּ": "Hebrew Letter Dalet With Dagesh", "1": "One", "😀": "Emoji: Grinning Face", "\u0080": "Control", "ö": "Latin Small Letter O With Diaeresis" };
    const out = jcs(obj);
    const keys = Object.keys(JSON.parse(out));
    // JSON.parse puts the integer-like key first; read the order from the text instead.
    const order = [...out.matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => JSON.parse(`"${m[1]}"`));
    expect(order).toEqual(["\r", "1", "\u0080", "ö", "€", "😀", "דּ"]);
    expect(keys.length).toBe(7);
    // RFC 8785 section 3.2.4 example structure (string built from code points to keep the escapes readable).
    const str = ["\u20ac", "$", String.fromCharCode(0x0f), "\n", "A'B", '"', "\\", "\\", '"', "/"].join("");
    const want = ['{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"', "\u20ac$", "\\u000f", "\\n", "A'B", '\\"', "\\\\", "\\\\", '\\"', "/", '"}'].join("");
    expect(jcs({ numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001], string: str, literals: [null, true, false] })).toBe(want);
  });

  test("rejects-non-json", () => {
    expect(() => jcs({ a: Number.NaN })).toThrow(JcsError);
    expect(() => jcs({ a: Number.POSITIVE_INFINITY })).toThrow(JcsError);
    expect(() => jcs([Number.NEGATIVE_INFINITY])).toThrow(JcsError);
    expect(() => jcs({ a: undefined })).toThrow(JcsError);
    expect(() => jcs([undefined])).toThrow(JcsError);
    expect(() => jcs({ amount: 10n })).toThrow(/bigint/);
    expect(() => jcs({ d: new Date(0) })).toThrow(/non-plain/);
    expect(() => jcs({ f: () => 1 })).toThrow(JcsError);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => jcs(cyc)).toThrow(/circular/);
    // amounts as strings are fine
    expect(jcs({ amount: "10.5" })).toBe('{"amount":"10.5"}');
  });
});
