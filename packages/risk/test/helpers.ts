// Fixtures for the risk tests: positions and snapshots built by hand, plus the recorded Hyperliquid account (core +
// xyz + io) and the recorded Lighter-RH account through the real adapters' normalisers.
import { memoryCatalog, type QuoteMarket } from "@capstan/quote";
import type { AccountSnapshot, CanonicalAsset, Position, VenueId } from "@capstan/schema";

export const OWNER = "0x2ac6e76aeb3102d322ee9a82bd67d447d8781014" as const;
export const NOW = new Date("2026-11-01T12:00:00.000Z");

export function pos(venue: VenueId, marketId: string, o: Partial<Position> = {}): Position {
  return {
    venue,
    marketId,
    canonicalAsset: null,
    side: "long",
    size: "1",
    entryPx: "2000",
    markPx: "2000",
    notionalUsd: "2000",
    leverage: 5,
    marginMode: "isolated",
    liqPx: "1700",
    liqPxSource: "venue",
    marginRatio: null,
    unrealisedPnlUsd: "0",
    collateralAsset: venue === "lighter-rh" ? "USDG" : "USDC",
    asOf: NOW.toISOString(),
    ...o,
  };
}

export function snap(venue: VenueId, positions: Position[], o: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return { venue, identity: { venue, owner: OWNER, ...(venue.startsWith("lighter") ? { accountIndex: 7 } : {}) }, equityUsd: "1000", freeCollateralUsd: "500", positions, asOf: NOW.toISOString(), ...o };
}

const market = (id: string, venue: VenueId, asset: CanonicalAsset | null): QuoteMarket => ({
  id,
  venue,
  dex: null,
  venueSymbol: id.split(":")[2]!,
  marketType: "perp",
  canonicalAsset: asset,
  collateralAsset: "USDC",
  tickSize: "0.1",
  lotSize: "0.001",
  minNotional: null,
  maxLeverage: 25,
  marginModes: ["cross", "isolated"],
  fundingIntervalS: 3600,
  fundingSettleIntervalS: 3600,
  sessionHours: null,
  oiCapUsd: null,
  builderFeeUnit: null,
  status: "active",
  executable: true,
  dataFreshness: "live",
  updatedAt: NOW.toISOString(),
});

export const CATALOG = memoryCatalog([
  market("hyperliquid:-:ETH", "hyperliquid", "CR:ETH"),
  market("hyperliquid:-:BTC", "hyperliquid", "CR:BTC"),
  market("lighter-mainnet:-:ETH", "lighter-mainnet", "CR:ETH"),
  market("aster:-:ETHUSDT", "aster", "CR:ETH"),
  market("lighter-rh:-:HYPE", "lighter-rh", "CR:HYPE"),
]);
