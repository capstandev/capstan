// R4: accepts order Base USDC, Solana USDC, RHC USDG permit2, then eip3009 when enabled; permit2 carries
// assetTransferMethod; mainnet eip3009 needs the env flag. R15: amount 0 refused; a rail whose settle cost is over 50%
// of the smallest route price is dropped with an ops alert.
import { afterEach, describe, expect, test } from "bun:test";
import { ADDRESSES, type Hex } from "@capstan/schema";
import { acceptsFor, AcceptsError, railEconomics, railOf, SETTLE_GAS, SOLANA_SETTLE_LAMPORTS, usdOfRoute, usdToAtomic, type X402State } from "../src/accepts";
import { NETWORKS, railDefs, type X402Env } from "../src/networks";

const PAY_EVM = "0x00000000000000000000000000000000000000aa" as Hex;
const PAY_SOL = "So1PayTo1111111111111111111111111111111111";
const FEE_PAYER = "FeePayer11111111111111111111111111111111111";

function fullState(env: X402Env, over: Partial<X402State> = {}): X402State {
  const d = railDefs(env);
  const t = (id: keyof typeof d) => ({ asset: d[id].asset, decimals: 6, name: d[id].domain!.name, version: d[id].domain!.version });
  return {
    usdgEip3009: { "4663": true, "46630": true },
    payTo: { evm: PAY_EVM, sol: PAY_SOL },
    tokens: { "base-usdc": t("base-usdc"), "rhc-usdg-permit2": t("rhc-usdg-permit2"), "rhc-usdg-eip3009": t("rhc-usdg-eip3009") },
    solFeePayer: FEE_PAYER,
    ...over,
  };
}
const ROUTE = { usd: "0.01", description: "funding forecast" };

describe("acceptsFor", () => {
  afterEach(() => {
    delete process.env.X402_USDG_EIP3009_MAINNET;
  });

  test("order-and-flags", () => {
    // testnet: all four, in order
    const tn = acceptsFor(ROUTE, fullState("testnet"), "testnet");
    expect(tn.map((a) => a.network)).toEqual([NETWORKS.baseSepolia, NETWORKS.solanaDevnet, NETWORKS.rhcTestnet, NETWORKS.rhcTestnet]);
    expect(tn[2]!.extra).toEqual({ name: "Global Dollar", version: "1", assetTransferMethod: "permit2" });
    expect(tn[3]!.extra).toEqual({ name: "Global Dollar", version: "1" });
    expect(tn[0]!.extra).toEqual({ name: "USDC", version: "2" });
    expect(tn.every((a) => a.amount === "10000" && a.maxTimeoutSeconds === 60 && a.scheme === "exact")).toBe(true);
    expect(tn[1]).toMatchObject({ asset: ADDRESSES.usdcSolanaDevnet.address, payTo: PAY_SOL, extra: { feePayer: FEE_PAYER } });

    // mainnet: detected but the flag is off -> no eip3009 entry
    const mn = acceptsFor(ROUTE, fullState("mainnet"), "mainnet");
    expect(mn.map((a) => a.network)).toEqual([NETWORKS.base, NETWORKS.solana, NETWORKS.rhc]);
    expect(mn[0]).toMatchObject({ asset: ADDRESSES.usdcBase.address, extra: { name: "USD Coin", version: "2" } });
    expect(mn[2]).toMatchObject({ asset: ADDRESSES.usdgRhc.address, extra: { assetTransferMethod: "permit2" } });
    // the env flag turns it on; the state flag overrides the env both ways
    process.env.X402_USDG_EIP3009_MAINNET = "1";
    expect(acceptsFor(ROUTE, fullState("mainnet"), "mainnet").length).toBe(4);
    expect(acceptsFor(ROUTE, fullState("mainnet", { eip3009MainnetEnabled: false }), "mainnet").length).toBe(3);
    // the flag never overrides a failed detection
    expect(acceptsFor(ROUTE, fullState("mainnet", { usdgEip3009: { "4663": false, "46630": true } }), "mainnet").length).toBe(3);
    expect(acceptsFor(ROUTE, fullState("mainnet", { eip3009MainnetEnabled: true }), "mainnet").length).toBe(4);
    delete process.env.X402_USDG_EIP3009_MAINNET;

    // fail closed: no token facts -> the EVM rail is left out; a wrong domain name -> left out; no fee payer -> no Solana
    expect(acceptsFor(ROUTE, fullState("testnet", { tokens: {} }), "testnet").map((a) => a.network)).toEqual([NETWORKS.solanaDevnet]);
    const wrongName = fullState("mainnet");
    wrongName.tokens!["base-usdc"] = { ...wrongName.tokens!["base-usdc"]!, name: "USDC" };
    expect(acceptsFor(ROUTE, wrongName, "mainnet").map((a) => a.network)).toEqual([NETWORKS.solana, NETWORKS.rhc]);
    expect(acceptsFor(ROUTE, fullState("testnet", { solFeePayer: undefined }), "testnet").length).toBe(3);
    // decimals come from the token facts, not a constant
    const d18 = fullState("testnet");
    d18.tokens!["rhc-usdg-permit2"] = { ...d18.tokens!["rhc-usdg-permit2"]!, decimals: 18 };
    expect(acceptsFor(ROUTE, d18, "testnet")[2]!.amount).toBe("10000000000000000");
    // payTo is never the facilitator hot key
    expect(() => acceptsFor(ROUTE, fullState("testnet", { hotKeys: [PAY_EVM] }), "testnet")).toThrow(AcceptsError);
    // railOf maps back
    expect(tn.map((a) => railOf(a, "testnet"))).toEqual(["base-usdc", "solana-usdc", "rhc-usdg-permit2", "rhc-usdg-eip3009"]);
  });

  test("per-rows pricing", () => {
    const hist = { usd: "0.05", perRows: 1000 as const, description: "history" };
    expect(usdOfRoute(hist)).toBe("0.05");
    expect(usdOfRoute(hist, 1000)).toBe("0.05");
    expect(usdOfRoute(hist, 1001)).toBe("0.1");
    expect(usdOfRoute(hist, 25_000)).toBe("1.25");
    expect(acceptsFor(hist, fullState("testnet"), "testnet", { rows: 2500 })[0]!.amount).toBe("150000");
  });
});

