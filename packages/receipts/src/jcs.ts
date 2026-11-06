// RFC 8785 JSON Canonicalization Scheme. The canonicalize package does the serialisation; this wrapper first refuses
// every value that has no exact JSON form, because canonicalize (like JSON.stringify) silently drops undefined.
// Receipts keep amounts as decimal strings, so a bigint here is always a bug.
import canonicalize from "canonicalize";

export class JcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JcsError";
  }
}

function assertJson(value: unknown, path: string, seen: Set<object>): void {
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new JcsError(`jcs: non-finite number at ${path}`);
      return;
    case "bigint":
      throw new JcsError(`jcs: bigint at ${path} (use a decimal string)`);
    case "undefined":
      throw new JcsError(`jcs: undefined at ${path}`);
    case "function":
    case "symbol":
      throw new JcsError(`jcs: ${typeof value} at ${path}`);
    case "object": {
      if (value === null) return;
      if (seen.has(value)) throw new JcsError(`jcs: circular reference at ${path}`);
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((v, i) => assertJson(v, `${path}[${i}]`, seen));
      } else {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) throw new JcsError(`jcs: non-plain object at ${path}`);
        for (const [k, v] of Object.entries(value)) assertJson(v, `${path}.${k}`, seen);
      }
      seen.delete(value);
      return;
    }
  }
}

/** Canonical JSON text of `value` (RFC 8785). Throws JcsError on NaN, Infinity, undefined, bigint and non-plain objects. */
export function jcs(value: unknown): string {
  assertJson(value, "$", new Set());
  const out = canonicalize(value);
  if (out === undefined) throw new JcsError("jcs: value has no JSON form");
  return out;
}
