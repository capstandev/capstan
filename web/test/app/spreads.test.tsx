// R5: "Execute" enables only after the ack checkbox AND the main wallet's signature of the exact ack text (and the
// server's acked answer); "At-risk. Legging risk is yours." sits next to every hedge word.
import { describe, expect, test } from "bun:test";
import { personalDigest, recoverRsv } from "../../../packages/sdk/src/keys/secp";
import { bodyHash } from "../../../packages/sdk/src/signed-message";
import { SPREAD_ACK_TEXT, SPREAD_RISK_LABEL, type Hex, type SpreadPlan } from "../../src/lib/capstan";
import { byText, click, typeInto, waitFor } from "../helpers";
import { connect, go, startDash } from "./harness";

const PLAN: SpreadPlan = {
  planId: "plan01JTEST",
  canonicalAsset: "EQ:TSLA",
  equivalenceId: "eq-tsla",
  legA: { marketId: "lighter-rh:-:TSLA", venue: "lighter-rh", side: "buy", size: "0.01", collateralAsset: "USDG", estLiqPx: "251.30", payloadTemplate: {} },
  legB: { marketId: "hyperliquid:xyz:TSLA", venue: "hyperliquid", side: "sell", size: "0.01", collateralAsset: "USDC", estLiqPx: "452.10", payloadTemplate: {} },
  sizeBase: "0.01",
  residualDeltaBase: "0",
  fundingDiffPerHourBps: 0.8,
  roundTripCostBps: 14,
  breakevenHours: 17.5,
  nextSettlements: [],
  hedgeFailurePolicy: "flatten_leg_a",
  maxLegSlippageBps: 30,
  legTimeoutMs: 3000,
  riskLabel: "At-risk. Legging risk is yours.",
  ackRequired: true,
  status: "draft",
} as unknown as SpreadPlan;

describe("spreads", () => {
  test("ack-gate", async () => {
    const acks: { sig: Hex; message: string; by?: string }[] = [];
    const executed: string[] = [];
    const d = await startDash({
      intercept: async (url, init) => {
        if (url.pathname.endsWith("/spreads/plan")) return Response.json(PLAN);
        if (url.pathname.endsWith(`/spreads/${PLAN.planId}/ack`)) {
          acks.push(JSON.parse(String(init?.body)));
          return Response.json({ status: "acked" });
        }
        if (url.pathname.endsWith("/spreads/scan")) return Response.json({ error: { code: "PAYMENT_REQUIRED", message: "pay" } }, { status: 402 });
        return undefined;
      },
      spreads: {
        execute: async (planId, log) => {
          executed.push(planId);
          log({ kind: "leg_a_sent", data: { venue: "lighter-rh" } } as never);
          log({ kind: "leg_b_sent", data: { venue: "hyperliquid" } } as never);
          return { status: "complete" };
        },
      },
    });
    try {
      await connect(d);
      await go(d, "Spreads");
      const screen = await waitFor(() => d.m.host.querySelector<HTMLElement>("[data-screen=spreads]"), "the spreads screen");
      // the paid scan is explained, not paid
      await click(byText(screen, "button", "Scan pairs"));
      await waitFor(() => byText(screen, "p", "paid per call ($0.02)"), "the scan note");
      await typeInto(screen.querySelector("input")!, "eq-tsla");
      await click(byText(screen, "button", "Make a plan"));
      const plan = await waitFor(() => screen.querySelector<HTMLElement>("[data-plan]"), "the plan");
      expect(plan.querySelector("[data-plan-label]")!.textContent).toBe(SPREAD_RISK_LABEL);
      const execute = () => plan.querySelector<HTMLButtonElement>("[data-execute]")!;
      const signBtn = () => byText(plan, "button", "Sign the acknowledgement") as HTMLButtonElement | null;
      expect(execute().disabled).toBe(true);
      expect(signBtn()!.disabled).toBe(true); // the box comes first
      // ticking the box alone does not enable Execute
      await click(plan.querySelector("[data-ack-box]"));
      expect(execute().disabled).toBe(true);
      expect(acks).toEqual([]);
      await click(signBtn());
      await waitFor(() => !execute().disabled, "Execute enabled");
      // the signature covers the exact ack text, signed by the owner's main wallet
      expect(acks.length).toBe(1);
      const a = acks[0]!;
      expect(a.message.split("\n")[0]).toBe("Capstan spread_ack");
      expect(a.message).toContain(`body: ${bodyHash(SPREAD_ACK_TEXT(PLAN.planId))}`);
      expect(recoverRsv(personalDigest(a.message), a.sig)!.toLowerCase()).toBe(d.wallet.owner);
      expect(plan.querySelector("[data-ack-text]")!.textContent).toBe(SPREAD_ACK_TEXT(PLAN.planId));
      // unticking the box turns Execute off again
      await click(plan.querySelector("[data-ack-box]"));
      expect(execute().disabled).toBe(true);
      await click(plan.querySelector("[data-ack-box]"));
      await click(execute());
      const log = await waitFor(() => screen.querySelector("[data-exec-log]"), "the execution log");
      expect(executed).toEqual([PLAN.planId]);
      expect(log.textContent).toContain("leg_a_sent on Lighter on Robinhood Chain");
      expect(log.textContent).toContain("finished: complete");

      // every element that says hedge carries the label next to it
      const all = Array.from(d.m.host.querySelectorAll<HTMLElement>("*")).filter((e) => Array.from(e.childNodes).some((n) => n.nodeType === 3 && /hedg/i.test(n.textContent ?? "")));
      expect(all.length).toBeGreaterThanOrEqual(3);
      for (const e of all) expect({ text: e.textContent, labelled: (e.closest("[data-hedge]") ?? e).textContent!.includes(SPREAD_RISK_LABEL) }).toEqual({ text: e.textContent, labelled: true });
    } finally {
      await d.stop();
    }
  }, 30_000);
});
