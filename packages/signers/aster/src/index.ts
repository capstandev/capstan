// @capstan/signer-aster: Aster V3 signing (venue-aster.md section 4). Two EIP-712 modes share one domain name and an
// all-zero verifying contract:
//   Mode B (trading and user-data requests): the agent key signs Message(string msg), msg = the exact query string
//     sent (insertion order, key=String(value), joined by &, not sorted, not URL-encoded). Chain id 1666 (testnet 714).
//   Mode A (approve/update/delete agent and builder): the MAIN wallet signs a dynamic struct whose fields are the
//     request params with the first letter upper-cased; field types follow the JS value (bool -> bool, integer ->
//     uint256, everything else -> string). Chain id 56, and the request carries signatureChainId=56.
// This package is stateless: it never holds, loads or stores a key. Signing goes through a callback (or a viem
// account the caller owns). Fee rates are decimal strings only: String(0.0000001) is "1e-7", which breaks the
// signed string, so floats are refused everywhere.
import type { Hex, TypedDataPayload } from "@capstan/schema";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hashTypedData, hexToBytes, keccak256, recoverAddress, stringToBytes } from "viem";
import { publicKeyToAddress } from "viem/accounts";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const ASTER_MGMT_CHAIN_ID = 56 as const;
export type AsterTradeChainId = 1666 | 714;

export const ASTER_DOMAIN = (chainId: 1666 | 714 | 56) =>
  ({ name: "AsterSignTransaction", version: "1", chainId, verifyingContract: ZERO_ADDRESS }) as const;

export type ParamValue = string | number | boolean | bigint;
export type Param = [string, ParamValue];
export type AsterMgmtType = "ApproveAgent" | "UpdateAgent" | "DelAgent" | "ApproveBuilder" | "UpdateBuilder" | "DelBuilder";
export const ASTER_MGMT_TYPES: readonly AsterMgmtType[] = ["ApproveAgent", "UpdateAgent", "DelAgent", "ApproveBuilder", "UpdateBuilder", "DelBuilder"];

export class AsterSignError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "AsterSignError";
    if (field) this.field = field;
  }
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;

function valueString(k: string, v: ParamValue): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") {
    if (v < 0n) throw new AsterSignError(`${k}: negative integer`, k);
    return v.toString();
  }
  if (typeof v === "number") {
    // only safe integers: any float could print as an exponent and break the signed string
    if (!Number.isSafeInteger(v)) throw new AsterSignError(`${k}: numbers must be safe integers; send decimals as strings`, k);
    return String(v);
  }
  if (typeof v !== "string") throw new AsterSignError(`${k}: unsupported value type`, k);
  if (/[&=]/.test(v)) throw new AsterSignError(`${k}: value may not contain & or =`, k);
  return v;
}

/** key=String(value) in insertion order, joined by &. Not sorted, not URL-encoded. Keys must be unique. */
export function queryString(params: readonly (readonly [string, ParamValue])[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const [k, v] of params) {
    if (!KEY_RE.test(k)) throw new AsterSignError(`bad parameter name ${JSON.stringify(k)}`, k);
    if (seen.has(k)) throw new AsterSignError(`duplicate parameter ${k}`, k);
    seen.add(k);
    parts.push(`${k}=${valueString(k, v)}`);
  }
  return parts.join("&");
}

/** Parse a query string back into ordered pairs (values stay strings). Used to compare a sent string with a build. */
export function parseQuery(qs: string): [string, string][] {
  if (qs === "") return [];
  return qs.split("&").map((p) => {
    const i = p.indexOf("=");
    if (i <= 0) throw new AsterSignError(`malformed query part ${JSON.stringify(p.slice(0, 40))}`);
    return [p.slice(0, i), p.slice(i + 1)];
  });
}

/** A non-negative plain decimal string. Refuses exponent forms (1e-7, 1e-05), signs, spaces and non-strings. */
export function decimalString(x: string): string {
  if (typeof x !== "string") throw new AsterSignError("decimal must be a string, never a number");
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(x)) throw new AsterSignError(`not a plain decimal string: ${JSON.stringify(x).slice(0, 30)}`);
  return x;
}

// ---------------------------------------------------------------- Mode B
const MESSAGE_TYPES = { Message: [{ name: "msg", type: "string" }] } as const;

export function tradeTypedData(msg: string, chainId: AsterTradeChainId): TypedDataPayload {
  if (chainId !== 1666 && chainId !== 714) throw new AsterSignError(`trade chain id must be 1666 or 714, got ${String(chainId)}`);
  return { domain: { ...ASTER_DOMAIN(chainId) }, types: { Message: [{ name: "msg", type: "string" }] }, primaryType: "Message", message: { msg } };
}

export function digestTrade(msg: string, chainId: AsterTradeChainId): Hex {
  tradeTypedData(msg, chainId);
  return hashTypedData({ domain: ASTER_DOMAIN(chainId), types: MESSAGE_TYPES, primaryType: "Message", message: { msg } });
}

// ---------------------------------------------------------------- Mode A
export function upperFirst(k: string): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/** Field type from the JS value, as the venue rebuilds it: bool, integer -> uint256, anything else -> string. */
export function fieldType(v: ParamValue): "bool" | "uint256" | "string" {
  if (typeof v === "boolean") return "bool";
  if (typeof v === "bigint") return "uint256";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw new AsterSignError("numbers must be non-negative safe integers; send decimals as strings");
    return "uint256";
  }
  return "string";
}

