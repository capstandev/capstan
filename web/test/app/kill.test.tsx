// R6: the Kill button signs, calls the SDK's kill, wipes the local key and shows the per-venue revocation steps under
// "Only your wallet can revoke the venue key".
import { describe, expect, test } from "bun:test";
import { personalDigest, recoverRsv } from "../../../packages/sdk/src/keys/secp";
import { byText, click, waitFor } from "../helpers";
import { go, onboard, startDash } from "./harness";

describe("kill", () => {
  test("wipe-and-steps", async () => {
    const d = await startDash();
    try {
      await onboard(d);
      const agent = d.m.host.querySelector("[data-agent-address]")!.textContent!.toLowerCase();
      expect((await d.keystore.list()).length).toBe(1);
      await go(d, "Policy and kill");
      await click(await waitFor(() => byText(d.m.host, "button", "Kill this key"), "the kill button"));
      const card = await waitFor(() => d.m.host.querySelector<HTMLElement>("[data-kill-result]"), "the kill result");

      // the SDK reached the relay with a signed kill for this agent
      expect(d.stack.kills.length).toBe(1);
      const k = d.stack.kills[0]!;
      expect(k.ref).toBe(`hl:${agent}`);
      const body = k.body as { sig: `0x${string}`; message: string };
      expect(body.message.split("\n")[0]).toBe("Capstan kill");
      // a Hyperliquid agent halts itself: the signature is the agent key's
      expect(recoverRsv(personalDigest(body.message), body.sig)!.toLowerCase()).toBe(agent);
      expect(card.textContent).toContain("Capstan's relay refuses this key from now on.");

      // the key is gone from the store and from the client
      expect(await d.keystore.list()).toEqual([]);
      expect(card.textContent).toContain("The key was wiped from this browser.");
      expect(d.m.host.textContent).toContain("No trade-only key in this browser.");

      // the owner's revocation steps, under the plain warning
      expect(card.textContent).toContain("Only your wallet can revoke the venue key.");
      const steps = Array.from(card.querySelectorAll("[data-revocation-steps] li")).map((l) => l.textContent);
      expect(steps.length).toBeGreaterThanOrEqual(1);
      for (const s of steps) expect(s!.length).toBeGreaterThan(10);
    } finally {
      await d.stop();
    }
  }, 30_000);
});
