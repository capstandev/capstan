// R6 (code 21100 -> null, other 4xx -> VENUE_ERROR), R8 (configs never mix) and R11 (margin-enabled assets listed,
// equity is the venue's, no multiplier on any venue value).
import { afterAll, describe, expect, test } from "bun:test";
import { CapstanError } from "@capstan/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountSnapshot, LIGHTER_CONFIGS, type LighterAccountRaw } from "../src";
import { fakeLighter, FIXTURE_OWNER, fx, json, readerFor } from "./helpers";

const servers: { stop(): void }[] = [];
afterAll(() => servers.forEach((s) => s.stop()));
const up = (...a: Parameters<typeof fakeLighter>) => {
  const s = fakeLighter(...a);
  servers.push(s);
  return s;
};

describe("account", () => {
  test("no-account", async () => {
    const s = up("lighter-304");
    const r = readerFor(LIGHTER_CONFIGS.mainnet, s.url);
    expect(await r.accountIndexByL1("0x000000000000000000000000000000000000dEaD")).toBeNull();
    const other = up("lighter-304", { "GET /api/v1/accountsByL1Address": () => json({ code: 20001, message: "invalid param" }, 400) });
    const e = await readerFor(LIGHTER_CONFIGS.mainnet, other.url).accountIndexByL1("0x000000000000000000000000000000000000dEaD").catch((x) => x);
    expect(e).toBeInstanceOf(CapstanError);
    expect((e as CapstanError).code).toBe("VENUE_ERROR");
    const found = up("lighter-304", {
      "GET /api/v1/accountsByL1Address": () => json({ code: 200, l1_address: FIXTURE_OWNER, sub_accounts: [{ index: 912, account_type: 1 }, { index: 7, account_type: 0 }, { index: 913, account_type: 1 }] }),
    });
    expect(await readerFor(LIGHTER_CONFIGS.mainnet, found.url).accountIndexByL1(FIXTURE_OWNER)).toEqual({ main: 7, subAccounts: [912, 913] });
    await expect(r.accountIndexByL1("0x12" as never)).rejects.toThrow();
  });

  test("config-separation", async () => {
    const rhSrv = up("lighter-466324");
    const rh = readerFor(LIGHTER_CONFIGS.rh, rhSrv.url);
    const mainnetId = { venue: "lighter-mainnet" as const, owner: FIXTURE_OWNER, accountIndex: 3 };
    for (const call of [() => rh.getAccount(mainnetId), () => rh.getOpenOrders(mainnetId, { authToken: "x" })]) {
      const e = await call().catch((x) => x);
      expect(e).toBeInstanceOf(CapstanError);
      expect((e as CapstanError).code).toBe("INVALID_INPUT");
    }
    expect(rhSrv.hits.filter((h) => h.includes("/account"))).toEqual([]); // refused before any request
    await expect(rh.getBook("lighter-mainnet:-:ETH")).rejects.toThrow(/not on lighter-rh/);
    // the right identity reads, and an account owned by someone else is refused
    const snap = await rh.getAccount({ venue: "lighter-rh", owner: FIXTURE_OWNER, accountIndex: 3 });
    expect(snap.venue).toBe("lighter-rh");
    await expect(rh.getAccount({ venue: "lighter-rh", owner: "0x0000000000000000000000000000000000000001", accountIndex: 3 })).rejects.toThrow(/another owner/);
    // open orders need the owner's auth token
    await expect(rh.getOpenOrders({ venue: "lighter-rh", owner: FIXTURE_OWNER, accountIndex: 3 })).rejects.toThrow(/auth token/);
  });

  test("no-multiplier", async () => {
    const s = up("lighter-466324");
    const r = readerFor(LIGHTER_CONFIGS.rh, s.url);
    const raw = fx<{ accounts: LighterAccountRaw[] }>("lighter-466324", "account").accounts[0]!;
    const snap = await r.getAccount({ venue: "lighter-rh", owner: FIXTURE_OWNER, accountIndex: 3 });
    expect(snap.equityUsd).toBe(raw.total_asset_value!);
    expect(snap.freeCollateralUsd).toBe(raw.available_balance!);
    const enabled = raw.assets!.filter((a) => a.margin_mode === "enabled").map((a) => a.symbol);
    expect(snap.collateral.map((c) => c.symbol)).toEqual(enabled);
    for (const p of snap.positions) {
      const v = raw.positions!.find((x) => x.symbol === p.marketId.split(":")[2])!;
      expect(p.notionalUsd).toBe(v.position_value.replace(/^-/, "").replace(/0+$/, "").replace(/\.$/, ""));
      expect(p.unrealisedPnlUsd).toBe(v.unrealized_pnl);
      expect(p.liqPxSource).toBe("venue");
    }
    // a Stock Token row with a display multiplier (SPY 1.001718): every venue number passes through unchanged
    const spy: LighterAccountRaw = {
      ...raw,
      total_asset_value: "1234.567891",
      available_balance: "1000.000001",
      assets: [...raw.assets!, { symbol: "SPY", asset_id: 40, balance: "2.000000", margin_mode: "enabled", margin_balance: "1376.402115", multiplier: "1.001718000000000000" }],
    };
    const s2 = accountSnapshot(LIGHTER_CONFIGS.rh, { venue: "lighter-rh", owner: FIXTURE_OWNER, accountIndex: 3 }, spy, new Date(0).toISOString());
    expect(s2.equityUsd).toBe("1234.567891");
    expect(s2.freeCollateralUsd).toBe("1000.000001");
    const row = s2.collateral.find((c) => c.symbol === "SPY")!;
    expect(row).toMatchObject({ balance: "2.000000", marginBalance: "1376.402115", venueMultiplier: "1.001718000000000000", marginEnabled: true });
    // and no adapter source applies a uiMultiplier or the venue multiplier to anything
    for (const f of ["read.ts", "normalize.ts", "fees.ts", "ingest.ts", "config.ts"]) {
      const src = readFileSync(join(import.meta.dir, "../src", f), "utf8");
      expect(/uiMultiplier\s*\(|\*\s*\w*[mM]ultiplier|mul\([^)]*[mM]ultiplier/.test(src)).toBe(false);
    }
  });
});