export function mgmtTypedData(primaryType: AsterMgmtType, params: readonly (readonly [string, ParamValue])[]): TypedDataPayload {
  if (!ASTER_MGMT_TYPES.includes(primaryType)) throw new AsterSignError(`unknown management type ${String(primaryType)}`);
  queryString(params); // same key and value rules as the sent query
  const fields: { name: string; type: string }[] = [];
  const message: Record<string, unknown> = {};
  for (const [k, v] of params) {
    const name = upperFirst(k);
    if (name in message) throw new AsterSignError(`duplicate field ${name}`, k);
    const type = fieldType(v);
    fields.push({ name, type });
    message[name] = v; // numbers stay numbers (JSON-safe bundles); viem encodes number and bigint alike
  }
  return { domain: { ...ASTER_DOMAIN(ASTER_MGMT_CHAIN_ID) }, types: { [primaryType]: fields }, primaryType, message };
}

/** The EIP-712 type string, e.g. ApproveBuilder(string Builder,...,uint256 Nonce). */
export function mgmtTypeString(td: TypedDataPayload): string {
  const fields = td.types[td.primaryType]!;
  return `${td.primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

export function digestMgmt(primaryType: AsterMgmtType, params: readonly (readonly [string, ParamValue])[]): Hex {
  return digestTypedData(mgmtTypedData(primaryType, params));
}

/** Digest of a typed-data payload this package built (either mode). */
export function digestTypedData(td: TypedDataPayload): Hex {
  const types = Object.fromEntries(Object.entries(td.types).filter(([k]) => k !== "EIP712Domain"));
  return hashTypedData({ domain: td.domain as Parameters<typeof hashTypedData>[0]["domain"], types, primaryType: td.primaryType, message: td.message } as Parameters<typeof hashTypedData>[0]);
}

// ---------------------------------------------------------------- nonce
export const NONCE_WINDOW_US = 60_000_000n;

/** Microsecond nonce for ONE signer: max(now_us, last + 1). Strictly increasing; refuses a value outside the window. */
export class AsterNonce {
  private last = -1n;
  next(nowUs: bigint, serverTimeUs?: bigint): bigint {
    if (typeof nowUs !== "bigint" || nowUs <= 0n) throw new AsterSignError("nonce clock must be a positive bigint of microseconds");
    const n = nowUs > this.last ? nowUs : this.last + 1n;
    assertNonceWindow(n, serverTimeUs ?? nowUs);
    this.last = n;
    return n;
  }
  peek(): bigint | null {
    return this.last < 0n ? null : this.last;
  }
}

/** The venue accepts nonces within 60 s either side of its time. Checked before signing. */
export function assertNonceWindow(nonce: bigint, serverTimeUs: bigint): void {
  const d = nonce > serverTimeUs ? nonce - serverTimeUs : serverTimeUs - nonce;
  if (d > NONCE_WINDOW_US) throw new AsterSignError(`nonce is ${d / 1000n} ms from server time (window 60 s)`, "nonce");
}

// ---------------------------------------------------------------- signing (stateless)
/** Signs a 32-byte digest and returns a 65-byte signature (v 27/28). Provided by the caller; never a key. */
export type DigestSigner = (digest: Hex) => Promise<Hex>;

/** Wrap a viem account the caller owns. */
export function accountSigner(account: { sign: (a: { hash: Hex }) => Promise<Hex> }): DigestSigner {
  return (digest) => account.sign({ hash: digest });
}

export interface SignedTrade {
  query: string; // the signed string, exactly as sent
  signature: Hex;
  sent: string; // `${query}&signature=${signature}`
}

export async function signTrade(params: readonly (readonly [string, ParamValue])[], chainId: AsterTradeChainId, sign: DigestSigner): Promise<SignedTrade> {
  const query = queryString(params);
  const signature = await sign(digestTrade(query, chainId));
  return { query, signature, sent: `${query}&signature=${signature}` };
}

export interface SignedMgmt {
  params: [string, ParamValue][];
  signature: Hex;
  sent: string; // params, then signature and signatureChainId=56
}

export function mgmtSentQuery(params: readonly (readonly [string, ParamValue])[], signature: Hex): string {
  return queryString([...params, ["signature", signature], ["signatureChainId", ASTER_MGMT_CHAIN_ID]]);
}

export async function signMgmt(primaryType: AsterMgmtType, params: readonly (readonly [string, ParamValue])[], sign: DigestSigner): Promise<SignedMgmt> {
  const signature = await sign(digestMgmt(primaryType, params));
  return { params: params.map(([k, v]) => [k, v] as [string, ParamValue]), signature, sent: mgmtSentQuery(params, signature) };
}

export async function recoverSigner(digest: Hex, signature: Hex): Promise<Hex> {
  return (await recoverAddress({ hash: digest, signature })) as Hex;
}

/** Synchronous recovery (verifySigned must not await). Null for a malformed signature. */
export function recoverDigestSigner(digest: Hex, signature: Hex | string): Hex | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || !/^0x[0-9a-fA-F]{64}$/.test(digest)) return null;
  try {
    const raw = hexToBytes(signature as Hex);
    let v = raw[64]!;
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;
    const rec = new Uint8Array(65);
    rec[0] = v;
    rec.set(raw.slice(0, 64), 1);
    const pub = secp256k1.recoverPublicKey(rec, hexToBytes(digest), { prehash: false });
    return publicKeyToAddress(bytesToHex(secp256k1.Point.fromBytes(pub).toBytes(false)));
  } catch {
    return null;
  }
}

/** Hash of the exact signed query string (envelope payloadHash, relay dedupe key). */
export function payloadHashOf(signedQuery: string): Hex {
  return keccak256(stringToBytes(signedQuery));
}

export const PACKAGE_NAME = "@capstan/signer-aster" as const;
