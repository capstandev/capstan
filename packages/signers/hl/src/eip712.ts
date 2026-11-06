// Minimal EIP-712 hasher for the flat structs Hyperliquid uses (string, bytes, bytes32, address, uint*, int*, bool).
// Written on its own so the tests can check it against an independent implementation. No nested struct types.
import type { Hex, TypedDataPayload } from "@capstan/schema";
import { concatBytes, fromHex, keccak, keccakHex, lowerAddress, uintBE, utf8ToBytes } from "./bytes";

export type TypedField = { name: string; type: string };

const DOMAIN_FIELDS: { key: "name" | "version" | "chainId" | "verifyingContract" | "salt"; type: string }[] = [
  { key: "name", type: "string" },
  { key: "version", type: "string" },
  { key: "chainId", type: "uint256" },
  { key: "verifyingContract", type: "address" },
  { key: "salt", type: "bytes32" },
];

/** The EIP712Domain field list implied by the keys present in a domain object, in the standard order. */
export function domainFields(domain: TypedDataPayload["domain"]): TypedField[] {
  return DOMAIN_FIELDS.filter((f) => domain[f.key] !== undefined).map((f) => ({ name: f.key, type: f.type }));
}

export function encodeType(primaryType: string, fields: TypedField[]): string {
  return `${primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

function toBigInt(v: unknown, field: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`eip712: ${field} is not a safe integer`);
    return BigInt(v);
  }
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|-?\d+)$/.test(v)) return BigInt(v);
  throw new Error(`eip712: ${field} is not an integer`);
}

function encodeValue(type: string, v: unknown, field: string): Uint8Array {
  if (type === "string") {
    if (typeof v !== "string") throw new Error(`eip712: ${field} must be a string`);
    return keccak(utf8ToBytes(v));
  }
  if (type === "bytes") {
    if (typeof v !== "string") throw new Error(`eip712: ${field} must be hex bytes`);
    return keccak(fromHex(v));
  }
  if (type === "address") {
    if (typeof v !== "string") throw new Error(`eip712: ${field} must be an address`);
    return concatBytes(new Uint8Array(12), fromHex(lowerAddress(v)));
  }
  if (type === "bool") {
    if (typeof v !== "boolean") throw new Error(`eip712: ${field} must be a boolean`);
    return uintBE(v ? 1 : 0, 32);
  }
  const fixed = /^bytes(\d+)$/.exec(type);
  if (fixed) {
    const n = Number(fixed[1]);
    if (typeof v !== "string") throw new Error(`eip712: ${field} must be hex`);
    const b = fromHex(v);
    if (n < 1 || n > 32 || b.length !== n) throw new Error(`eip712: ${field} must be ${n} bytes`);
    const out = new Uint8Array(32);
    out.set(b, 0);
    return out;
  }
  const uint = /^uint(\d+)$/.exec(type);
  if (uint) {
    const bits = Number(uint[1]);
    const x = toBigInt(v, field);
    if (x < 0n || x >= 1n << BigInt(bits)) throw new Error(`eip712: ${field} out of range for ${type}`);
    return uintBE(x, 32);
  }
  const int = /^int(\d+)$/.exec(type);
  if (int) {
    const bits = Number(int[1]);
    const x = toBigInt(v, field);
    const lim = 1n << BigInt(bits - 1);
    if (x < -lim || x >= lim) throw new Error(`eip712: ${field} out of range for ${type}`);
    return uintBE(x < 0n ? (1n << 256n) + x : x, 32);
  }
  throw new Error(`eip712: unsupported type ${type}`);
}

export function hashStruct(primaryType: string, fields: TypedField[], message: Record<string, unknown>): Uint8Array {
  const parts: Uint8Array[] = [keccak(utf8ToBytes(encodeType(primaryType, fields)))];
  for (const f of fields) {
    if (!(f.name in message)) throw new Error(`eip712: message is missing ${f.name}`);
    parts.push(encodeValue(f.type, message[f.name], f.name));
  }
  return keccak(concatBytes(...parts));
}

export function domainSeparator(domain: TypedDataPayload["domain"]): Uint8Array {
  return hashStruct("EIP712Domain", domainFields(domain), domain as Record<string, unknown>);
}

/** keccak256(0x1901 || domainSeparator || hashStruct(message)). */
export function hashTypedPayload(td: TypedDataPayload): Hex {
  const fields = td.types[td.primaryType];
  if (!fields) throw new Error(`eip712: no type list for ${td.primaryType}`);
  for (const f of fields) if (td.types[f.type]) throw new Error("eip712: nested struct types are not supported");
  return keccakHex(concatBytes(new Uint8Array([0x19, 0x01]), domainSeparator(td.domain), hashStruct(td.primaryType, fields, td.message)));
}
