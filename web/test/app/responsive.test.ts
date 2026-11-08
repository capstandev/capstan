// R8: at 390 px every dashboard Trade screen fits without sideways scroll and every wallet prompt button (and every other
// button) is at least 44 px tall and wide, so it can be reached with one hand. Headless Chromium on the local stack.
import { describe, expect, test } from "bun:test";
import { DASH_NAV } from "../../src/app/Dashboard";
import { chromiumPath, measureIn, SKIP_NO_CHROMIUM } from "../browser";
import { openTrade, tradeNav, withDashboard } from "./browser-stack";

const TARGETS = `(() => Array.from(document.querySelectorAll(".cap-live button, .cap-live a.button, .cap-live input:not([type=checkbox]):not([type=radio]), .cap-live select"))
  .filter((e) => e.offsetParent !== null)
  .map((e) => { const r = e.getBoundingClientRect(); return { what: (e.textContent || e.getAttribute("name") || e.tagName).trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
  .filter((t) => t.h < 44 || t.w < 44))()`;

describe("dashboard responsive", () => {
  test("dashboard-390px", async () => {
    if (!chromiumPath()) {
      console.warn(`responsive: ${SKIP_NO_CHROMIUM}`);
      return;
    }
    await withDashboard({ width: 390, height: 844 }, async (d) => {
      const p = d.page;
      const check = async (where: string) => {
        const m = (await p.evaluate(measureIn(".cap-live"))) as { vw: number; sw: number; small: string[] };
        expect({ where, overflow: m.sw > m.vw, small: m.small }).toEqual({ where, overflow: false, small: [] });
        expect({ where, tooSmall: await p.evaluate(TARGETS) }).toEqual({ where, tooSmall: [] });
      };
      await openTrade(p, d.site);
      await check("connect (not connected)");
      // the wallet prompt screen: the step list with its buttons, then the success state
      await p.getByRole("button", { name: "Connect Test Wallet" }).click();
      await p.locator("[data-connected]").waitFor();
      await check("connect (connected)");
      await p.getByRole("link", { name: "Hyperliquid", exact: true }).click();
      await p.getByRole("button", { name: /Start onboarding/ }).click();
      await p.locator("[data-confirm]").waitFor();
      await check("onboarding steps and wallet prompt buttons");
      await p.getByRole("button", { name: "Continue to your wallet" }).click();
      await p.locator("[data-delegation]").waitFor({ timeout: 20_000 });
      await check("onboarding done");
      for (const n of DASH_NAV) {
        await tradeNav(p, n.label);
        await p.locator('[data-live="trade"] [data-screen]').first().waitFor();
        await check(n.label);
      }
      console.log(`responsive: ${DASH_NAV.length + 4} dashboard states fit 390 px, every button at least 44 px`);
    });
  }, 180_000);
});
