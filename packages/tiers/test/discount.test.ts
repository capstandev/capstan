// R9: the builder-fee discount reaches adapters only through BuildContext.builderFee (HL tenthsBp 10, Aster
// decimalRate 0.0001). Fake adapters build an HL and an Aster order for a lock-tier owner and a free owner, applying
// the real field rules of both adapters (builderField, feeRateFor), and the built fields carry the discount.
import { describe, expect, test } from "bun:test";
import { feeRateFor } from "@capstan/adapter-aster";
import { builderField } from "@capstan/adapter-hyperliquid";
import type { BuildContext, Hex, OrderIntent } from "@capstan/schema";
import { parseUnits } from "viem";
import { buildContextFee } from "../src/tiers";
import { tierOf, type LockReader } from "../src/tier-of";

const OWNER = "0x00000000000000000000000000000000000000c1" as Hex;
const BUILDER = "0x00000000000000000000000000000000000000b1" as Hex;
const lockOf = (cpst: string): LockReader => ({ lockedOf: async () => ({ amount: parseUnits(cpst, 18), unlockAt: 0n }) });

/** A minimal port of the adapter build step: everything but the fee field is out of scope here. */
interface FeeBuilder {
  venue: string;
  build(intent: Pick<OrderIntent, "marketId">, ctx: BuildContext): { fields: Record<string, unknown> };
}
const hlFake: FeeBuilder = { venue: "hyperliquid", build: (_i, ctx) => ({ fields: { builder: builderField(ctx, BUILDER, 30) } }) };
const asterFake: FeeBuilder = { venue: "aster", build: (_i, ctx) => ({ fields: { builder: BUILDER, feeRate: feeRateFor(ctx) } }) };

function ctxFor(venue: string, fee: ReturnType<typeof buildContextFee>): BuildContext {
  return {
    owner: OWNER,
    agentRef: "agent-1",
    identity: { venue } as unknown as BuildContext["identity"],
    builderFee: fee,
    approvedMaxBps: 3,
    nowMs: Date.now(),
    eligibilityDecisionId: "e1",
    policyId: null,
  };
}

describe("builder-fee discount", () => {
  test("passes-to-build", async () => {
    const lock = await tierOf({ owner: OWNER }, { db: null, lock: lockOf("100000"), cacheTtlMs: 60_000 });
    const free = await tierOf({ owner: OWNER }, { db: null, lock: lockOf("0"), cacheTtlMs: 60_000 });
    expect(lock.tier).toBe("lock_holder");
    const hlLock = hlFake.build({ marketId: "hyperliquid:-:BTC" }, ctxFor("hyperliquid", buildContextFee(lock.builderFee, "hyperliquid")));
    const asLock = asterFake.build({ marketId: "aster:-:BTCUSDT" }, ctxFor("aster", buildContextFee(lock.builderFee, "aster")));
    expect(hlLock.fields.builder).toEqual({ b: BUILDER, f: 10 });
    expect(asLock.fields.feeRate).toBe("0.0001");
    const hlFree = hlFake.build({ marketId: "hyperliquid:-:BTC" }, ctxFor("hyperliquid", buildContextFee(free.builderFee, "hyperliquid")));
    const asFree = asterFake.build({ marketId: "aster:-:BTCUSDT" }, ctxFor("aster", buildContextFee(free.builderFee, "aster")));
    expect(hlFree.fields.builder).toEqual({ b: BUILDER, f: 20 });
    expect(asFree.fields.feeRate).toBe("0.0002");
    // the context is the only channel: the fee value per venue, nothing for Lighter (zero-fee integrator)
    expect(buildContextFee(lock.builderFee, "hyperliquid")).toEqual({ tenthsBp: 10 });
    expect(buildContextFee(lock.builderFee, "aster")).toEqual({ decimalRate: "0.0001" });
    expect(buildContextFee(lock.builderFee, "lighter")).toBeNull();
    const whale = await tierOf({ owner: OWNER }, { db: null, lock: lockOf("1000000"), cacheTtlMs: 60_000 });
    expect(hlFake.build({ marketId: "x" }, ctxFor("hyperliquid", buildContextFee(whale.builderFee, "hyperliquid"))).fields.builder).toEqual({ b: BUILDER, f: 10 });
  });
});
