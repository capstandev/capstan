// The site browser pass on the FORK stack (ops/fork/up.sh with FORK_WEB=dist: the built site, hashed names and clean
// URLs, on the fork profile, talking to the real api, relay and workers on an anvil fork of Robinhood Chain and the
// Hyperliquid stand-in). Every page at 1440 px and 390 px: no console errors, no sideways scroll at 390, and the live
// values render where the page has them. Then the dashboard's SDK flow (connect, onboard, quote, order, risk,
// receipt check, kill) with an EIP-6963 test wallet whose signing runs in this process. A full-page screenshot per
// step goes to the private docs folder (CAPSTAN_WEB_PASS_DIR), never into this repo. Runs only with CAPSTAN_WEB_FORK=1.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright-core";
import { chromiumPath, SITE_PAGES, waitForPreloader, WEB, withBrowser } from "../browser";
import { testWallet } from "../app/harness";
import { tradeNav } from "../app/browser-stack";

const RUN = process.env.CAPSTAN_WEB_FORK === "1";
const SITE = process.env.CAPSTAN_FORK_SITE ?? "http://127.0.0.1:22473";
const OUT = resolve(process.env.CAPSTAN_WEB_PASS_DIR ?? join(WEB, "../../docs/reviews", `site-pass-${new Date().toISOString().slice(0, 10)}`));

/** What each page must show from the API once it has loaded (a selector that only matches a live value). */
export const LIVE_CHECKS: Record<string, string | null> = {
  index: "[data-disclaimer]",
  markets: '[data-live="markets"] [data-funding-row], #bl-detail-visual [data-live-value]',
  quotes: "[data-quote-leg] [data-col=venue-fee]",
  risk: '[data-live="risk"] [data-connect-strip] button, [data-live="risk"] [data-connected]',
  pricing: "#fee-result",
  dashboard: ".stats-grid strong[data-live-value]",
  status: '[data-status="api"] dd',
  docs: "table.ops tbody tr",
  verify: "#cap-live form",
  legal: "#cap-live [data-disclaimer]",
  "404": "#cap-live h1",
};

/** Console lines that are not page errors: the 404 page's own status, and Chromium's note about the media codecs of
 * the headless shell (it ships without the proprietary H.264 decoder the owner's mp4 clips use). */
const IGNORED = [/status of 404/, /MEDIA_ERR|DEMUXER_ERROR|media.*not supported|NotSupportedError: Failed to load because no supported source/i];

