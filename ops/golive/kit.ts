// Venue go-live kits (tracker line 83): the one engine behind the owner commands in ops/golive/<venue>/.
// Dry run is the default: it reads the venue's public market data (read-only), works out the smallest allowed size,
// and prints every request the trade would make, without sending any of them. A send needs --send plus every arming
// switch for the venue and network (switchesFor); the kit refuses (exit 2) when one is missing.
// A send opens the smallest allowed IOC order, closes it at once with a reduce-only IOC order sized to the fill, then
// checks both receipts (signature, proof, anchor). It never withdraws, transfers or moves collateral.
//   bun ops/golive/kit.ts --kit hl-core --network testnet [--send] [--mode relay|direct] [--market ID] [--verify ID,ID]
// Exit codes: 0 ok (or dry run printed), 1 failed, 2 refused (switch or input missing), 3 traded, receipt pending.
import { readFileSync } from "node:fs";
import { VENUE_HOSTS, type OrderIntent, type VenueId } from "@capstan/schema";
import type { CapstanClient, CheckedBuild } from "@capstan/sdk";

type SubmitOutcome = Awaited<ReturnType<CapstanClient["signAndSubmit"]>>;

export const KITS = ["hl-core", "hip3", "lighter", "lighter-rh", "aster"] as const;
export type Kit = (typeof KITS)[number];
export type Net = "testnet" | "mainnet";
export type Mode = "relay" | "direct";

interface KitSpec {
  venue: VenueId;
  title: string;
  /** The venue's own execution flag on the API and relay hosts (null: the venue has none). */
  flag: string | null;
  market: Record<Net, string>;
  host: Record<Net, string>;
  /** Where a direct-mode order goes on the venue host. */
  orderPath: string;
}

export const SPECS: Record<Kit, KitSpec> = {
  "hl-core": { venue: "hyperliquid", title: "Hyperliquid core perps", flag: null, market: { testnet: "hyperliquid:-:BTC", mainnet: "hyperliquid:-:BTC" }, host: { testnet: VENUE_HOSTS.hyperliquidTestnet.rest, mainnet: VENUE_HOSTS.hyperliquid.rest }, orderPath: "/exchange" },
  hip3: { venue: "hyperliquid", title: "Hyperliquid HIP-3 dex perps", flag: "EQ_EXECUTION_ALLOWED", market: { testnet: "hyperliquid:test:ABC", mainnet: "hyperliquid:xyz:XYZ100" }, host: { testnet: VENUE_HOSTS.hyperliquidTestnet.rest, mainnet: VENUE_HOSTS.hyperliquid.rest }, orderPath: "/exchange" },
  lighter: { venue: "lighter-mainnet", title: "Lighter mainnet (signing id 304)", flag: "LIGHTER_EXECUTION", market: { testnet: "lighter-mainnet:-:ETH", mainnet: "lighter-mainnet:-:ETH" }, host: { testnet: VENUE_HOSTS.lighterMainnetTestnet.rest, mainnet: VENUE_HOSTS.lighterMainnet.rest }, orderPath: "/api/v1/sendTx" },
  "lighter-rh": { venue: "lighter-rh", title: "Lighter on Robinhood Chain (signing id 466324)", flag: "LIGHTER_EXECUTION", market: { testnet: "lighter-rh:-:ETH", mainnet: "lighter-rh:-:ETH" }, host: { testnet: VENUE_HOSTS.lighterRhTestnet.rest, mainnet: VENUE_HOSTS.lighterRh.rest }, orderPath: "/api/v1/sendTx" },
  aster: { venue: "aster", title: "Aster perps (V3)", flag: "ASTER_EXECUTION", market: { testnet: "aster:-:ETHUSDT", mainnet: "aster:-:ETHUSDT" }, host: { testnet: VENUE_HOSTS.asterTestnet.rest, mainnet: VENUE_HOSTS.aster.rest }, orderPath: "/fapi/v3/order" },
};

/** Hyperliquid's minimum order value in USD (venue docs: orders under $10 are rejected). */
export const HL_MIN_NOTIONAL = 10;
export const DEFAULT_SLIPPAGE_BPS = 50;

export interface Switch {
  name: string;
  want: string;
  why: string;
}

