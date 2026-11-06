// R12: when the dollar tokens collected at the hot key (or a sweep payTo) would exceed $200, an ops alert is raised
// and the sweep runbook command is printed for the owner; nothing is ever sent.
import { describe, expect, test } from "bun:test";
import { logger } from "@capstan/core";
import { floatGuard, sweepCommand, type FloatAlert, type FloatHolding } from "../src/float";
import { NETWORKS } from "../src/networks";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const HOT = "0x00000000000000000000000000000000000000f1";
const SAFE = "0x000000000000000000000000000000000000005a";

describe("float guard", () => {
  test("alert-above-200", async () => {
    const lines: string[] = [];
    const alerts: FloatAlert[] = [];
    let held = 150_000_000n; // $150
    const g = floatGuard({
      holdings: async (): Promise<FloatHolding[]> => [{ network: NETWORKS.rhc, asset: USDG, holder: HOT, atomic: held, decimals: 6 }],
      sweepTo: SAFE,
      alert: (a) => void alerts.push(a),
      log: logger("t", { sink: (l) => lines.push(l) }),
    });
    expect(g.limitUsd).toBe(200);
    expect(await g.check()).toEqual({ totalUsd: 150, over: false });
    // a $49.99 settle stays under; a $50.01 settle would cross $200
    expect((await g.check([{ network: NETWORKS.rhc, asset: USDG, holder: HOT, atomic: 49_990_000n, decimals: 6 }])).over).toBe(false);
    const r = await g.check([{ network: NETWORKS.rhc, asset: USDG, holder: HOT, atomic: 50_010_000n, decimals: 6 }]);
    expect(r.over).toBe(true);
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toMatchObject({ kind: "x402.float_above_limit", limitUsd: 200 });
    expect(alerts[0]!.totalUsd).toBeCloseTo(200.01, 6);
    expect(alerts[0]!.sweepCommands).toEqual([`~/.foundry/bin/cast send ${USDG} 'transfer(address,uint256)' ${SAFE} 150000000 --rpc-url <eip155:4663 rpc> --keystore <hot key keystore path>   # run by the owner, see runbooks/facilitator-sweep.md`]);
    // printed to the log (for the owner), never executed: the guard has no way to send
    expect(lines.some((l) => l.includes("sweep command (owner runs it)") && l.includes("cast send"))).toBe(true);
    expect(Object.keys(g).sort()).toEqual(["check", "limitUsd"]);
    // already above without any incoming settle
    held = 250_000_000n;
    expect((await g.check()).over).toBe(true);
    // a failing balance read never raises a false alarm and never throws
    const g2 = floatGuard({ holdings: async () => Promise.reject(new Error("rpc down")), sweepTo: SAFE, alert: (a) => void alerts.push(a), log: logger("t", { sink: () => {} }) });
    expect((await g2.check()).over).toBe(false);
    expect(sweepCommand({ network: NETWORKS.solana, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", holder: "x", atomic: 1_500_000n, decimals: 6 }, "SafeSol")).toContain("spl-token transfer EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 1.5 SafeSol");
  });
});
