// IP to country from the DB-IP Lite country file (CC BY 4.0, monthly, no account). The CSV form is
// `ip_start,ip_end,country` with IPv4 rows first, then IPv6, sorted by start. Lookups are a binary search over typed
// arrays. Unknown, private and reserved ranges ("ZZ") answer null, and the decision engine refuses writes on null.
import { readFileSync, statSync } from "node:fs";

export interface GeoLookup {
  /** ISO 3166-1 alpha-2 country, upper case, or null when unknown. */
  country(ip: string): string | null;
  /** ISO 3166-2 region when a region source exists (DB-IP Lite has none). */
  region?(ip: string): string | null;
}

export interface GeoStats {
  v4Ranges: number;
  v6Ranges: number;
  malformed: number;
}

export function parseIpv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** IPv6 as a 128-bit bigint. Accepts `::` compression and a trailing dotted IPv4 part. */
export function parseIpv6(s: string): bigint | null {
  let str = s;
  const zone = str.indexOf("%");
  if (zone >= 0) str = str.slice(0, zone);
  if (!/^[0-9a-fA-F:.]+$/.test(str)) return null;
  if (str.includes(".")) {
    const lastColon = str.lastIndexOf(":");
    if (lastColon < 0) return null;
    const v4 = parseIpv4(str.slice(lastColon + 1));
    if (v4 === null) return null;
    str = `${str.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const tail: number[] = [];
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const group = (h: string): number[] | null => {
    if (h === "") return [];
    const out: number[] = [];
    for (const g of h.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = group(halves[0]!);
  const rest = halves.length === 2 ? group(halves[1]!) : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length + tail.length;
  let groups: number[];
  if (halves.length === 2) {
    if (known > 7) return null;
    groups = [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
  } else {
    groups = [...head, ...tail];
    if (groups.length !== 8) return null;
  }
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(g);
  return n;
}

const V4_MAPPED_PREFIX = 0xffffn << 32n;
const MASK64 = (1n << 64n) - 1n;

/** A lookup over parsed CSV text. Rows out of order or malformed are counted and skipped. */
export function parseDbIpCsv(text: string): GeoLookup & { stats: GeoStats } {
  const codes: string[] = [];
  const codeIdx = new Map<string, number>();
  const idx = (c: string) => {
    let i = codeIdx.get(c);
    if (i === undefined) {
      i = codes.length;
      codes.push(c);
      codeIdx.set(c, i);
    }
    return i;
  };
  const v4s: number[] = [];
  const v4e: number[] = [];
  const v4c: number[] = [];
  const v6s: bigint[] = [];
  const v6e: bigint[] = [];
  const v6c: number[] = [];
  let malformed = 0;
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = text.length;
    const line = text.slice(pos, nl).trim();
    pos = nl + 1;
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 3) {
      malformed++;
      continue;
    }
    const [a, b, cRaw] = parts as [string, string, string];
    const c = cRaw.replace(/"/g, "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) {
      malformed++;
      continue;
    }
    if (a.includes(":")) {
      const s = parseIpv6(a);
      const e = parseIpv6(b);
      if (s === null || e === null || e < s || (v6e.length > 0 && s <= v6e[v6e.length - 1]!)) {
        malformed++;
        continue;
      }
      v6s.push(s);
      v6e.push(e);
      v6c.push(idx(c));
    } else {
      const s = parseIpv4(a);
      const e = parseIpv4(b);
      if (s === null || e === null || e < s || (v4e.length > 0 && s <= v4e[v4e.length - 1]!)) {
        malformed++;
        continue;
      }
      v4s.push(s);
      v4e.push(e);
      v4c.push(idx(c));
    }
  }
  const S4 = Uint32Array.from(v4s);
  const E4 = Uint32Array.from(v4e);
  const C4 = Uint16Array.from(v4c);
  const S6h = BigUint64Array.from(v6s.map((x) => x >> 64n));
  const S6l = BigUint64Array.from(v6s.map((x) => x & MASK64));
  const E6 = v6e;
  const C6 = Uint16Array.from(v6c);

  const answer = (code: string | undefined): string | null => (code === undefined || code === "ZZ" ? null : code);

  function find4(n: number): string | null {
    let lo = 0;
    let hi = S4.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (S4[mid]! <= n) lo = mid + 1;
      else hi = mid - 1;
    }
    if (hi < 0 || n > E4[hi]!) return null;
    return answer(codes[C4[hi]!]);
  }

  function find6(n: bigint): string | null {
    let lo = 0;
    let hi = S6h.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const s = (S6h[mid]! << 64n) | S6l[mid]!;
      if (s <= n) lo = mid + 1;
      else hi = mid - 1;
    }
    if (hi < 0 || n > E6[hi]!) return null;
    return answer(codes[C6[hi]!]);
  }

  return {
    stats: { v4Ranges: S4.length, v6Ranges: S6h.length, malformed },
    country(ip: string): string | null {
      if (typeof ip !== "string" || ip.length === 0 || ip.length > 64) return null;
      const raw = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
      if (!raw.includes(":")) {
        const n = parseIpv4(raw);
        return n === null ? null : find4(n);
      }
      const n = parseIpv6(raw);
      if (n === null) return null;
      if (n >> 32n === V4_MAPPED_PREFIX >> 32n) return find4(Number(n & 0xffffffffn));
      return find6(n);
    },
  };
}

/** Load a DB-IP Lite country CSV (`.csv` or `.csv.gz`). */
export function loadDbIpLite(path: string): GeoLookup & { stats: GeoStats } {
  const buf = readFileSync(path);
  const bytes = path.endsWith(".gz") ? Bun.gunzipSync(new Uint8Array(buf)) : buf;
  return parseDbIpCsv(new TextDecoder().decode(bytes));
}

/** Fixed table for tests and local runs. */
export function staticGeo(map: Record<string, string | null>): GeoLookup {
  return { country: (ip) => map[ip] ?? null };
}

/**
 * A lookup over a file the refresh job replaces atomically. The file's mtime is checked at most every `checkEveryMs`
 * and the table reloads when it changes. A missing or unreadable file answers null for every IP, so writes are refused
 * until a good file is in place (fail closed).
 */
export function fileGeo(path: string, opts: { checkEveryMs?: number; now?: () => number; onError?: (e: Error) => void } = {}): GeoLookup & { loaded(): boolean } {
  const every = opts.checkEveryMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  let table: GeoLookup | null = null;
  let mtime = -1;
  let checked = -Infinity;
  const refresh = () => {
    const t = now();
    if (t - checked < every) return;
    checked = t;
    try {
      const m = statSync(path).mtimeMs;
      if (m !== mtime) {
        table = loadDbIpLite(path);
        mtime = m;
      }
    } catch (e) {
      if (table === null) opts.onError?.(e as Error);
    }
  };
  return {
    country(ip) {
      refresh();
      return table ? table.country(ip) : null;
    },
    loaded() {
      refresh();
      return table !== null;
    },
  };
}