/** Every switch a send needs. The kit refuses unless each one is set to exactly `want`. */
export function switchesFor(kit: Kit, net: Net, mode: Mode): Switch[] {
  const s: Switch[] = [{ name: "GOLIVE_SEND", want: "1", why: "the kit sends only with --send and GOLIVE_SEND=1 together" }];
  if (net === "mainnet") s.push({ name: "GOLIVE_CONFIRM", want: `${kit}-mainnet`, why: "typed confirm: real money on a real venue" });
  if (mode === "relay") s.push({ name: "RELAY_SUBMIT_ARMED", want: "1", why: "the relay host is armed (relay.env); unarmed it sends nothing to a venue" });
  const flag = SPECS[kit].flag;
  if (flag) s.push({ name: flag, want: "1", why: kit === "hip3" ? "the API builds HIP-3 equity-class orders only with the legal flag on" : `the API builds ${SPECS[kit].venue} orders only with it on` });
  return s;
}

/** Inputs a send needs besides the switches (paths and addresses, never key material in the environment). */
export const SEND_INPUTS = [
  { name: "GOLIVE_API", why: "the Capstan API base URL (testnet or mainnet profile)" },
  { name: "GOLIVE_KEYFILE", why: "the SDK file keystore that holds the agent key made at onboarding" },
  { name: "GOLIVE_PASSPHRASE_FILE", why: "a file with that keystore's passphrase (mode 600)" },
  { name: "GOLIVE_OWNER", why: "the owner wallet address the agent trades for (position read after the close)" },
] as const;

export function refusals(kit: Kit, net: Net, mode: Mode, env: Record<string, string | undefined>): string[] {
  const out = switchesFor(kit, net, mode).filter((s) => env[s.name] !== s.want).map((s) => `${s.name}=${s.want} is not set (${s.why})`);
  for (const i of SEND_INPUTS) if (!env[i.name]) out.push(`${i.name} is not set (${i.why})`);
  return out;
}

export interface MarketSpec {
  marketId: string;
  symbol: string;
  mid: number;
  /** Size decimals and the size step in those decimals' units. */
  decimals: number;
  stepUnits: number;
  minSize: number;
  minNotional: number;
}

const decimalsOf = (step: string) => (step.includes(".") ? step.replace(/0+$/, "").split(".")[1]!.length : 0);

/** The smallest size both legs clear: at least the venue's minimum size, and at least its minimum notional at the
 * worst price either IOC leg may fill (mid less the slippage), rounded up to the size step. */
export function smallestSize(m: MarketSpec, slippageBps = DEFAULT_SLIPPAGE_BPS): string {
  const unit = 10 ** m.decimals;
  const worst = m.mid * (1 - slippageBps / 10_000);
  if (!(worst > 0)) throw new Error(`no usable price for ${m.marketId}`);
  const need = Math.max(Math.ceil(m.minSize * unit - 1e-6), Math.ceil((m.minNotional / worst) * unit - 1e-6), 1);
  const n = Math.ceil(need / m.stepUnits) * m.stepUnits;
  return (n / unit).toFixed(m.decimals);
}

export function parseMarket(id: string): { venue: string; dex: string | null; symbol: string } {
  const m = /^([a-z0-9-]+):([a-z0-9]+|-):(.+)$/.exec(id);
  if (!m) throw new Error(`not a market id: ${id}`);
  return { venue: m[1]!, dex: m[2] === "-" ? null : m[2]!, symbol: m[3]! };
}

