// Todo 40 browser pass on the FORK stack (ops/fork/up.sh): the dev server on the fork profile (22473) talking to the
// real api (22410), the Hyperliquid stand-in (22420) and the RHC fork RPC (22445), with an EIP-6963 test wallet whose
// signing runs in this process (the page only sees an EIP-1193 provider). Desktop 1280 px for the full flow (connect,
// onboarding, quote, order, risk, receipt check against the fork anchor, kill), then the same screens at 390 px.
// Screenshots go to the private docs folder next to the repo, never into it. Runs only with CAPSTAN_WEB_FORK=1.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright-core";
import { chromiumPath, WEB, withBrowser } from "../browser";
import { testWallet } from "../app/harness";

const RUN = process.env.CAPSTAN_WEB_FORK === "1";
const SITE = process.env.CAPSTAN_FORK_SITE ?? "http://127.0.0.1:22473";
const OUT = resolve(process.env.CAPSTAN_WEB_PASS_DIR ?? join(WEB, "../../docs/reviews", `web-pass-${new Date().toISOString().slice(0, 10)}`, "fork-stack"));

async function withWallet<T>(viewport: { width: number; height: number }, fn: (p: Page, wallet: ReturnType<typeof testWallet>) => Promise<T>): Promise<T> {
  const wallet = testWallet({ label: `fork-pass-${Date.now()}-${viewport.width}`, chainId: 31337 });
  return withBrowser(async (browser) => {
    const ctx = await browser.newContext({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    const page = await ctx.newPage();
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
      return await fn(page, wallet);
    } finally {
      await ctx.close();
    }
  });
}

describe("fork browser pass", () => {
  test.skipIf(!RUN || !chromiumPath())("fork-pass", async () => {
    mkdirSync(OUT, { recursive: true });
    const steps: { n: number; step: string; file: string; note?: string }[] = [];
    const shooter = (p: Page, prefix: string) => async (name: string, note?: string) => {
      const file = `${prefix}-${String(steps.length + 1).padStart(2, "0")}-${name}.png`;
      await p.screenshot({ path: join(OUT, file), fullPage: true });
      steps.push({ n: steps.length + 1, step: `${prefix} ${name}`, file, ...(note ? { note } : {}) });
    };
    const nav = (p: Page, name: string) => p.getByRole("navigation", { name: "Dashboard" }).getByRole("link", { name, exact: true }).click();

    let receiptId = "";
    await withWallet({ width: 1280, height: 900 }, async (p) => {
      const shot = shooter(p, "desktop");
      await p.goto(`${SITE}/`, { waitUntil: "networkidle" });
      expect(await p.locator("[data-fork-banner]").textContent()).toBe("Local test network");
      await shot("landing");
      await p.goto(`${SITE}/app`, { waitUntil: "networkidle" });
      await p.getByRole("button", { name: "Connect Test Wallet" }).click();
      await p.locator("[data-connected]").waitFor();
      await shot("connected");
      await p.getByRole("link", { name: "Hyperliquid", exact: true }).click();
      await p.getByRole("button", { name: /Start onboarding/ }).click();
      await p.locator("[data-confirm]").waitFor({ timeout: 90_000 });
      await shot("onboarding-steps");
      await p.getByRole("button", { name: "Continue to your wallet" }).click();
      await p.locator("[data-delegation], [role=alert]").first().waitFor({ timeout: 90_000 });
      if (!(await p.locator("[data-delegation]").count())) throw new Error(`onboarding failed: ${await p.locator("[role=alert]").first().textContent()}`);
      await shot("onboarding-done");
      await nav(p, "Quote");
      await p.getByRole("button", { name: "Get quote" }).click();
      await p.locator("[data-quote-table], [role=alert]").first().waitFor({ timeout: 90_000 });
      await shot("quote");
      await nav(p, "Order");
      await p.getByRole("button", { name: "Check the order" }).click();
      await p.locator("[data-order-preview], [data-screen=order] [role=alert]").first().waitFor({ timeout: 90_000 });
      if (await p.locator("[data-screen=order] [role=alert]").count()) throw new Error(`order check failed: ${await p.locator("[data-screen=order] [role=alert]").textContent()}`);
      await shot("order-checked");
      await p.getByRole("button", { name: "Sign and send" }).click();
      await p.locator("[data-order-result], [data-screen=order] [role=alert]").first().waitFor({ timeout: 90_000 });
      if (!(await p.locator("[data-order-result]").count())) throw new Error(`order send failed: ${await p.locator("[data-screen=order] [role=alert]").textContent()}`);
      receiptId = (await p.locator("[data-order-result] a").textContent())!.trim();
      await shot("order-sent", `receipt ${receiptId}`);
      await nav(p, "Risk");
      await p.getByRole("button", { name: /Read my venue accounts/ }).click();
      await p.locator("[data-risk-view], [role=alert]").first().waitFor({ timeout: 90_000 });
      await shot("risk");
      await p.goto(`${SITE}/verify?id=${receiptId}`, { waitUntil: "networkidle" });
      await p.getByRole("button", { name: "Verify" }).click();
      await p.locator("[data-verify-result]").waitFor({ timeout: 90_000 });
      await shot("receipt-verified", `result ${await p.locator("[data-verify-result]").getAttribute("data-verify-result")}`);
      await p.goto(`${SITE}/app`, { waitUntil: "networkidle" });
      await p.getByRole("button", { name: "Connect Test Wallet" }).click();
      await p.locator("[data-connected]").waitFor();
      await p.getByRole("link", { name: "Hyperliquid", exact: true }).click();
      await p.getByRole("button", { name: /Start onboarding/ }).click();
      await p.locator("[data-confirm]").waitFor({ timeout: 90_000 });
      await p.getByRole("button", { name: "Continue to your wallet" }).click();
      await p.locator("[data-delegation]").waitFor({ timeout: 90_000 });
      await nav(p, "Policy and kill");
      await p.getByRole("button", { name: "Kill this key" }).click();
      await p.locator("[data-kill-result], [role=alert]").first().waitFor({ timeout: 90_000 });
      await shot("killed");
      expect(await p.locator("[data-kill-result]").textContent()).toContain("Only your wallet can revoke the venue key.");
    });

    // phone width: the same screens at 390 px
    await withWallet({ width: 390, height: 844 }, async (p) => {
      const shot = shooter(p, "phone");
      for (const path of ["/", "/docs", "/pricing", "/status"]) {
        await p.goto(`${SITE}${path}`, { waitUntil: "networkidle" });
        const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        await shot(path === "/" ? "landing" : path.slice(1), `horizontal overflow ${over} px`);
        expect(over).toBeLessThanOrEqual(0);
      }
      await p.goto(`${SITE}/app`, { waitUntil: "networkidle" });
      await p.getByRole("button", { name: "Connect Test Wallet" }).click();
      await p.locator("[data-connected]").waitFor();
      await p.getByRole("link", { name: "Hyperliquid", exact: true }).click();
      await p.getByRole("button", { name: /Start onboarding/ }).click();
      await p.locator("[data-confirm]").waitFor({ timeout: 90_000 });
      await shot("onboarding-steps");
      await p.getByRole("button", { name: "Continue to your wallet" }).click();
      await p.locator("[data-delegation]").waitFor({ timeout: 90_000 });
      await shot("onboarding-done");
      await nav(p, "Quote");
      await p.getByRole("button", { name: "Get quote" }).click();
      await p.locator("[data-quote-table], [role=alert]").first().waitFor({ timeout: 90_000 });
      await shot("quote", `horizontal overflow ${await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)} px`);
      if (receiptId) {
        await p.goto(`${SITE}/verify?id=${receiptId}`, { waitUntil: "networkidle" });
        await p.getByRole("button", { name: "Verify" }).click();
        await p.locator("[data-verify-result]").waitFor({ timeout: 90_000 });
        await shot("receipt-verified");
      }
    });
    writeFileSync(join(OUT, "pass.json"), `${JSON.stringify({ ranAt: new Date().toISOString(), stack: "ops/fork/up.sh: real api, relay, workers, mcp, facilitator on an anvil fork of RHC 4663; Hyperliquid stand-in", site: SITE, steps }, null, 2)}\n`);
    console.log(`fork browser pass: ${steps.length} screenshots in ${OUT}`);
  }, 1_200_000);
});
