// R3: no double multiplier. Equity and Stock Token values come from the venue as is; with SPY at a 1.001718 display
// multiplier the snapshot still equals the venue number exactly, and no adapter source calls uiMultiplier.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accountSnapshot, collateralView, LIGHTER_CONFIGS, type LighterAccountRaw } from "../../src";
import { FIXTURE_OWNER, fx } from "../helpers";

describe("rh collateral", () => {
  test("no-double-apply", () => {
    const raw = fx<{ accounts: LighterAccountRaw[] }>("lighter-466324", "account").accounts[0]!;
    const acct: LighterAccountRaw = {
      ...raw,
      total_asset_value: "5012.345678",
      assets: [
        { symbol: "USDG", asset_id: 3, balance: "0.000000", margin_mode: "enabled", margin_balance: "3011.000000", multiplier: "1.000000000000000000" },
        { symbol: "SPY", asset_id: 20, balance: "3.000000", margin_mode: "enabled", margin_balance: "2001.345678", multiplier: "1.001718000000000000" },
        { symbol: "AMD", asset_id: 23, balance: "0.000043", margin_mode: "disabled", margin_balance: "0.000000", multiplier: "1.000000000000000000" },
      ],
    };
    const v = collateralView(acct);
    expect(v.equityUsd).toBe("5012.345678");
    expect(v.usdg).toBe("3011.000000");
    expect(v.stockTokens).toEqual([
      { symbol: "SPY", rawBalance: "3.000000", venueValueUsd: "2001.345678" },
      { symbol: "AMD", rawBalance: "0.000043", venueValueUsd: null },
    ]);
    const s = accountSnapshot(LIGHTER_CONFIGS.rh, { venue: "lighter-rh", owner: FIXTURE_OWNER, accountIndex: 3 }, acct, new Date(0).toISOString());
    expect(s.equityUsd).toBe("5012.345678"); // exactly the venue's number, not x 1.001718
    expect(s.collateral.find((c) => c.symbol === "SPY")).toMatchObject({ balance: "3.000000", marginBalance: "2001.345678", venueMultiplier: "1.001718000000000000" });
    // no uiMultiplier call anywhere in the adapter
    const src = join(import.meta.dir, "../../src");
    const files = readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect({ f, hit: /uiMultiplier\s*\(/.test(readFileSync(join(src, f), "utf8")) }).toEqual({ f, hit: false });
  });
});
