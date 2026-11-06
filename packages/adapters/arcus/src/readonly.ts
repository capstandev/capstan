// Read-only (data-only) adapter contract. Variational and Arcus publish market data but Capstan never executes there:
// caps.execution is false and every execution method throws VENUE_DATA_ONLY. The same structural type is declared in
// @capstan/adapter-variational; both satisfy it, and the quote engine accepts either.
import { CapstanError, type FundingSnapshot, type OrderBook, type VenueAdapter, type VenueCapabilities, type VenueId } from "@capstan/schema";

export interface QuoteBucket {
  size: "1k" | "100k" | "1m";
  bid: string;
  ask: string;
  asOf: string;
}

export interface ReadOnlyAdapter extends Pick<VenueAdapter, "caps" | "listMarkets" | "getFunding" | "streamMarket"> {
  /** Variational: null (no depth, size buckets only). Arcus: the L2 book. */
  getBook(marketId: string): Promise<OrderBook | null>;
  /** Variational size-bucketed quotes. */
  getQuoteBuckets?(marketId: string): Promise<QuoteBucket[]>;
}

/** Every VenueAdapter method that would act on an account. On a data-only venue each one throws. */
export const EXECUTION_METHODS = [
  "getAccount",
  "getOpenOrders",
  "quote",
  "buildOnboarding",
  "submitOnboarding",
  "verifyOnboarding",
  "buildOrder",
  "buildCancel",
  "verifySigned",
  "submit",
  "buildRevocation",
] as const satisfies readonly (keyof VenueAdapter)[];

export type ExecutionMethod = (typeof EXECUTION_METHODS)[number];
export type DataOnlyMethods = { [K in ExecutionMethod]: (...args: unknown[]) => never };

export function dataOnlyCaps(venue: VenueId): VenueCapabilities {
  return {
    venue,
    execution: false,
    keyType: null,
    delegation: "none",
    canWithdraw: false,
    builderFee: null,
    collateral: venue === "arcus" ? ["USDG"] : ["USDC"],
    directSubmitSupported: false,
    publicAccountReads: false,
  };
}

export function dataOnlyMethods(venue: VenueId): DataOnlyMethods {
  const out = {} as DataOnlyMethods;
  for (const m of EXECUTION_METHODS) {
    out[m] = () => {
      throw new CapstanError("VENUE_DATA_ONLY", `${venue} is data only: ${m} is not available`);
    };
  }
  return out;
}

export function isReadOnlyAdapter(a: { caps: VenueCapabilities }): boolean {
  return a.caps.execution === false;
}

export type { FundingSnapshot };