/** Public market data, read-only. Every read the kit makes goes through here. */
export async function readMarket(kit: Kit, marketId: string, base: string, f: typeof fetch): Promise<MarketSpec> {
  const { dex, symbol } = parseMarket(marketId);
  const json = async (r: Response) => {
    if (!r.ok) throw new Error(`venue read ${r.url} answered ${r.status}`);
    return (await r.json()) as any;
  };
  if (kit === "hl-core" || kit === "hip3") {
    const body = { type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) };
    const [meta, ctxs] = await json(await f(`${base}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const name = dex ? `${dex}:${symbol}` : symbol;
    const i = (meta.universe as { name: string; szDecimals: number; isDelisted?: boolean }[]).findIndex((u) => u.name === name);
    if (i < 0 || meta.universe[i].isDelisted) throw new Error(`${name} is not listed on ${base}`);
    const c = ctxs[i] as { midPx?: string | null; markPx: string };
    return { marketId, symbol: name, mid: Number(c.midPx ?? c.markPx), decimals: meta.universe[i].szDecimals, stepUnits: 1, minSize: 10 ** -meta.universe[i].szDecimals, minNotional: HL_MIN_NOTIONAL };
  }
  if (kit === "lighter" || kit === "lighter-rh") {
    const d = await json(await f(`${base}/api/v1/orderBookDetails`));
    const r = (d.order_book_details as { symbol: string; market_type?: string; status: string; min_base_amount: string; min_quote_amount: string; size_decimals: number; mark_price: string }[]).find((x) => x.symbol === symbol && (x.market_type ?? "perp") === "perp");
    if (!r || r.status !== "active") throw new Error(`${symbol} is not an active perp on ${base}`);
    return { marketId, symbol, mid: Number(r.mark_price), decimals: r.size_decimals, stepUnits: 1, minSize: Number(r.min_base_amount), minNotional: Number(r.min_quote_amount) };
  }
  const info = await json(await f(`${base}/fapi/v3/exchangeInfo`));
  const s = (info.symbols as { symbol: string; status: string; filters: Record<string, string>[] }[]).find((x) => x.symbol === symbol);
  if (!s || s.status !== "TRADING") throw new Error(`${symbol} is not trading on ${base}`);
  const lot = s.filters.find((x) => x.filterType === "LOT_SIZE")!;
  const notional = s.filters.find((x) => x.filterType === "MIN_NOTIONAL");
  const px = await json(await f(`${base}/fapi/v3/premiumIndex?symbol=${encodeURIComponent(symbol)}`));
  const decimals = decimalsOf(lot.stepSize!);
  return { marketId, symbol, mid: Number(px.markPrice), decimals, stepUnits: Math.round(Number(lot.stepSize) * 10 ** decimals), minSize: Number(lot.minQty), minNotional: Number(notional?.notional ?? 0) };
}

/** Dry-run HTTP: lets reads through (GET, and Hyperliquid's POST /info) and refuses every other request. */
export function readOnlyFetch(f: typeof fetch): typeof fetch {
  return (async (u: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? (u instanceof Request ? u.method : "GET")).toUpperCase();
    const path = new URL(u instanceof Request ? u.url : String(u)).pathname;
    if (method === "GET" || (method === "POST" && path.endsWith("/info"))) return f(u, init);
    throw new Error(`dry run: refused to send ${method} ${path}`);
  }) as typeof fetch;
}

export interface Planned {
  method: string;
  url: string;
  body: unknown;
  note: string;
}

export function openIntent(marketId: string, size: string, slippageBps = DEFAULT_SLIPPAGE_BPS): OrderIntent {
  return { marketId, side: "buy", size, type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: slippageBps };
}

export function closeIntent(marketId: string, filled: string, slippageBps = DEFAULT_SLIPPAGE_BPS): OrderIntent {
  return { marketId, side: "sell", size: filled, type: "market", tif: "ioc", reduceOnly: true, maxSlippageBps: slippageBps };
}

/** Every request a send makes, in order. Signatures are made at send time, so the plan shows where they go. */
export function plan(kit: Kit, net: Net, mode: Mode, o: { api: string; venueBase: string; size: string; marketId: string; owner: string }): Planned[] {
  const v = SPECS[kit].venue;
  const out: Planned[] = [];
  const leg = (name: string, intent: OrderIntent) => {
    out.push({ method: "POST", url: `${o.api}/v1/orders/build`, body: { venue: v, mode, intent }, note: `${name}: the API builds the order; the SDK checks it against this intent and signs it locally` });
    if (mode === "relay") out.push({ method: "POST", url: `${o.api}/v1/orders/submit`, body: { buildId: "<from the build>", signed: "<agent signature, made at send time>" }, note: `${name}: the relay sends the signed order to ${o.venueBase}${SPECS[kit].orderPath} and signs the receipt` });
    else {
      out.push({ method: "POST", url: `${o.venueBase}${SPECS[kit].orderPath}`, body: "<signed venue payload from the build>", note: `${name}: direct mode, the SDK posts to the venue itself` });
      out.push({ method: "POST", url: `${o.api}/v1/receipts/claim`, body: { buildId: "<from the build>", venueResponse: "<the venue's answer>" }, note: `${name}: claim the receipt with the venue's answer` });
    }
  };
  leg("open", openIntent(o.marketId, o.size));
  leg("close", closeIntent(o.marketId, `<filled size of the open, at most ${o.size}>`));
  for (const name of ["open", "close"]) {
    out.push({ method: "GET", url: `${o.api}/v1/receipts/<${name} receiptId>`, body: null, note: `receipt check (${name}): signature by a Capstan receipt signer` });
    out.push({ method: "GET", url: `${o.api}/v1/receipts/<${name} receiptId>/proof`, body: null, note: `receipt check (${name}): Merkle proof against the CapstanReceiptAnchor root (${net === "mainnet" ? "4663" : "46630"})` });
  }
  return out;
}

