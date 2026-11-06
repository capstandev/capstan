// Funding normalisation across cadences (spec 3 FundingSnapshot). Venues settle on 1, 2, 4, 8 and 24 hour intervals;
// every rate is brought to a per-hour rate with exact decimals: perHour = rate / (intervalS / 3600), and the
// annualised figure is perHour x 8760. Annualised numbers are display only, always labelled "observed, annualised".
import { Dec } from "@capstan/schema";

export const ANNUALISED_LABEL = "observed, annualised" as const;
export const OBSERVED_NOTE = "observed, changes hourly" as const;
const SCALE = 30;

export function normalise(ratePerInterval: string, intervalS: number): { ratePerHour: string; rateAnnualised: string } {
  if (!Number.isInteger(intervalS) || intervalS <= 0) throw new RangeError("intervalS must be a positive integer");
  const r = Dec.parse(ratePerInterval, SCALE, "half_even");
  const perHour = Dec.div(Dec.mul(r, Dec.parse("3600", 0), SCALE), Dec.parse(String(intervalS), 0), SCALE, "half_even");
  const annual = Dec.mul(perHour, Dec.parse("8760", 0), SCALE);
  return { ratePerHour: Dec.toString(perHour), rateAnnualised: Dec.toString(annual) };
}
