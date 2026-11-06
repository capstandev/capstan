// RFC 8785 (JCS) canonical JSON for quote snapshots, and the sha256 hash the quote returns as receiptHint.
// Keys sort by UTF-16 code units; numbers use the ECMAScript form (JSON.stringify); non-JSON values are refused.
// The receipts package carries the full receipt JCS; this local copy covers quote bodies only.
import { createHash } from "node:crypto";

export function jcs(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new TypeError("jcs: non-finite number");
      return JSON.stringify(v === 0 ? 0 : v);
    case "string":
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x) => jcs(x)).join(",")}]`;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("jcs: only plain objects");
      const keys = Object.keys(v as object)
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs((v as Record<string, unknown>)[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`jcs: ${typeof v} is not JSON`);
  }
}

export function sha256Hex(s: string): `0x${string}` {
  return `0x${createHash("sha256").update(s, "utf8").digest("hex")}`;
}

export function quoteHash(body: unknown): `0x${string}` {
  return sha256Hex(jcs(body));
}
