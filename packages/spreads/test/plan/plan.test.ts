// R1 approved only, no data-only leg; R2 exact risk label, ack required, execute refuses a draft; R3 ack signature
// (purpose spread_ack, body ACK_TEXT, owner or an active agent of the owner); R10 no netting or collateral movement.
import { describe, expect, test } from "bun:test";
import { capstanMessage, memoryNonceStore } from "@capstan/core";
import type { Hex, SpreadPlan } from "@capstan/schema";
import { ACK_TEXT, ack, memoryPlanStore, plan, PlanError, type PlanDeps } from "../../src";
import { execute, ExecutorError } from "../../src/executor";
import { testWallet } from "../../../policy/test/accounts";
import { M, NOW, setup } from "../scan/helpers";
import { LOTS, sim } from "../executor/sim";

const owner = testWallet("spread owner");
const agent = testWallet("spread agent");
const stranger = testWallet("spread stranger");
const HOST = "api.capstan.test";

function deps(o: Parameters<typeof setup>[0] = {}) {
  const s = setup(o);
  const store = memoryPlanStore();
  let n = 0;
  const d: PlanDeps = { ...s.deps, store, id: () => `PLAN${String(++n).padStart(22, "0")}` };
  return { d, store, s };
}
const req = (o: Partial<Parameters<typeof plan>[0]> = {}) => ({ owner: owner.address, equivalenceId: "eq-eth", sizeBase: "1.23456", leverage: 5, hedgeFailurePolicy: "flatten_leg_a" as const, ...o });

