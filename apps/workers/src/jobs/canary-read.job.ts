// Read canary (every 15 min, todo 41, spec 4.1 "testnet canary every 15 min per venue"): three keyless reads per
// venue (health, one book, one funding) on the venue network the profile picks (CAPSTAN_NETWORK, HL_NETWORK and
// CAPSTAN_ASTER_NETWORK, as everywhere else). Public unsigned GET/POST reads only: no key, no signature, no order.
// A failed read publishes `canary.read_failed` on the ops alert channel (alerts only notify).
import type { JobDef, JobDeps } from "@capstan/core";
import { venueNetwork, VENUE_HOSTS, type VenueId } from "@capstan/schema";

export const OPS_ALERT_CHANNEL = "ops.alert";
export const CANARY_READ_VENUES = ["hyperliquid", "lighter-mainnet", "lighter-rh", "aster"] as const satisfies readonly VenueId[];
export type CanaryVenue = (typeof CANARY_READ_VENUES)[number];
export type ProbeKind = "health" | "book" | "funding";

export interface ProbeResult {
  venue: CanaryVenue;
  network: "mainnet" | "testnet";
  kind: ProbeKind;
  ok: boolean;
  ms: number;
  error: string | null;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function hostFor(venue: CanaryVenue, network: "mainnet" | "testnet"): string {
  const t = network === "testnet";
  switch (venue) {
    case "hyperliquid":
      return (t ? VENUE_HOSTS.hyperliquidTestnet : VENUE_HOSTS.hyperliquid).rest;
    case "lighter-mainnet":
      return (t ? VENUE_HOSTS.lighterMainnetTestnet : VENUE_HOSTS.lighterMainnet).rest;
    case "lighter-rh":
      return (t ? VENUE_HOSTS.lighterRhTestnet : VENUE_HOSTS.lighterRh).rest;
    case "aster":
      return (t ? VENUE_HOSTS.asterTestnet : VENUE_HOSTS.aster).rest;
  }
}

async function getJson(f: Fetch, url: string, init?: RequestInit): Promise<any> {
  const r = await f(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const hlPost = (f: Fetch, host: string, body: unknown) => getJson(f, `${host}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const need = (cond: unknown, what: string) => {
  if (!cond) throw new Error(what);
};

/** The three reads for one venue, in order; each returns nothing or throws a plain reason. */
function probes(venue: CanaryVenue, host: string, f: Fetch): [ProbeKind, () => Promise<void>][] {
  switch (venue) {
    case "hyperliquid":
      return [
        ["health", async () => need(Array.isArray((await hlPost(f, host, { type: "meta" }))?.universe), "meta has no universe")],
        ["book", async () => need((await hlPost(f, host, { type: "l2Book", coin: "BTC" }))?.levels?.length === 2, "l2Book BTC has no levels")],
        [
          "funding",
          async () => {
            const r = await hlPost(f, host, { type: "metaAndAssetCtxs" });
            need(Array.isArray(r) && r[1]?.length && r[1][0]?.funding !== undefined, "metaAndAssetCtxs has no funding");
          },
        ],
      ];
    case "lighter-mainnet":
    case "lighter-rh": {
      let market: number | null = null;
      return [
        [
          "health",
          async () => {
            const r = await getJson(f, `${host}/api/v1/orderBooks`);
            const m = (r?.order_books ?? []).find((b: { status?: string; market_type?: string }) => b.status === "active" && b.market_type === "perp");
            need(m && Number.isSafeInteger(m.market_id), "no active perp market");
            market = m.market_id;
          },
        ],
        ["book", async () => need(market !== null && (await getJson(f, `${host}/api/v1/orderBookOrders?market_id=${market}&limit=1`))?.code === 200, "orderBookOrders failed")],
        [
          "funding",
          async () => {
            const now = Math.floor(Date.now() / 1000);
            const r = await getJson(f, `${host}/api/v1/fundings?market_id=${market}&resolution=1h&start_timestamp=${now - 86_400}&end_timestamp=${now}&count_back=1`);
            need(Array.isArray(r?.fundings), "fundings has no list");
          },
        ],
      ];
    }
    case "aster":
      return [
        ["health", async () => need(typeof (await getJson(f, `${host}/fapi/v3/ping`)) === "object", "ping failed")],
        ["book", async () => need(Array.isArray((await getJson(f, `${host}/fapi/v3/depth?symbol=BTCUSDT&limit=5`))?.bids), "depth BTCUSDT has no bids")],
        ["funding", async () => need((await getJson(f, `${host}/fapi/v3/premiumIndex?symbol=BTCUSDT`))?.lastFundingRate !== undefined, "premiumIndex has no lastFundingRate")],
      ];
  }
}

export async function runReadCanary(deps: Pick<JobDeps, "log" | "publish">, o: { fetch?: Fetch; env?: Record<string, string | undefined>; venues?: readonly CanaryVenue[] } = {}): Promise<ProbeResult[]> {
  const f = o.fetch ?? ((u, i) => fetch(u, i));
  const env = o.env ?? process.env;
  const out: ProbeResult[] = [];
  for (const venue of o.venues ?? CANARY_READ_VENUES) {
    const network = venueNetwork(venue, env);
    const host = hostFor(venue, network);
    let skipRest = false;
    for (const [kind, run] of probes(venue, host, f)) {
      const t0 = Date.now();
      let error: string | null = skipRest ? "skipped: health read failed" : null;
      if (!skipRest) {
        try {
          await run();
        } catch (e) {
          error = (e as Error).message || "read failed";
          if (kind === "health") skipRest = true;
        }
      }
      out.push({ venue, network, kind, ok: error === null, ms: Date.now() - t0, error });
    }
  }
  const failed = out.filter((r) => !r.ok && !r.error?.startsWith("skipped"));
  for (const r of failed) {
    const alert = { kind: "canary.read_failed", detail: { venue: r.venue, network: r.network, read: r.kind, error: r.error } };
    if (deps.publish) await deps.publish(OPS_ALERT_CHANNEL, alert);
    else deps.log.warn("ops alert", alert);
  }
  deps.log.info("read canary", { ok: out.filter((r) => r.ok).length, total: out.length });
  return out;
}

export const job: JobDef = {
  name: "canary-read",
  queue: "alertsDispatch",
  schedule: { pattern: "*/15 * * * *" },
  concurrency: 1,
  handler: (_job, deps) => runReadCanary(deps),
};
