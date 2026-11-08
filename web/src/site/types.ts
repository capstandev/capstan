// Types the live views read, all from the workspace schema (through src/lib/capstan.ts), plus the funding row shape
// GET /v1/funding serves (apps/api/src/routes/funding.routes.ts).
export type { Market, OrderBook, RouteQuote, VenueQuote, VenueCapabilities, VenueId } from "../lib/capstan";
import type { VenueId } from "../lib/capstan";

export interface FundingRowLike {
  marketId: string;
  venue: VenueId;
  dataFreshness?: string;
  executable: boolean;
  status: "ok" | "unavailable";
  source: string | null;
  asOf: string | null;
  ratePerInterval: string | null;
  intervalS: number | null;
  ratePerHour: string | null;
  rateAnnualised: string | null;
  annualisedLabel?: string;
  nextSettlementAt: string | null;
  note?: string;
}
