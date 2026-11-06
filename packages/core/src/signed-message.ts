// The ONE EIP-191 text format for every owner or agent signature that is not venue typed data or a Capstan EIP-712
// type (reads, API requests, WS subscribes, kills, spread acks, API key creation, webhook registration).
// Purpose, host, chain id, nonce and expiry are always in the signed text, and the verifier checks the purpose, so a
// signature made for one purpose never works for another.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Hex } from "@capstan/schema";
import { bytesToHex, hashMessage, hexToBytes, stringToBytes } from "viem";
import { publicKeyToAddress } from "viem/accounts";

export const SIGNED_PURPOSES = ["api_request", "read", "ws_subscribe", "kill", "spread_ack", "api_key_create", "webhook_register"] as const;
export type SignedPurpose = (typeof SIGNED_PURPOSES)[number];

/** Longest allowed gap between issued and expires. spread_ack is bound to its plan id (in the body) and may live longer. */
export const MAX_VALIDITY_MS = 5 * 60 * 1000;
export const MAX_SPREAD_ACK_VALIDITY_MS = 24 * 60 * 60 * 1000;
/** Clock skew tolerated for an issued time in the future. */
export const MAX_FUTURE_SKEW_MS = 30 * 1000;

export interface CapstanMessageFields {
  purpose: SignedPurpose;
  owner: Hex;
  host: string;
  chainId: number;
  nonce: string;
  issuedAt: number; // ms
  expiresAt: number; // ms
  body?: string;
}

export function bodyHash(body: string | undefined): string {
  return body === undefined || body === "" ? "-" : bytesToHex(sha256(stringToBytes(body))).slice(2);
}

const NONCE_RE = /^[A-Za-z0-9_-]{8,80}$/;
const HOST_RE = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/;

export function capstanMessage(m: CapstanMessageFields): string {
  if (!SIGNED_PURPOSES.includes(m.purpose)) throw new Error("capstanMessage: unknown purpose");
  if (!/^0x[0-9a-fA-F]{40}$/.test(m.owner)) throw new Error("capstanMessage: owner must be an address");
  if (!HOST_RE.test(m.host)) throw new Error("capstanMessage: host must be a lowercase host name");
  if (!NONCE_RE.test(m.nonce)) throw new Error("capstanMessage: nonce must be 8 to 80 url-safe characters");
  if (!Number.isSafeInteger(m.chainId) || m.chainId <= 0) throw new Error("capstanMessage: bad chain id");
  if (!Number.isSafeInteger(m.issuedAt) || !Number.isSafeInteger(m.expiresAt) || m.expiresAt <= m.issuedAt) throw new Error("capstanMessage: bad times");
  return [
    `Capstan ${m.purpose}`,
    `owner: ${m.owner.toLowerCase()}`,
    `host: ${m.host}`,
    `chain: ${m.chainId}`,
    `nonce: ${m.nonce}`,
    `issued: ${new Date(m.issuedAt).toISOString()}`,
    `expires: ${new Date(m.expiresAt).toISOString()}`,
    `body: ${bodyHash(m.body)}`,
  ].join("\n");
}

const LINE_RES = [
  /^Capstan ([a-z_]+)$/,
  /^owner: (0x[0-9a-f]{40})$/,
  /^host: (\S+)$/,
  /^chain: (\d{1,12})$/,
  /^nonce: ([A-Za-z0-9_-]{8,80})$/,
  /^issued: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/,
  /^expires: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/,
  /^body: (-|[0-9a-f]{64})$/,
];

export type ParsedCapstanMessage = Omit<CapstanMessageFields, "body"> & { bodyHash: string };

/** Strict parse: exactly eight lines in the fixed order, or null. */
export function parseCapstanMessage(text: string): ParsedCapstanMessage | null {
  const lines = text.split("\n");
  if (lines.length !== LINE_RES.length) return null;
  const v: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RES[i]!.exec(lines[i]!);
    if (!m) return null;
    v.push(m[1]!);
  }
  const purpose = v[0] as SignedPurpose;
  if (!SIGNED_PURPOSES.includes(purpose)) return null;
  const issuedAt = Date.parse(v[5]!);
  const expiresAt = Date.parse(v[6]!);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;
  return { purpose, owner: v[1] as Hex, host: v[2]!, chainId: Number(v[3]), nonce: v[4]!, issuedAt, expiresAt, bodyHash: v[7]! };
}

/** Recover the EIP-191 signer of a text message, or null for a malformed signature. Synchronous. */
export function recoverPersonalSigner(text: string, sig: Hex): Hex | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return null;
  try {
    const raw = hexToBytes(sig);
    let v = raw[64]!;
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;
    const rec = new Uint8Array(65);
    rec[0] = v;
    rec.set(raw.slice(0, 64), 1);
    const digest = hexToBytes(hashMessage(text));
    const pub = secp256k1.recoverPublicKey(rec, digest, { prehash: false });
    const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
    return publicKeyToAddress(bytesToHex(uncompressed));
  } catch {
    return null;
  }
}

export type VerifyFailure = "purpose" | "signer" | "host" | "expired" | "replay" | "signature" | "chain" | "body" | "format";

export interface NonceStore {
  /** Returns true when the nonce was seen before; otherwise records it and returns false (atomic). */
  seen(nonce: string): Promise<boolean>;
}

export async function verifyCapstanMessage(
  text: string,
  sig: Hex,
  expect: { purpose: SignedPurpose; signers: Hex[]; host: string; nowMs: number; chainId?: number; body?: string },
  nonces: NonceStore,
): Promise<{ ok: true; signer: Hex; message: ParsedCapstanMessage } | { ok: false; reason: VerifyFailure }> {
  const m = parseCapstanMessage(text);
  if (!m) return { ok: false, reason: "format" };
  if (m.purpose !== expect.purpose) return { ok: false, reason: "purpose" };
  if (m.host !== expect.host) return { ok: false, reason: "host" };
  if (expect.chainId !== undefined && m.chainId !== expect.chainId) return { ok: false, reason: "chain" };
  if (expect.body !== undefined && m.bodyHash !== bodyHash(expect.body)) return { ok: false, reason: "body" };
  const signer = recoverPersonalSigner(text, sig);
  if (!signer) return { ok: false, reason: "signature" };
  const allowed = expect.signers.map((s) => s.toLowerCase());
  if (!allowed.includes(signer.toLowerCase())) return { ok: false, reason: "signer" };
  const maxValidity = m.purpose === "spread_ack" ? MAX_SPREAD_ACK_VALIDITY_MS : MAX_VALIDITY_MS;
  if (m.expiresAt - m.issuedAt > maxValidity) return { ok: false, reason: "expired" };
  if (expect.nowMs >= m.expiresAt || m.issuedAt > expect.nowMs + MAX_FUTURE_SKEW_MS) return { ok: false, reason: "expired" };
  // last, so a bad message never burns a nonce
  if (await nonces.seen(`${m.purpose}:${m.owner}:${m.nonce}`)) return { ok: false, reason: "replay" };
  return { ok: true, signer, message: m };
}

/** In-memory nonce store (tests, single process). Production uses redisNonceStore (SET NX with expiry). */
export function memoryNonceStore(): NonceStore {
  const s = new Set<string>();
  return {
    async seen(n) {
      if (s.has(n)) return true;
      s.add(n);
      return false;
    },
  };
}