describe("REL-1 and REL-3", () => {
  test("rail-economics", () => {
    // amount 0 is refused everywhere
    expect(() => usdToAtomic("0", 6)).toThrow(/amount 0/);
    expect(() => usdToAtomic("0.0000001", 6)).toThrow(/precision/);
    expect(() => acceptsFor({ usd: "0", description: "free?" }, fullState("testnet"), "testnet")).toThrow(/amount 0/);
    expect(() => railEconomics({ a: { usd: "0", description: "a" } }, {})).toThrow(/amount 0/);
    expect(usdToAtomic("0.01", 6)).toBe(10_000n);
    expect(usdToAtomic("1.250000", 6)).toBe(1_250_000n);

    const routes = { forecast: { usd: "0.01", description: "f" }, scan: { usd: "0.02", description: "s" } };
    const ethUsd = 3000;
    const e = railEconomics(routes, {
      // Base: 115k gas at 0.006 gwei x $3000 = $0.00207 -> kept (limit $0.005)
      "base-usdc": { gasUnits: SETTLE_GAS["base-usdc"], gasPriceWei: 6_000_000n, nativeUsd: ethUsd },
      // Solana: 6,000 lamports at $500 = $0.003 -> kept
      "solana-usdc": { usd: (Number(SOLANA_SETTLE_LAMPORTS) / 1e9) * 500 },
      // RHC permit2 during a gas spike: 135k gas at 20 gwei x $3000 = $8.1 -> dropped
      "rhc-usdg-permit2": { gasUnits: SETTLE_GAS["rhc-usdg-permit2"], gasPriceWei: 20_000_000_000n, nativeUsd: ethUsd },
      // RHC eip3009 has no price data -> dropped (fail closed)
    });
    expect(e.minRouteUsd).toBe(0.01);
    expect(e.limitUsd).toBeCloseTo(0.005, 10);
    expect(e.dropped).toEqual(["rhc-usdg-permit2", "rhc-usdg-eip3009"]);
    expect(e.alerts.map((a) => [a.kind, a.rail])).toEqual([
      ["x402.rail_dropped", "rhc-usdg-permit2"],
      ["x402.rail_dropped", "rhc-usdg-eip3009"],
    ]);
    expect(e.costs["base-usdc"]).toBeCloseTo(0.00207, 8);
    // the dropped rails disappear from accepts
    const acc = acceptsFor(routes.forecast, fullState("testnet", { droppedRails: e.dropped }), "testnet");
    expect(acc.map((a) => railOf(a, "testnet"))).toEqual(["base-usdc", "solana-usdc"]);
    // at the edge: exactly 50% of the cheapest route is kept everywhere; a hair over is limited to the dearer route;
    // over 50% of the dearest route is dropped
    expect(railEconomics(routes, { "base-usdc": { usd: 0.005 } }).dropped).not.toContain("base-usdc");
    expect(railEconomics(routes, { "base-usdc": { usd: 0.005 } }).limited).not.toContain("base-usdc");
    const lim = railEconomics(routes, { "base-usdc": { usd: 0.0050001 } });
    expect(lim.dropped).not.toContain("base-usdc");
    expect(lim.limited).toContain("base-usdc");
    expect(railEconomics(routes, { "base-usdc": { usd: 0.0100001 } }).dropped).toContain("base-usdc");
  });

  test("per-route-economics", () => {
    // found on the fork run (todo 40): RHC USDG settles at the live gas price cost about $0.006, so the rail is kept for
    // a $0.02 call and left out of a $0.01 call (never dropped from every route)
    const routes = { forecast: { usd: "0.01", description: "f" }, scan: { usd: "0.02", description: "s" } };
    const e = railEconomics(routes, { "base-usdc": { usd: 0.002 }, "rhc-usdg-permit2": { usd: 0.0068 }, "rhc-usdg-eip3009": { usd: 0.0058 }, "solana-usdc": { usd: 0.003 } });
    expect(e.dropped).toEqual([]);
    expect(e.limited.sort()).toEqual(["rhc-usdg-eip3009", "rhc-usdg-permit2"]);
    const st = fullState("mainnet", { droppedRails: e.dropped, railCostsUsd: e.costs, eip3009MainnetEnabled: true });
    const rails = (r: { usd: string; description: string }) => acceptsFor(r, st, "mainnet").map((a) => railOf(a, "mainnet"));
    expect(rails(routes.forecast)).not.toContain("rhc-usdg-permit2");
    expect(rails(routes.forecast)).not.toContain("rhc-usdg-eip3009");
    expect(rails(routes.scan)).toContain("rhc-usdg-permit2");
    expect(rails(routes.scan)).toContain("rhc-usdg-eip3009");
    // an unknown cost is never offered (fail closed), whatever the price
    expect(acceptsFor({ usd: "100", description: "x" }, fullState("mainnet", { railCostsUsd: { "base-usdc": null } }), "mainnet").map((a) => railOf(a, "mainnet"))).not.toContain("base-usdc");
  });
});