export interface KitClient {
  buildOrder(intent: OrderIntent, venue: VenueId, mode: Mode): Promise<CheckedBuild>;
  signAndSubmit(b: CheckedBuild): Promise<SubmitOutcome>;
  verifyReceipt(id: string): Promise<{ valid: boolean; status: string }>;
}

export interface RunOptions {
  kit: Kit;
  net: Net;
  send?: boolean;
  mode?: Mode;
  market?: string;
  verify?: string[];
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** The SDK client for a send (tests pass a stand-in). Default: createClient with the file keystore. */
  client?: (env: Record<string, string | undefined>, venueBase: string) => Promise<KitClient>;
  log?: (line: string) => void;
}

async function defaultClient(kit: Kit, net: Net, env: Record<string, string | undefined>, venueBase: string): Promise<KitClient> {
  const { createClient, fileKeyStore } = await import("@capstan/sdk");
  const pass = env.GOLIVE_PASSPHRASE_FILE!;
  const keystore = fileKeyStore(env.GOLIVE_KEYFILE!, async () => readFileSync(pass, "utf8").replace(/\r?\n$/, ""));
  return createClient({ apiBase: env.GOLIVE_API!, network: net, keystore, venueHosts: { [SPECS[kit].venue]: venueBase } }) as unknown as KitClient;
}

async function checkReceipts(c: KitClient, ids: string[], log: (l: string) => void): Promise<number> {
  let worst = 0;
  for (const id of ids) {
    const r = await c.verifyReceipt(id);
    if (r.valid && r.status === "valid") log(`receipt ${id}: valid (signature, proof and anchor root)`);
    else if (r.status === "pending") {
      log(`receipt ${id}: signed, anchor pending (the hourly anchor has not posted this hour yet)`);
      worst = Math.max(worst, 3);
    } else {
      log(`receipt ${id}: ${r.status}: FAILED`);
      worst = 1;
    }
  }
  return worst === 1 ? 1 : worst;
}

