// Lighter-RH collateral as the venue reports it. Equity is the venue's account equity; Stock Token rows are listed
// with their raw balance and the venue's own margin value. Capstan never values a Stock Token itself and never
// applies a display multiplier on top of a venue-reported number (no double apply).
import type { LighterAccountRaw } from "../read";

export interface RhCollateralView {
  equityUsd: string;
  usdg: string;
  stockTokens: { symbol: string; rawBalance: string; venueValueUsd: string | null }[];
}

export function collateralView(acct: LighterAccountRaw): RhCollateralView {
  const assets = acct.assets ?? [];
  const usdg = assets.find((a) => a.symbol === "USDG");
  return {
    equityUsd: String(acct.total_asset_value ?? acct.collateral ?? "0"),
    usdg: usdg ? String(usdg.margin_balance ?? usdg.balance) : "0",
    stockTokens: assets
      .filter((a) => a.symbol !== "USDG" && a.symbol !== "ETH")
      .map((a) => ({ symbol: a.symbol, rawBalance: String(a.balance), venueValueUsd: a.margin_mode === "enabled" && a.margin_balance !== undefined ? String(a.margin_balance) : null })),
  };
}
