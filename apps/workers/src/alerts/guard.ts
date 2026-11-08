// Outbound URL guard for user webhooks (audit API-4, SSRF). A user webhook must never reach our own Redis, Postgres,
// cloud metadata, the relay or anything else private. Rules: https only, port 443 or 8443, no user or password in the
// URL, and the host must resolve to public unicast addresses only. The caller sends to the returned, checked IP with
// the original host name for TLS and the Host header (no second DNS lookup, so no rebinding) and follows no redirects.
import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export type GuardResult = { ok: true; ip: string; family: 4 | 6; host: string; port: number; path: string } | { ok: false; reason: string };
export type Resolver = (host: string) => Promise<string[]>;

export const ALLOWED_PORTS = [443, 8443] as const;
/** A webhook host's name lookup gets this long (R1-8-03): an attacker's resolver cannot hold a worker slot. */
export const LOOKUP_TIMEOUT_MS = 2000;

export const systemResolver: Resolver = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function v4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x)) return null;
    const v = Number(x);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
];

export function isPublicV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return false;
  for (const [base, bits] of V4_BLOCKS) {
    const b = v4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((b & mask) >>> 0)) return false;
  }
  return true;
}

/** Expand an IPv6 text form to 8 groups of 16 bits; null when it is not IPv6. */
export function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct); // zone id
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const n = v4ToInt(maybeV4);
    if (n === null) return null;
    tail = [n >>> 16, n & 0xffff];
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (parts.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const all = [...head, ...new Array(parts.length === 2 ? missing : 0).fill("0"), ...rest];
  if (all.length !== 8) return null;
  const out = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  if (out.some((x) => Number.isNaN(x))) return null;
  if (tail.length) {
    out[6] = tail[0]!;
    out[7] = tail[1]!;
  }
  return out;
}

export function isPublicV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return false;
  const [a, b] = [g[0]!, g[1]!];
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d: judge the embedded IPv4 address
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPublicV4(`${g[6]! >>> 8}.${g[6]! & 255}.${g[7]! >>> 8}.${g[7]! & 255}`);
  if (a === 0x64 && b === 0xff9b) return isPublicV4(`${g[6]! >>> 8}.${g[6]! & 255}.${g[7]! >>> 8}.${g[7]! & 255}`); // NAT64
  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x2002) return false; // 6to4 can embed private IPv4
  if (a === 0x2001 && b === 0) return false; // Teredo
  if (a === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard prefix
  return (a & 0xe000) === 0x2000; // global unicast 2000::/3 only
}

export function isPublicIp(ip: string): boolean {
  const k = isIP(ip.replace(/^\[|\]$/g, ""));
  if (k === 4) return isPublicV4(ip);
  if (k === 6) return isPublicV6(ip);
  return false;
}

export async function guardUrl(url: string, resolver: Resolver = systemResolver, o: { lookupTimeoutMs?: number } = {}): Promise<GuardResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "https only" };
  if (u.username || u.password || /@/.test(url.split("/")[2] ?? "")) return { ok: false, reason: "no user name or password in the URL" };
  const port = u.port === "" ? 443 : Number(u.port);
  if (!(ALLOWED_PORTS as readonly number[]).includes(port)) return { ok: false, reason: "port 443 or 8443 only" };
  const host = u.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return { ok: false, reason: "a private host name" };
  const literal = host.replace(/^\[|\]$/g, "");
  let addrs: string[];
  if (isIP(literal)) addrs = [literal];
  else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ms = Math.max(0, o.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS);
      addrs = await Promise.race([resolver(host), new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("lookup timeout")), ms)))]);
    } catch {
      return { ok: false, reason: "the host does not resolve" };
    } finally {
      clearTimeout(timer);
    }
  }
  if (!addrs.length) return { ok: false, reason: "the host does not resolve" };
  // every address the name has must be public, so a mixed answer cannot be used to reach a private one
  for (const a of addrs) if (!isPublicIp(a)) return { ok: false, reason: "the host resolves to a private, loopback, link-local or reserved address" };
  const ip = addrs[0]!;
  return { ok: true, ip, family: isIP(ip) === 6 ? 6 : 4, host, port, path: `${u.pathname}${u.search}` };
}
