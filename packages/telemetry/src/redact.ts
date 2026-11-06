// Log redaction (spec 14): logs carry no payload signature in plaintext, only its hash, and no raw IP address beyond
// 7 days (the log-retention job reduces older records to the country code).
//
// redact(record):
//   - a field whose name says signature (sig, sigs, signature, signatures, ownerSig, ackSig, signedPayload, r/s pairs
//     inside a `signature` object) becomes `<name>_sha256` = base64url(sha256(value)). Base64url has no 64-hex run, so
//     the hash itself can never look like a key or a raw signature to the scanners.
//   - any other string: every run of 64 or more hex digits (a key-length or signature-length hex) is replaced with
//     `hex_sha256:<base64url>` of that run.
//   - secrets by name (password, token, authorization, cookie, apiKey, secret, privateKey, mnemonic, seed) become
//     "[redacted]" and are never hashed (a hash of a short secret can be brute forced).
//   - `ip` fields are kept as they are: the raw store keeps them 7 days (see stripIps for the retention rewrite).
import { createHash } from "node:crypto";
import { isIP } from "node:net";

const SIG_KEY = /^(sig|sigs|signature|signatures|[a-z0-9_]*(sig|signature)s?|signedpayload|signed_payload|signedbody|signed_body)$/i;
const SECRET_KEY = /^(password|passphrase|token|tokens|authorization|cookie|.*(apikey|api_key|secret|privatekey|private_key|mnemonic|seed|password|bottoken|bot_token).*)$/i;
const LONG_HEX = /(0x)?[0-9a-fA-F]{64,}/g;
export const REDACTED = "[redacted]";

export function b64sha256(v: string | Uint8Array): string {
  return createHash("sha256").update(v).digest("base64url");
}

function hashValue(v: unknown): string {
  if (v instanceof Uint8Array) return b64sha256(v);
  return b64sha256(typeof v === "string" ? v : JSON.stringify(v) ?? "");
}

export function scrubHex(s: string): string {
  return s.replace(LONG_HEX, (m) => `hex_sha256:${b64sha256(m.toLowerCase())}`);
}

function walk(value: unknown, depth: number): unknown {
  if (depth > 10) return "[depth]";
  if (typeof value === "string") return scrubHex(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: scrubHex(value.message) };
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) out[k] = REDACTED;
      else if (SIG_KEY.test(k)) {
        if (v !== null && v !== undefined) out[`${k}_sha256`] = hashValue(v);
      } else out[k] = walk(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Deep copy of a log record with signatures hashed, long hex scrubbed and secrets dropped. */
export function redact(record: Record<string, unknown>): Record<string, unknown> {
  return walk(record, 0) as Record<string, unknown>;
}

// ---- IP handling for the retention rewrite ----

const IP_KEY = /^(ip|ips|ip_address|ipaddress|client_ip|clientip|remote_addr|remoteaddr|remote_ip|x_forwarded_for|x-forwarded-for|forwarded_for|cf-connecting-ip|x-real-ip|real_ip)$/i;
const IP_TOKEN = /[0-9a-fA-F:.]{3,}/g;

/** True when the string holds an IPv4 or IPv6 literal anywhere (net.isIP on every candidate token). */
export function containsIp(s: string): boolean {
  for (const m of s.matchAll(IP_TOKEN)) if (isIP(trimDots(m[0]))) return true;
  return false;
}

function trimDots(t: string): string {
  return t.replace(/^[.:]+|[.]+$/g, (x) => (x.includes("::") ? x : ""));
}

function scrubIpText(s: string): string {
  return s.replace(IP_TOKEN, (t) => (isIP(trimDots(t)) ? t.replace(trimDots(t), "[ip]") : t));
}

/**
 * Remove every raw IP from a record, keeping (or adding) `ip_country`. `country` maps an IP to an ISO code (the
 * eligibility geo DB in production); unknown gives "ZZ" (ISO user-assigned "unknown").
 */
export function stripIps(record: Record<string, unknown>, country: (ip: string) => string | null = () => null): Record<string, unknown> {
  let firstIp: string | null = null;
  const go = (v: unknown, depth: number): unknown => {
    if (depth > 10) return "[depth]";
    if (typeof v === "string") return scrubIpText(v);
    if (Array.isArray(v)) return v.map((x) => go(x, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (IP_KEY.test(k)) {
          if (firstIp === null && typeof x === "string" && x) firstIp = x.split(",")[0]!.trim();
          continue;
        }
        out[k] = go(x, depth + 1);
      }
      return out;
    }
    return v;
  };
  const out = go(record, 0) as Record<string, unknown>;
  if (firstIp !== null && (out.ip_country === undefined || out.ip_country === null)) out.ip_country = country(firstIp) ?? "ZZ";
  return out;
}
