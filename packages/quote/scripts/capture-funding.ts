// Capture 30 days of settled funding per venue for the forecaster back-test (public unsigned reads only; by hand):
//   bun packages/quote/scripts/capture-funding.ts
// Every row is stored as the venue published it plus ratePerHour in Capstan's convention (longs pay when positive):
//   Hyperliquid fundingHistory: fundingRate per hour, plus premium. Lighter fundings: percent per hour, "direction"
//   short means shorts pay (negative). Arcus fundingRates: per hour, time in microseconds. Aster fundingRate: per
//   interval (8 h for BTCUSDT), converted with the interval between rows.
import { Dec } from "@capstan/schema";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "../test/funding/fixtures");
const END = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const START = END - 30 * 86_400_000;
const sleep = (ms: number) => Bun.sleep(ms);
interface Row {
  ts: string;
  ratePerHour: string;
  raw: unknown;
}
async function get<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}
const write = (name: string, marketId: string, url: string, intervalS: number, rows: Row[]) => {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ name: `funding/${name}`, capturedAt: new Date().toISOString(), source: "live", marketId, intervalS, request: url, from: new Date(START).toISOString(), to: new Date(END).toISOString(), rows }) + "\n");
  console.log(name, rows.length);
};

async function hl(coin: string, marketId: string, name: string) {
  const rows: Row[] = [];
  let t = START;
  while (t < END) {
    const xs = await get<{ fundingRate: string; premium: string; time: number }[]>("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "fundingHistory", coin, startTime: t, endTime: END }) });
    if (!xs.length) break;
    for (const x of xs) if (x.time <= END) rows.push({ ts: new Date(Math.floor(x.time / 1000) * 1000).toISOString(), ratePerHour: x.fundingRate, raw: { fundingRate: x.fundingRate, premium: x.premium } });
    t = xs[xs.length - 1]!.time + 1;
    await sleep(300);
  }
  write(name, marketId, "POST https://api.hyperliquid.xyz/info fundingHistory", 3600, rows);
}

async function lighter(host: string, marketIndex: number, marketId: string, name: string) {
  const r = await get<{ fundings: { timestamp: number; rate: string; direction: string }[] }>(`${host}/api/v1/fundings?market_id=${marketIndex}&resolution=1h&start_timestamp=${START / 1000}&end_timestamp=${END / 1000}&count_back=720`);
  const rows = r.fundings.map((f) => {
    const pct = Dec.parse(f.rate, 12, "half_even");
    const signed = f.direction === "short" ? Dec.neg(Dec.abs(pct)) : pct;
    return { ts: new Date(f.timestamp * 1000).toISOString(), ratePerHour: Dec.toString(Dec.div(signed, Dec.parse("100", 0), 14, "half_even")), raw: f };
  });
  write(name, marketId, `${host}/api/v1/fundings?market_id=${marketIndex}&resolution=1h`, 3600, rows);
}

async function arcus(market: string, name: string) {
  const r = await get<{ fundingRates: { fundingRate: string; time: number }[] }>(`https://api.arcus.xyz/v1/fundingRates?market=${market}`);
  const rows = r.fundingRates
    .map((f) => ({ ts: new Date(Number(BigInt(f.time) / 1000n)).toISOString(), ratePerHour: f.fundingRate, raw: f }))
    .filter((x) => Date.parse(x.ts) >= START && Date.parse(x.ts) <= END)
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
  write(name, `arcus:-:${market}`, `https://api.arcus.xyz/v1/fundingRates?market=${market}`, 3600, rows);
}

async function aster(symbol: string, name: string) {
  const xs = await get<{ fundingRate: string; fundingTime: number }[]>(`https://fapi.asterdex.com/fapi/v3/fundingRate?symbol=${symbol}&startTime=${START}&endTime=${END}&limit=1000`);
  const rows: Row[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    const gapS = i > 0 ? Math.round((x.fundingTime - xs[i - 1]!.fundingTime) / 3_600_000) * 3600 : 28_800;
    rows.push({ ts: new Date(Math.floor(x.fundingTime / 1000) * 1000).toISOString(), ratePerHour: Dec.toString(Dec.div(Dec.parse(x.fundingRate, 12, "half_even"), Dec.parse(String(gapS / 3600), 0), 14, "half_even")), raw: { fundingRate: x.fundingRate, intervalS: gapS } });
  }
  write(name, `aster:-:${symbol}`, `https://fapi.asterdex.com/fapi/v3/fundingRate?symbol=${symbol}`, 28_800, rows);
}

await hl("BTC", "hyperliquid:-:BTC", "hl-btc");
await hl("ETH", "hyperliquid:-:ETH", "hl-eth");
await hl("xyz:TSLA", "hyperliquid:xyz:TSLA", "hl-xyz-tsla");
await lighter("https://mainnet.zklighter.elliot.ai", 1, "lighter-mainnet:-:BTC", "lighter-btc");
await sleep(1200);
await lighter("https://mainnet.zklighter.elliot.ai", 0, "lighter-mainnet:-:ETH", "lighter-eth");
await arcus("BTC-USD", "arcus-btc");
await aster("BTCUSDT", "aster-btcusdt");
