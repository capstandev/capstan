// DB-IP Lite country refresh. DB-IP publishes one free file a month (no account, CC BY 4.0):
//   https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.csv.gz
// The job runs weekly: it fetches the current month's file once it exists (else keeps the previous one), checks it
// parses into a sane table, logs its sha256, and swaps it in with an atomic rename. The api's fileGeo reloads on the
// new mtime. A failed refresh keeps the old file.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDbIpCsv } from "./geo";

export const DBIP_BASE_URL = "https://download.db-ip.com/free";
export const GEO_FILE = "dbip-country-lite.csv.gz";
export const GEO_META = "dbip-country-lite.meta.json";
export const GEO_ATTRIBUTION = "IP geolocation by DB-IP (https://db-ip.com), licensed under CC BY 4.0." as const;

export interface GeoMeta {
  month: string; // YYYY-MM of the file in place
  sha256: string;
  bytes: number;
  v4Ranges: number;
  v6Ranges: number;
  fetchedAt: string;
}

export interface RefreshOptions {
  dir: string;
  now: () => Date;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  maxBytes?: number; // compressed size cap, default 64 MB
  minRanges?: number; // sanity floor on IPv4 ranges, default 100,000
}

export type RefreshStatus = "current" | "updated" | "unchanged" | "not_published" | "failed";
export interface RefreshResult {
  status: RefreshStatus;
  month: string | null;
  sha256: string | null;
  reason?: string;
}

export const monthOf = (d: Date): string => d.toISOString().slice(0, 7);
export function previousMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
}
export const dbIpUrl = (month: string, base = DBIP_BASE_URL): string => `${base}/dbip-country-lite-${month}.csv.gz`;

export function readGeoMeta(dir: string): GeoMeta | null {
  try {
    return JSON.parse(readFileSync(join(dir, GEO_META), "utf8")) as GeoMeta;
  } catch {
    return null;
  }
}

function atomicWrite(dir: string, name: string, data: Uint8Array | string): void {
  const tmp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, data);
  // public data that other services read: 0644 whatever the writer's umask (the workers unit runs with UMask=0077)
  chmodSync(tmp, 0o644);
  renameSync(tmp, join(dir, name));
}

async function fetchCapped(url: string, f: typeof fetch, maxBytes: number): Promise<Uint8Array | number> {
  const res = await f(url, { headers: { "user-agent": "capstan-geo-refresh" } });
  if (!res.ok) return res.status;
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new Error(`geo file is ${len} bytes, above the ${maxBytes} cap`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error(`geo file is ${buf.byteLength} bytes, above the ${maxBytes} cap`);
  return buf;
}

export async function refreshGeoDb(o: RefreshOptions): Promise<RefreshResult> {
  const f = o.fetchImpl ?? fetch;
  const maxBytes = o.maxBytes ?? 64 * 1024 * 1024;
  const minRanges = o.minRanges ?? 100_000;
  mkdirSync(o.dir, { recursive: true });
  const meta = readGeoMeta(o.dir);
  const have = existsSync(join(o.dir, GEO_FILE));
  const month = monthOf(o.now());
  if (have && meta?.month === month) return { status: "current", month, sha256: meta.sha256 };

  for (const m of [month, previousMonth(month)]) {
    if (have && meta && m <= meta.month) break; // nothing newer than what is in place
    let got: Uint8Array | number;
    try {
      got = await fetchCapped(dbIpUrl(m, o.baseUrl), f, maxBytes);
    } catch (e) {
      return { status: "failed", month: meta?.month ?? null, sha256: meta?.sha256 ?? null, reason: (e as Error).message };
    }
    if (typeof got === "number") {
      if (got === 404 || got === 403) continue; // not published yet
      return { status: "failed", month: meta?.month ?? null, sha256: meta?.sha256 ?? null, reason: `HTTP ${got}` };
    }
    let text: string;
    try {
      const raw = Bun.gunzipSync(new Uint8Array(got));
      if (raw.byteLength > maxBytes * 4) throw new Error("decompressed geo file is too large");
      text = new TextDecoder().decode(raw);
    } catch (e) {
      return { status: "failed", month: meta?.month ?? null, sha256: meta?.sha256 ?? null, reason: `not a gzip file: ${(e as Error).message}` };
    }
    const table = parseDbIpCsv(text);
    const total = table.stats.v4Ranges + table.stats.v6Ranges;
    if (table.stats.v4Ranges < minRanges || table.stats.malformed > total / 100) {
      return { status: "failed", month: meta?.month ?? null, sha256: meta?.sha256 ?? null, reason: `table check failed: ${table.stats.v4Ranges} IPv4 ranges, ${table.stats.malformed} malformed rows` };
    }
    const sha256 = createHash("sha256").update(got).digest("hex");
    const next: GeoMeta = { month: m, sha256, bytes: got.byteLength, v4Ranges: table.stats.v4Ranges, v6Ranges: table.stats.v6Ranges, fetchedAt: o.now().toISOString() };
    if (have && meta?.sha256 === sha256) {
      atomicWrite(o.dir, GEO_META, JSON.stringify(next));
      return { status: "unchanged", month: m, sha256 };
    }
    atomicWrite(o.dir, GEO_FILE, got);
    atomicWrite(o.dir, GEO_META, JSON.stringify(next));
    return { status: "updated", month: m, sha256 };
  }
  return { status: "not_published", month: meta?.month ?? null, sha256: meta?.sha256 ?? null };
}
