// R1: every humanReadable line is on screen before the first wallet prompt, and a bundle the SDK rejects stops the
// ceremony with no prompt at all. R2: the builder step in plain words ("max 0.03%", Aster 0.0003) and the
// fee_free_unavailable path with no order ticket for that venue.
import { describe, expect, test } from "bun:test";
import { describeBundle, mergePins, PINS, type Hex, type OnboardingBundle } from "../../src/lib/capstan";
import { byText, click, waitFor } from "../helpers";
import { go, stackPins, startDash, T0, toConfirm } from "./harness";

const builtBundle = (reqs: { url: string; response?: unknown }[]) => reqs.find((r) => r.url.endsWith("/onboarding/build"))?.response as OnboardingBundle;

describe("onboarding", () => {
  test("render-then-sign", async () => {
    const d = await startDash();
    try {
      const panel = await toConfirm(d);
      expect(panel.hasAttribute("data-confirm")).toBe(true);
      // nothing signed yet: the lines are on screen and the wallet has not been asked
      expect(d.wallet.signs()).toEqual([]);
      const bundle = builtBundle(d.requests);
      const agentAddress = (bundle.steps.find((s) => s.kind === "hl_approve_agent")!.typedData!.message as { agentAddress: Hex }).agentAddress;
      const pins = mergePins(PINS, await stackPins(d.stack));
      const expected = describeBundle(bundle, { venue: "hyperliquid", network: "mainnet", pins, owner: d.wallet.owner, nowMs: T0, agentAddress });
      const shown = Array.from(panel.querySelectorAll("[data-lines] li")).map((l) => l.textContent);
      expect(shown).toEqual(expected);
      expect(shown.length).toBe(bundle.humanReadable.length);
      expect(shown.length).toBe(bundle.steps.length);

      await click(byText(d.m.host, "button", "Continue to your wallet"));
      await waitFor(() => d.m.host.querySelector("[data-delegation]"), "the active delegation", 15_000);
      // at the first prompt every line was already on the page
      expect(d.atPrompt.length).toBeGreaterThanOrEqual(2);
      for (const l of expected) expect(d.atPrompt[0]!.text).toContain(l);
      expect(d.wallet.signs().map((c) => c.primaryType)).toEqual(bundle.steps.filter((s) => s.typedData).map((s) => s.typedData!.primaryType));
      // the success state: the agent address and the receipt, never key material
      expect(d.m.host.querySelector("[data-agent-address]")!.textContent!.toLowerCase()).toBe(agentAddress.toLowerCase());
      expect(d.m.host.textContent).toContain("Receipt r");
    } finally {
      await d.stop();
    }

    // a bundle the SDK does not accept (the builder ceiling raised): refused before any prompt, no key kept
    const bad = await startDash({
      stack: {
        tamper: {
          bundle: (b) => {
            const step = b.steps.find((s) => s.kind === "hl_approve_builder_fee")!;
            (step.typedData!.message as Record<string, unknown>).maxFeeRate = "0.05%";
            return b;
          },
        },
      },
    });
    try {
      const panel = await toConfirm(bad);
      expect(panel.hasAttribute("data-onboarding-error")).toBe(true);
      expect(panel.textContent).toContain("The SDK refused the onboarding bundle from the server");
      expect(panel.textContent).toContain("Your wallet was not asked to sign anything.");
      expect(bad.m.host.querySelector("[data-confirm]")).toBeNull();
      expect(bad.wallet.signs()).toEqual([]);
      expect(bad.atPrompt).toEqual([]);
      expect(await bad.keystore.list()).toEqual([]);
    } finally {
      await bad.stop();
    }
  }, 60_000);

  test("builder-step", async () => {
    // Hyperliquid: the ceiling in plain words
    const d = await startDash();
    try {
      await toConfirm(d);
      const line = d.m.host.querySelector("[data-builder-line]")!.textContent!;
      expect(line).toContain("max 0.03%");
      expect(line).toContain("3 bps");
      // decline: no prompt, fee_free_unavailable explained, no order ticket for the venue
      await click(byText(d.m.host, "button", "Decline the builder fee"));
      const note = await waitFor(() => d.m.host.querySelector("[data-fee-free]"), "the fee_free_unavailable note");
      expect(note.textContent).toContain("fee_free_unavailable");
      expect(note.textContent).toContain("does not build orders for Hyperliquid");
      expect(d.wallet.signs()).toEqual([]);
      expect(await d.keystore.list()).toEqual([]);
      await go(d, "Order");
      await waitFor(() => d.m.host.querySelector("[data-screen=order]"), "the order screen");
      expect(d.m.host.querySelector("[data-ticket]")).toBeNull();
      expect(d.m.host.querySelector("[data-no-ticket]")).not.toBeNull();
      expect(d.m.host.querySelector("[data-fee-free=hyperliquid]")!.textContent).toContain("fee_free_unavailable");
    } finally {
      await d.stop();
    }

    // a wallet that refuses the ApproveBuilderFee prompt lands in the same state
    const r = await startDash();
    try {
      r.wallet.rejectType = /ApproveBuilderFee/;
      await toConfirm(r);
      await click(byText(r.m.host, "button", "Continue to your wallet"));
      const note = await waitFor(() => r.m.host.querySelector("[data-fee-free]"), "the fee_free_unavailable note", 15_000);
      expect(note.textContent).toContain("fee_free_unavailable");
      expect(r.wallet.signs().some((c) => /ApproveBuilderFee/.test(c.primaryType ?? ""))).toBe(true);
      expect(await r.keystore.list()).toEqual([]);
    } finally {
      await r.stop();
    }

    // Aster: max 0.03% shown as 0.0003
    const a = await startDash();
    try {
      const panel = await toConfirm(a, "aster");
      expect(panel.hasAttribute("data-confirm")).toBe(true);
      const line = a.m.host.querySelector("[data-builder-line]")!.textContent!;
      expect(line).toContain("max 0.03%");
      expect(line).toContain("0.0003");
      expect(a.wallet.signs()).toEqual([]);
      await click(byText(a.m.host, "button", "Decline the builder fee"));
      const note = await waitFor(() => a.m.host.querySelector("[data-fee-free]"), "the fee_free_unavailable note");
      expect(note.textContent).toContain("does not build orders for Aster");
    } finally {
      await a.stop();
    }
  }, 60_000);
});