export async function runKit(o: RunOptions): Promise<number> {
  const env = o.env ?? process.env;
  const log = o.log ?? ((l: string) => console.log(l));
  const mode: Mode = o.mode ?? (env.GOLIVE_MODE === "direct" ? "direct" : "relay");
  const spec = SPECS[o.kit];
  const venueBase = (env.GOLIVE_VENUE_URL ?? spec.host[o.net]).replace(/\/$/, "");
  const marketId = o.market ?? env.GOLIVE_MARKET ?? spec.market[o.net];
  if (parseMarket(marketId).venue !== spec.venue) {
    log(`refused: ${marketId} is not a ${spec.venue} market`);
    return 2;
  }
  if ((o.kit === "hip3") !== (parseMarket(marketId).dex !== null)) {
    log(`refused: ${marketId} is ${o.kit === "hip3" ? "not a HIP-3 dex market" : "a HIP-3 market; use ops/golive/hip3"}`);
    return 2;
  }
  log(`${spec.title}, ${o.net}, ${mode} mode, ${o.send ? "SEND" : "dry run (nothing is sent)"}`);
  if (o.send || o.verify) {
    const missing = refusals(o.kit, o.net, mode, env).filter((m) => o.send || !/^(GOLIVE_SEND|GOLIVE_CONFIRM|RELAY_SUBMIT_ARMED|EQ_|LIGHTER_|ASTER_)/.test(m));
    if (missing.length) {
      log("refused: every arming switch and input must be set before a send:");
      for (const m of missing) log(`  - ${m}`);
      return 2;
    }
  }
  const http = o.send ? (o.fetch ?? fetch) : readOnlyFetch(o.fetch ?? fetch);
  if (o.verify) return checkReceipts(await (o.client ?? ((e, b) => defaultClient(o.kit, o.net, e, b)))(env, venueBase), o.verify, log);

  let m: MarketSpec;
  try {
    m = await readMarket(o.kit, marketId, venueBase, http);
  } catch (e) {
    log(`failed: ${(e as Error).message}`);
    return 1;
  }
  const size = smallestSize(m);
  log(`market ${m.symbol}: mid ${m.mid}, min size ${m.minSize}, min notional ${m.minNotional}, size step 1e-${m.decimals} x ${m.stepUnits}`);
  log(`size: ${size} (smallest allowed at ${DEFAULT_SLIPPAGE_BPS} bps slippage, about ${(Number(size) * m.mid).toFixed(2)} notional)`);
  const steps = plan(o.kit, o.net, mode, { api: env.GOLIVE_API ?? "<GOLIVE_API>", venueBase, size, marketId, owner: env.GOLIVE_OWNER ?? "<GOLIVE_OWNER>" });
  steps.forEach((p, i) => log(`${o.send ? "request" : "would send"} ${i + 1}: ${p.method} ${p.url}${p.body === null ? "" : ` ${JSON.stringify(p.body)}`}  # ${p.note}`));
  if (!o.send) {
    const missing = refusals(o.kit, o.net, mode, env);
    log(`dry run done: nothing was sent. A send needs --send and: ${switchesFor(o.kit, o.net, mode).map((s) => `${s.name}=${s.want}`).join(", ")}${missing.length ? ` (${missing.length} not set now)` : ""}`);
    return 0;
  }

  const c = await (o.client ?? ((e, b) => defaultClient(o.kit, o.net, e, b)))(env, venueBase);
  let openBuilt: Awaited<ReturnType<KitClient["buildOrder"]>>;
  try {
    openBuilt = await c.buildOrder(openIntent(marketId, size), spec.venue, mode);
  } catch (e) {
    log(`failed: the open could not be built: ${(e as Error).message}. Nothing was sent.`);
    return 1;
  }
  let open: SubmitOutcome;
  try {
    open = await c.signAndSubmit(openBuilt);
  } catch (e) {
    // d1-golive-01: the post may have reached the venue and filled before the error; the kit cannot tell
    log(`OPEN OUTCOME UNKNOWN: ${(e as Error).message}. The open of ${size} ${m.symbol} may have filled: check the venue and close it on the venue now if a position is open.`);
    return 1;
  }
  log(`open: ${open.order.status}, filled ${open.order.filled} of ${size}, receipt ${open.receiptId ?? "pending"}`);
  const ids = open.receiptId ? [open.receiptId] : [];
  let code = open.receiptId ? 0 : 3;
  if (!(Number(open.order.filled) > 0)) {
    log("failed: the open did not fill, so there is nothing to close. No position was opened.");
    return 1;
  }
  let close: SubmitOutcome;
  try {
    close = await c.signAndSubmit(await c.buildOrder(closeIntent(marketId, open.order.filled), spec.venue, mode));
  } catch (e) {
    log(`FAILED TO CLOSE: ${(e as Error).message}. A position of ${open.order.filled} ${m.symbol} is open: close it on the venue now.`);
    return 1;
  }
  log(`close (reduce-only): ${close.order.status}, filled ${close.order.filled} of ${open.order.filled}, receipt ${close.receiptId ?? "pending"}`);
  if (close.order.filled !== open.order.filled) {
    log(`FAILED TO CLOSE FULLY: ${close.order.filled} of ${open.order.filled} closed. Close the rest on the venue now.`);
    return 1;
  }
  if (close.receiptId) ids.push(close.receiptId);
  else code = 3;
  const r = await checkReceipts(c, ids, log);
  code = r === 1 ? 1 : Math.max(code, r);
  if (code === 3) log(`receipts not final yet: rerun with --verify ${ids.join(",") || "<receipt ids from the API>"} after the next hourly anchor`);
  return code;
}

export function parseArgs(argv: string[]): RunOptions {
  const val = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const kit = val("--kit") as Kit;
  const net = val("--network") as Net;
  if (!KITS.includes(kit)) throw new Error(`--kit must be one of ${KITS.join(", ")}`);
  if (net !== "testnet" && net !== "mainnet") throw new Error("--network must be testnet or mainnet");
  const mode = val("--mode");
  if (mode !== undefined && mode !== "relay" && mode !== "direct") throw new Error("--mode must be relay or direct");
  const market = val("--market");
  const verify = val("--verify");
  return { kit, net, send: argv.includes("--send"), ...(mode ? { mode } : {}), ...(market ? { market } : {}), ...(verify ? { verify: verify.split(",").filter(Boolean) } : {}) };
}

if (import.meta.main) {
  let opts: RunOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`usage error: ${(e as Error).message}`);
    process.exit(2);
  }
  process.exit(await runKit(opts));
}
