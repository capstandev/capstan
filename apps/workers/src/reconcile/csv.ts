// Hyperliquid builder fill CSV (venue-hyperliquid.md section 5): a daily `.csv.lz4` per builder at
//   https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/{lowercase address}/{YYYYMMDD}.csv.lz4
// published 2 to 3 days late; a missing day answers 403 AccessDenied. Columns: time, user, coin, side, px, sz,
// crossed, special_trade_type, tif, is_trigger, counterparty, closed_pnl, twap_id, builder_fee. No order id.
// The parser streams block by block, splits lines with one forward scan (linear), stops above a decompressed size cap
// with PARSE_TOO_LARGE, and counts and skips malformed rows.
import type { Hex } from "@capstan/schema";
import { lz4Frames } from "./lz4";

export const CSV_BASE_URL = "https://stats-data.hyperliquid.xyz/Mainnet/builder_fills";
export const CSV_MAX_BYTES = 64 * 1024 * 1024;
export const CSV_MAX_LINE = 4096;
export const CSV_COLUMNS = ["time", "user", "coin", "side", "px", "sz", "crossed", "special_trade_type", "tif", "is_trigger", "counterparty", "closed_pnl", "twap_id", "builder_fee"] as const;

export class ReconError extends Error {
  readonly code: "PARSE_TOO_LARGE" | "PARSE_BAD_HEADER" | "CSV_FETCH_FAILED";
  constructor(code: ReconError["code"], message: string) {
    super(message);
    this.name = "ReconError";
    this.code = code;
  }
}

export interface HlCsvRow {
  time: string; // ISO, second resolution
  timeMs: number;
  user: Hex; // lower case
  coin: string; // "BTC", "xyz:TSLA", "@305" (spot)
  side: "Bid" | "Ask";
  px: string;
  sz: string;
  crossed: boolean;
  specialTradeType: string;
  tif: string;
  isTrigger: boolean;
  counterparty: string;
  closedPnl: string;
  twapId: string;
  builderFee: string;
}

export interface CsvStats {
  rows: number;
  malformed: number;
  bytes: number;
  steps: number; // loop iterations of the line scan: linear in bytes
}

/** 403 means the day is not there (not published yet, or never). */
export interface CsvFetcher {
  get(addrLower: Hex, yyyymmdd: string): Promise<Uint8Array | 403>;
}

export function csvUrl(builder: Hex, yyyymmdd: string, base = CSV_BASE_URL): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(builder)) throw new Error("csvUrl: builder must be an address");
  if (!/^\d{8}$/.test(yyyymmdd)) throw new Error("csvUrl: day must be YYYYMMDD");
  return `${base}/${builder.toLowerCase()}/${yyyymmdd}.csv.lz4`;
}

/** Keyless HTTP fetcher with a compressed size cap. Any status but 200 and 403 is an error. */
export function httpCsvFetcher(opts: { fetchImpl?: typeof fetch; base?: string; maxBytes?: number; timeoutMs?: number } = {}): CsvFetcher {
  const f = opts.fetchImpl ?? fetch;
  const cap = opts.maxBytes ?? 16 * 1024 * 1024;
  return {
    async get(addr, day) {
      const res = await f(csvUrl(addr, day, opts.base), { signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000), headers: { "user-agent": "capstan-reconciler" } });
      if (res.status === 403 || res.status === 404) return 403;
      if (!res.ok) throw new ReconError("CSV_FETCH_FAILED", `builder CSV ${day}: HTTP ${res.status}`);
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > cap) throw new ReconError("PARSE_TOO_LARGE", `builder CSV ${day} is ${len} bytes compressed, above ${cap}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > cap) throw new ReconError("PARSE_TOO_LARGE", `builder CSV ${day} is ${buf.byteLength} bytes compressed, above ${cap}`);
      return buf;
    },
  };
}

const DEC = /^-?\d+(\.\d+)?$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ISO_S = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function toRow(cols: string[]): HlCsvRow | null {
  if (cols.length !== CSV_COLUMNS.length) return null;
  const [time, user, coin, side, px, sz, crossed, stt, tif, trig, cp, pnl, twap, fee] = cols as [string, string, string, string, string, string, string, string, string, string, string, string, string, string];
  if (!ISO_S.test(time) || !ADDR.test(user) || !coin || coin.length > 64 || (side !== "Bid" && side !== "Ask")) return null;
  if (!DEC.test(px) || !DEC.test(sz) || !DEC.test(fee) || (pnl !== "" && !DEC.test(pnl))) return null;
  if ((crossed !== "true" && crossed !== "false") || (trig !== "true" && trig !== "false")) return null;
  const timeMs = Date.parse(time);
  if (Number.isNaN(timeMs)) return null;
  return { time, timeMs, user: user.toLowerCase() as Hex, coin, side, px, sz, crossed: crossed === "true", specialTradeType: stt, tif, isTrigger: trig === "true", counterparty: cp, closedPnl: pnl, twapId: twap, builderFee: fee };
}

/**
 * Stream rows out of a builder CSV. `stats` fills in as the iteration runs. Throws ReconError PARSE_TOO_LARGE once the
 * decompressed size passes `maxBytes`, and PARSE_BAD_HEADER when the first line is not the known header.
 */
export function parseBuilderCsv(lz4: Uint8Array, maxBytes = CSV_MAX_BYTES): AsyncIterable<HlCsvRow> & { stats: CsvStats } {
  const stats: CsvStats = { rows: 0, malformed: 0, bytes: 0, steps: 0 };
  const dec = new TextDecoder();
  async function* gen(): AsyncGenerator<HlCsvRow> {
    let carry = "";
    let header = true;
    const frames = lz4Frames(lz4, (total) => {
      stats.bytes = total;
      if (total > maxBytes) throw new ReconError("PARSE_TOO_LARGE", `builder CSV decompresses past ${maxBytes} bytes`);
    });
    const line = (l: string): HlCsvRow | null => {
      const text = l.endsWith("\r") ? l.slice(0, -1) : l;
      if (header) {
        header = false;
        if (text !== CSV_COLUMNS.join(",")) throw new ReconError("PARSE_BAD_HEADER", "builder CSV header changed");
        return null;
      }
      if (text === "") return null;
      const row = text.length > CSV_MAX_LINE ? null : toRow(text.split(","));
      if (!row) stats.malformed++;
      else stats.rows++;
      return row;
    };
    let dropping = false; // inside a line longer than CSV_MAX_LINE: skip to its newline
    for (const chunk of frames) {
      const s = carry + dec.decode(chunk, { stream: true }); // carry is at most CSV_MAX_LINE, so this stays linear
      let start = 0;
      if (dropping) {
        stats.steps++;
        const nl = s.indexOf("\n");
        if (nl < 0) {
          carry = "";
          continue;
        }
        start = nl + 1;
        dropping = false;
      }
      for (;;) {
        stats.steps++;
        const nl = s.indexOf("\n", start);
        if (nl < 0) break;
        const r = line(s.slice(start, nl));
        if (r) yield r;
        start = nl + 1;
      }
      carry = s.slice(start);
      if (carry.length > CSV_MAX_LINE) {
        stats.malformed++;
        carry = "";
        dropping = true;
      }
    }
    const tail = dropping ? "" : carry + dec.decode();
    if (tail.length > 0) {
      const r = line(tail);
      if (r) yield r;
    }
  }
  const it = gen();
  return Object.assign({ [Symbol.asyncIterator]: () => it }, { stats });
}