describe("planner", () => {
  test("approved-only", async () => {
    const { d } = deps({
      eqs: [
        { id: "eq-eth", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.lt.id, M.var.id], status: "approved", notes: "" },
        { id: "eq-prop", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.lt.id], status: "proposed", notes: null },
        { id: "eq-rej", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.lt.id], status: "rejected", notes: "no" },
        { id: "eq-dataonly", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.var.id], status: "approved", notes: "" },
      ],
    });
    for (const id of ["eq-prop", "eq-rej", "eq-missing"]) await expect(plan(req({ equivalenceId: id }), d)).rejects.toMatchObject({ code: "NOT_APPROVED" });
    // a data-only market named as a leg is refused; an equivalence whose only partner is data-only has no pair
    await expect(plan(req({ marketIds: [M.hl.id, M.var.id] }), d)).rejects.toMatchObject({ code: "VENUE_DATA_ONLY" });
    await expect(plan(req({ equivalenceId: "eq-dataonly" }), d)).rejects.toMatchObject({ code: "NO_PAIR" });
    // the approved one plans, and never on the data-only venue (its funding rate is the largest in the fixture)
    const p = await plan(req(), d);
    expect([p.legA.venue, p.legB.venue].sort()).toEqual(["hyperliquid", "lighter-mainnet"]);
  });

  test("ack-required", async () => {
    const { d, store } = deps();
    const p = await plan(req(), d);
    expect(p.riskLabel).toBe("At-risk. Legging risk is yours.");
    expect(p.ackRequired).toBe(true);
    expect(p.status).toBe("draft");
    expect(p.legTimeoutMs).toBe(3000);
    // both legs the same size, floored to both lots (0.0001), residual 0 at plan time
    expect([p.sizeBase, p.legA.size, p.legB.size, p.residualDeltaBase]).toEqual(["1.2345", "1.2345", "1.2345", "0"]);
    // the stored plan is a draft with its quote snapshot hash
    const sp = await store.get(p.planId);
    expect(sp!.plan.status).toBe("draft");
    expect(sp!.quoteSnapshotHash).toMatch(/^0x[0-9a-f]{64}$/);
    // the executor refuses a draft before any order
    const v = sim(() => ({}), LOTS(p));
    await expect(execute(p, v.ports)).rejects.toBeInstanceOf(ExecutorError);
    expect(v.subs).toEqual([]);
  });

  test("ack-sig", async () => {
    const { d, store } = deps();
    const p = await plan(req(), d);
    const nonces = memoryNonceStore();
    const agentsOf = async (o: Hex) => (o.toLowerCase() === owner.address.toLowerCase() ? [agent.address] : []);
    let k = 0;
    const msg = async (w: typeof owner, o: Partial<{ purpose: "spread_ack" | "kill"; body: string; ownerLine: Hex }> = {}) => {
      const message = capstanMessage({ purpose: o.purpose ?? "spread_ack", owner: o.ownerLine ?? owner.address, host: HOST, chainId: 4663, nonce: `ack-nonce-${k++}`, issuedAt: NOW.getTime() - 1000, expiresAt: NOW.getTime() + 3_600_000, body: o.body ?? ACK_TEXT(p.planId) });
      return { message, sig: await w.signMessage({ message }) };
    };
    const base = { store, nonces, host: HOST, nowMs: NOW.getTime(), agentsOf };
    expect(ACK_TEXT(p.planId)).toBe(`I acknowledge spread plan ${p.planId}. At-risk. Legging risk is yours.`);
    // another signer, another purpose (a kill signature), another plan's text: refused
    let m = await msg(stranger);
    await expect(ack(p.planId, m.sig, null, { ...base, message: m.message })).rejects.toMatchObject({ code: "BAD_ACK" });
    m = await msg(owner, { purpose: "kill" });
    await expect(ack(p.planId, m.sig, null, { ...base, message: m.message })).rejects.toMatchObject({ code: "BAD_ACK" });
    m = await msg(owner, { body: ACK_TEXT("SOMEOTHERPLAN") });
    await expect(ack(p.planId, m.sig, null, { ...base, message: m.message })).rejects.toMatchObject({ code: "BAD_ACK" });
    expect((await store.get(p.planId))!.plan.status).toBe("draft");
    // an active agent of the owner may acknowledge
    m = await msg(agent);
    expect(await ack(p.planId, m.sig, agent.address, { ...base, message: m.message })).toEqual({ status: "acked" });
    expect((await store.get(p.planId))!.plan.status).toBe("acked");
    // the same ack again is fine; a different one on an acked plan is refused
    expect(await ack(p.planId, m.sig, agent.address, { ...base, message: m.message })).toEqual({ status: "acked" });
    const m2 = await msg(owner);
    await expect(ack(p.planId, m2.sig, null, { ...base, message: m2.message })).rejects.toMatchObject({ code: "BAD_STATE" });
    // the owner acks a second plan
    const p2 = await plan(req(), d);
    const m3 = await msg(owner, { body: ACK_TEXT(p2.planId) });
    expect(await ack(p2.planId, m3.sig, owner.address, { ...base, message: m3.message })).toEqual({ status: "acked" });
  });

  test("no-netting", async () => {
    const { d } = deps({ markets: [M.hl, M.rh], eqs: [{ id: "eq-eth", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.rh.id], status: "approved", notes: "r\noverride: USDG leg reviewed" }] });
    const p: SpreadPlan = await plan(req(), d);
    // each leg keeps its own venue collateral and its own liquidation estimate
    expect([p.legA.collateralAsset, p.legB.collateralAsset].sort()).toEqual(["USDC", "USDG"]);
    expect(p.legA.estLiqPx).not.toBe(p.legB.estLiqPx);
    // schema walk: no key that nets margin, pools collateral or moves funds
    const keys: string[] = [];
    const walk = (v: unknown) => (Array.isArray(v) ? v.forEach(walk) : v && typeof v === "object" ? Object.entries(v).forEach(([k, x]) => (keys.push(k), walk(x))) : undefined);
    walk(p);
    for (const k of keys) expect(k).not.toMatch(/total(Equity|Collateral|Margin)|net(Collateral|Margin)|shared|crossVenue|transfer|withdraw|rebalance/i);
    expect(JSON.stringify(p)).not.toMatch(/transfer|withdraw|usdSend|rebalance/i);
    expect(PlanError).toBeDefined();
  });
});
