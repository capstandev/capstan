// R10 (acceptance only): the browser pass. Headless Chromium clicks through the dashboard on the local stack: connect,
// onboarding on the fake Hyperliquid venue, quote, order (SDK check, sign, send), risk, receipt verification and the
// kill switch. A screenshot per step goes to the private docs repo (docs/reviews/web-pass-<date>/), never into this
// repo. Runs only with CAPSTAN_WEB_E2E=1 (`bun run test:e2e`); one browser at a time.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromiumPath, WEB } from "../browser";
import { connectAndOnboard, tradeNav, withDashboard } from "../app/browser-stack";

const RUN = process.env.CAPSTAN_WEB_E2E === "1";
const OUT = resolve(process.env.CAPSTAN_WEB_PASS_DIR ?? join(WEB, "../../docs/reviews", `web-pass-${new Date().toISOString().slice(0, 10)}`));

describe("browser pass", () => {
  test.skipIf(!RUN || !chromiumPath())("pass", async () => {
    mkdirSync(OUT, { recursive: true });
    const steps: { n: number; step: string; file: string }[] = [];
    await withDashboard({ width: 1280, height: 900 }, async (d) => {
      const p = d.page;
      const shot = async (name: string) => {
        const n = steps.length + 1;
        const file = `${String(n).padStart(2, "0")}-${name}.png`;
        await p.screenshot({ path: join(OUT, file), fullPage: true });
        steps.push({ n, step: name, file });
      };
      await p.goto(`${d.site}/`, { waitUntil: "networkidle" });
      await expect(p.locator("[data-fork-banner]").textContent()).resolves.toBe("Local test network");
      await shot("landing");

      // onboarding on the fake venue: the steps are on screen before the wallet is asked
      await connectAndOnboard(d, shot);
      expect(d.wallet.signs().length).toBeGreaterThanOrEqual(2);

      // quote
      await tradeNav(p, "Quote");
      await p.getByRole("button", { name: "Get quote" }).click();
      await p.locator("[data-quote-table]").waitFor();
      expect(await p.locator("tr.data-only [data-col=status]").textContent()).toBe("data only");
      await shot("quote");

      // order: the SDK checks the build, then the local key signs and the relay sends it
      await tradeNav(p, "Order");
      await p.getByRole("button", { name: "Check the order" }).click();
      await p.locator("[data-order-preview], [data-screen=order] [role=alert]").first().waitFor({ timeout: 20_000 });
      if (await p.locator("[data-screen=order] [role=alert]").count()) throw new Error(`order check failed: ${await p.locator("[data-screen=order] [role=alert]").textContent()}`);
      await shot("order-checked");
      await p.getByRole("button", { name: "Sign and send" }).click();
      await p.locator("[data-order-result]").waitFor({ timeout: 20_000 });
      const receiptId = (await p.locator("[data-order-result] a").textContent())!.trim();
      expect(receiptId).toMatch(/^r\d{6}$/);
      await shot("order-sent");

      // risk: one card per venue under the banner
      await tradeNav(p, "Risk");
      await p.getByRole("button", { name: /Read my venue accounts/ }).click();
      await p.locator("[data-risk-view]").waitFor();
      expect(await p.locator("[data-venue-card]").count()).toBe(2);
      await shot("risk");

      // receipt verification in the browser
      await p.goto(`${d.site}/verify?id=${receiptId}`, { waitUntil: "networkidle" });
      await p.getByRole("button", { name: "Verify" }).click();
      await p.locator("[data-verify-result]").waitFor({ timeout: 20_000 });
      expect(await p.locator("[data-verify-result]").getAttribute("data-verify-result")).toBe("valid");
      await shot("receipt-verified");

      // kill: the relay refuses the key, the key is wiped, the revocation steps are shown
      // a page load starts a new session: the key is still in IndexedDB but not loaded, so onboard again to kill
      await connectAndOnboard(d);
      await tradeNav(p, "Policy and kill");
      await p.getByRole("button", { name: "Kill this key" }).click();
      await p.locator("[data-kill-result]").waitFor({ timeout: 20_000 });
      expect(await p.locator("[data-kill-result]").textContent()).toContain("Only your wallet can revoke the venue key.");
      await shot("killed");
      expect(d.stack.kills.length).toBe(1);
    });
    writeFileSync(join(OUT, "pass.json"), `${JSON.stringify({ ranAt: new Date().toISOString(), stack: "packages/sdk/test/stack.ts (fake Hyperliquid venue, stand-in API); quote and risk from fixtures", steps }, null, 2)}\n`);
    console.log(`browser pass: ${steps.length} screenshots in ${OUT}`);
  }, 300_000);
});
