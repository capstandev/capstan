// Funding forecaster (spec 9 funding-forecaster, E2). The next 8 settlements per market:
//   Hyperliquid core: the venue's own predictedFundings (method 'venue') for the next settlement.
//   Hyperliquid HIP-3, Aster, Lighter, Arcus: an EWMA of the observed hourly funding-rate history (method 'ewma_rate',
//   half-life 8 h). The spec asks for an EWMA of the premium; funding_ticks stores rates only and the HIP-3 premium to
//   rate formula is not verified, so the method is named for what it averages (BACKLOG C31).
//   Variational: its next.interval_rate (method 'venue'), flagged delayed.
//   No history and no prediction: the last observed rate (method 'last'), or nothing.
// Every value is per hour in the "longs pay when positive" convention and clamped to the venue cap where one is
// published (HL and Arcus 4% per hour). A forecast is an observation-based estimate, never a promise.
import { Dec, VENUE_FUNDING_FACTS, type Market } from "@capstan/schema";

export const DEFAULT_HALF_LIFE_H = 8;
export const SETTLEMENTS = 8;
const SCALE = 18;

export type ForecastMethod = "venue" | "ewma_rate" | "last";
export interface Forecast {
  marketId: string;
  settlements: { at: string; predictedRatePerHour: string; method: ForecastMethod }[];
  dataFreshness?: "live" | "delayed";
}

export interface FundingTick {
  ts: string | Date;
  marketId: string;
  ratePerHour: string;
}

/** EWMA of an hourly rate series: weight 0.5^(age / half-life), age from the newest point. */
export function ewmaRate(points: { ts: number; rate: string }[], halfLifeH = DEFAULT_HALF_LIFE_H): string {
  if (!points.length) throw new RangeError("ewmaRate: empty series");
  if (!(halfLifeH > 0)) throw new RangeError("ewmaRate: half-life must be positive");
  const newest = Math.max(...points.map((p) => p.ts));
  let num = Dec.parse("0", SCALE);
  let den = Dec.parse("0", SCALE);
  for (const p of points) {
    const w = Math.pow(0.5, (newest - p.ts) / 3_600_000 / halfLifeH);
    if (w < 1e-12) continue;
    const wd = Dec.parse(w.toFixed(15), SCALE, "half_even");
    num = Dec.add(num, Dec.mul(Dec.parse(p.rate, SCALE, "half_even"), wd, SCALE, "half_even"));
    den = Dec.add(den, wd);
  }
  return Dec.toString(Dec.div(num, den, 14, "half_even"));
}

/** The next n settlement times: from the venue's nextSettlementAt when it is ahead of now, else the cadence grid. */
export function nextSettlements(m: Pick<Market, "fundingSettleIntervalS">, now: Date, n: number = SETTLEMENTS, venueNext?: string | null): string[] {
  const iv = m.fundingSettleIntervalS * 1000;
  if (!(iv > 0)) throw new RangeError("fundingSettleIntervalS must be positive");
  const t = now.getTime();
  const anchor = venueNext ? Date.parse(venueNext) : NaN;
  const start = Number.isFinite(anchor) && anchor > t ? anchor : (Math.floor(t / iv) + 1) * iv;
  return Array.from({ length: n }, (_, k) => new Date(start + k * iv).toISOString());
}

export function methodFor(m: Pick<Market, "venue" | "dex">, hasPrediction: boolean, hasHistory: boolean): ForecastMethod {
  if (m.venue === "hyperliquid" && m.dex === null && hasPrediction) return "venue";
  if (m.venue === "variational" && hasPrediction) return "venue";
  if (hasHistory && m.venue !== "variational") return "ewma_rate";
  return "last";
}

/**
 * The cap a forecast is clamped to: a snapshot's own cap when it states one, else the venue's published cap. A
 * snapshot with no cap (null, e.g. a HIP-3 market without fundingClamp) falls back to the venue cap, never to none.
 */
export function capFor(m: Pick<Market, "venue">, override?: string | null): string | null {
  if (override !== undefined && override !== null) return override;
  const f = (VENUE_FUNDING_FACTS as Record<string, { capPerHour: string | null } | undefined>)[m.venue];
  return f?.capPerHour ?? null;
}

export function clamp(rate: string, cap: string | null): string {
  if (cap === null) return rate;
  const r = Dec.parse(rate, SCALE, "half_even");
  const c = Dec.abs(Dec.parse(cap, SCALE, "half_even"));
  return Dec.toString(Dec.max(Dec.neg(c), Dec.min(c, r)));
}

export interface ForecastOptions {
  halfLifeH?: number;
  capPerHour?: string | null;
  /** The venue's next settlement time (FundingSnapshot.nextSettlementAt). */
  venueNext?: string | null;
}

/** venuePrediction is a per-hour rate (callers normalise a per-interval prediction first). */
export function forecast(m: Pick<Market, "id" | "venue" | "dex" | "fundingSettleIntervalS" | "dataFreshness">, history: FundingTick[], venuePrediction: string | null, now: Date, o: ForecastOptions = {}): Forecast {
  const past = history
    .filter((h) => h.marketId === m.id)
    .map((h) => ({ ts: typeof h.ts === "string" ? Date.parse(h.ts) : h.ts.getTime(), rate: h.ratePerHour }))
    .filter((h) => Number.isFinite(h.ts) && h.ts <= now.getTime())
    .sort((a, b) => a.ts - b.ts);
  const method = methodFor(m, venuePrediction !== null, past.length > 0);
  const cap = capFor(m, o.capPerHour);
  const times = nextSettlements(m, now, SETTLEMENTS, o.venueNext);
  const ewma = past.length ? ewmaRate(past, o.halfLifeH ?? DEFAULT_HALF_LIFE_H) : null;
  const last = past.length ? past[past.length - 1]!.rate : venuePrediction;
  const out: Forecast = { marketId: m.id, settlements: [], ...(m.dataFreshness === "delayed" ? { dataFreshness: "delayed" as const } : {}) };
  if (method === "last" && last === null) return out;
  for (let k = 0; k < times.length; k++) {
    let v: string;
    let how: ForecastMethod;
    if (method === "venue" && (k === 0 || m.venue === "variational" || ewma === null)) {
      v = venuePrediction!;
      how = "venue";
    } else if (method === "venue" || method === "ewma_rate") {
      v = ewma!;
      how = "ewma_rate";
    } else {
      v = last!;
      how = "last";
    }
    out.settlements.push({ at: times[k]!, predictedRatePerHour: clamp(v, cap), method: how });
  }
  return out;
}