async function withWallet<T>(viewport: { width: number; height: number }, fn: (p: Page, errors: string[]) => Promise<T>): Promise<T> {
  const wallet = testWallet({ label: `site-pass-${Date.now()}-${viewport.width}`, chainId: 31337 });
  return withBrowser(async (browser) => {
    const ctx = await browser.newContext({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && !IGNORED.some((r) => r.test(m.text()))) errors.push(`${page.url()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => errors.push(`${page.url()}: ${String(e)}`));
    // name the request behind any "Failed to load resource" line
    page.on("response", (r) => {
      if (r.status() >= 400 && !/\/no-such-page$/.test(r.url())) errors.push(`${page.url()}: ${r.status()} ${r.request().method()} ${r.url()}`);
    });
    await page.exposeFunction("__capstanTestWallet", async (method: string, params: string) => {
      try {
        return JSON.stringify({ result: await wallet.provider.request({ method, params: JSON.parse(params) as unknown[] }) });
      } catch (e) {
        return JSON.stringify({ error: { message: (e as Error).message, code: (e as { code?: number }).code ?? -32603 } });
      }
    });
    await page.addInitScript(() => {
      const w = window as unknown as { __capstanTestWallet(m: string, p: string): Promise<string> };
      const provider = {
        async request(a: { method: string; params?: unknown[] }) {
          const j = JSON.parse(await w.__capstanTestWallet(a.method, JSON.stringify(a.params ?? []))) as { result?: unknown; error?: { message: string; code: number } };
          if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
          return j.result;
        },
      };
      const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "test-wallet", name: "Test Wallet", icon: "data:image/svg+xml,", rdns: "test.capstan" }, provider }) }));
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    });
    try {
      return await fn(page, errors);
    } finally {
      await ctx.close();
    }
  });
}

describe("site pass", () => {
  test.skipIf(!RUN || !chromiumPath())("site-pass", async () => {
    mkdirSync(OUT, { recursive: true });
    const steps: { step: string; file: string; width: number; note?: string }[] = [];
    const pages: { page: string; width: number; scrollWidth: number; viewport: number; live: string | null; errors: string[] }[] = [];
    const shoot = async (p: Page, width: number, name: string, note?: string) => {
      const file = `${width}-${String(steps.length + 1).padStart(2, "0")}-${name}.png`;
      await p.screenshot({ path: join(OUT, file), fullPage: true });
      steps.push({ step: name, file, width, ...(note ? { note } : {}) });
    };

    for (const width of [1440, 390]) {
      await withWallet({ width, height: width < 500 ? 844 : 900 }, async (p, errors) => {
        for (const name of SITE_PAGES) {
          const before = errors.length;
          const path = name === "index" ? "/" : name === "404" ? "/no-such-page" : `/${name}`;
          await p.goto(`${SITE}${path}`, { waitUntil: "networkidle" });
          await waitForPreloader(p);
          expect(await p.locator("[data-fork-banner]").textContent()).toBe("Local test network");
          const sel = LIVE_CHECKS[name] ?? null;
          let live: string | null = null;
          if (sel) {
            await p.locator(sel).first().waitFor({ timeout: 30_000 });
            live = ((await p.locator(sel).first().textContent()) ?? "").trim().slice(0, 80);
          }
          // the owner's motion settles before the picture
          await p.waitForTimeout(600);
          const m = (await p.evaluate(() => ({ sw: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), vw: document.documentElement.clientWidth }))) as { sw: number; vw: number };
          await shoot(p, width, name, sel ? `live: ${live}` : undefined);
          pages.push({ page: name, width, scrollWidth: m.sw, viewport: m.vw, live, errors: errors.slice(before) });
          if (width < 500) expect({ name, scrollWidth: m.sw }).toEqual({ name, scrollWidth: m.vw });
        }
        // live values, not placeholders: the dashboard counts markets, the markets page shows funding rows
        if (width === 1440) {
          await p.goto(`${SITE}/dashboard`, { waitUntil: "networkidle" });
          await waitForPreloader(p);
          await p.locator(".stats-grid strong[data-live-value]").first().waitFor({ timeout: 30_000 });
          expect(Number(await p.locator(".stats-grid strong").first().textContent())).toBeGreaterThan(0);

          // the SDK flow in the owner's dashboard: Trade view
          await p.locator('.dash-nav[data-view="trade"]').click();
          await p.getByRole("button", { name: "Connect Test Wallet" }).click();
          await p.locator("[data-connected]").waitFor();
          await shoot(p, width, "trade-connected");
          await p.getByRole("link", { name: "Hyperliquid", exact: true }).click();
          await p.getByRole("button", { name: /Start onboarding/ }).click();
          await p.locator("[data-confirm]").waitFor({ timeout: 90_000 });
          await shoot(p, width, "trade-onboarding-steps");
          await p.getByRole("button", { name: "Continue to your wallet" }).click();
          await p.locator("[data-delegation], [data-live=trade] [role=alert]").first().waitFor({ timeout: 90_000 });
          if (!(await p.locator("[data-delegation]").count())) throw new Error(`onboarding failed: ${await p.locator("[data-live=trade] [role=alert]").first().textContent()}`);
          await shoot(p, width, "trade-onboarding-done");
          await tradeNav(p, "Quote");
          await p.getByRole("button", { name: "Get quote" }).click();
          await p.locator("[data-quote-table], [data-live=trade] [role=alert]").first().waitFor({ timeout: 90_000 });
          await shoot(p, width, "trade-quote");
          await tradeNav(p, "Order");
          await p.getByRole("button", { name: "Check the order" }).click();
          await p.locator("[data-order-preview], [data-screen=order] [role=alert]").first().waitFor({ timeout: 90_000 });
          if (await p.locator("[data-screen=order] [role=alert]").count()) throw new Error(`order check failed: ${await p.locator("[data-screen=order] [role=alert]").textContent()}`);
          await shoot(p, width, "trade-order-checked");
          await p.getByRole("button", { name: "Sign and send" }).click();
          await p.locator("[data-order-result], [data-screen=order] [role=alert]").first().waitFor({ timeout: 90_000 });
          if (!(await p.locator("[data-order-result]").count())) throw new Error(`order send failed: ${await p.locator("[data-screen=order] [role=alert]").textContent()}`);
          const receiptId = (await p.locator("[data-order-result] a").textContent())!.trim();
          await shoot(p, width, "trade-order-sent", `receipt ${receiptId}`);
          // risk, venue by venue, in the owner's Risk view
          await p.locator('.dash-nav[data-view="risk"]').click();
          await p.getByRole("button", { name: /Read my venue accounts/ }).click();
          await p.locator("[data-risk-view], [data-live=risk] [role=alert]").first().waitFor({ timeout: 90_000 });
          await shoot(p, width, "dashboard-risk");
          await p.locator('.dash-nav[data-view="activity"]').click();
          await p.locator('[data-live="activity"] [data-session-receipts]').waitFor();
          await shoot(p, width, "dashboard-activity");
          // kill, in the same session (the trade-only key is loaded): the relay refuses the key, the key is wiped
          await p.locator('.dash-nav[data-view="trade"]').click();
          await tradeNav(p, "Policy and kill");
          await p.getByRole("button", { name: "Kill this key" }).click();
          await p.locator("[data-kill-result], [data-live=trade] [role=alert]").first().waitFor({ timeout: 90_000 });
          await shoot(p, width, "trade-killed");
          expect(await p.locator("[data-kill-result]").textContent()).toContain("Only your wallet can revoke the venue key.");
          // the order's receipt on the verify page (signature and leaf checked in the browser; the hourly root is
          // posted when the hour closes, so a fresh receipt reads pending until then)
          await p.goto(`${SITE}/verify?id=${encodeURIComponent(receiptId)}`, { waitUntil: "networkidle" });
          await waitForPreloader(p);
          await p.getByRole("button", { name: "Verify" }).click();
          await p.locator("[data-verify-result]").waitFor({ timeout: 90_000 });
          const result = await p.locator("[data-verify-result]").getAttribute("data-verify-result");
          await shoot(p, width, "receipt-verified", `result ${result}`);
          expect(["valid", "pending"]).toContain(result as string);
        } else {
          // phone: the trade view with a quote
          await p.goto(`${SITE}/dashboard`, { waitUntil: "networkidle" });
          await waitForPreloader(p);
          await p.locator('.dash-nav[data-view="trade"]').click();
          await p.getByRole("button", { name: "Connect Test Wallet" }).click();
          await p.locator("[data-connected]").waitFor();
          await tradeNav(p, "Quote");
          await p.getByRole("button", { name: "Get quote" }).click();
          await p.locator("[data-quote-table], [data-live=trade] [role=alert]").first().waitFor({ timeout: 90_000 });
          const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          await shoot(p, width, "trade-quote", `horizontal overflow ${over} px`);
          expect(over).toBe(0);
        }
        expect(errors).toEqual([]);
      });
    }
    writeFileSync(join(OUT, "pass.json"), `${JSON.stringify({ ranAt: new Date().toISOString(), site: SITE, stack: "ops/fork/up.sh FORK_WEB=dist: built site on the fork profile; real api, relay, workers on an anvil fork of RHC 4663; Hyperliquid stand-in", pages, steps }, null, 2)}\n`);
    console.log(`site pass: ${pages.length} page loads, ${steps.length} screenshots in ${OUT}`);
  }, 1_800_000);
});
