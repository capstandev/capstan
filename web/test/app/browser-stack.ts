// The dashboard in headless Chromium on the local stack: the SDK test stack (fake Hyperliquid venue, stand-in API
// with the real adapter and receipts library) behind a CORS proxy, a fork-profile build of the site pointed at it,
// and an EIP-6963 test wallet whose signing runs in the test process (the page only sees an EIP-1193 provider).
// The proxy also answers /v1/quote and /v1/risk from fixtures, because the stand-in API has no quote or risk route.
import type { Browser, Page } from "playwright-core";
import { startStack } from "../../../packages/sdk/test/stack";
import { buildOnce, serveDist, waitForPreloader, withBrowser } from "../browser";
import { quote, VIEW } from "./fixtures";
import { stackPins, T0, testWallet, type TestWallet } from "./harness";

export interface BrowserDash {
  page: Page;
  site: string;
  stack: Awaited<ReturnType<typeof startStack>>;
  wallet: TestWallet;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" };

export async function withDashboard<T>(viewport: { width: number; height: number }, fn: (d: BrowserDash, browser: Browser) => Promise<T>): Promise<T> {
  const stack = await startStack();
  const wallet = testWallet({ chainId: 31337 });
  const proxy = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (u.pathname === "/api/v1/quote") return Response.json(quote("hyperliquid:xyz:TSLA"), { headers: CORS });
      if (u.pathname === "/api/v1/risk") return Response.json({ ...VIEW, owner: wallet.owner }, { headers: CORS });
      let target: string;
      if (u.pathname.startsWith("/api/")) target = `${stack.apiBase.replace(/\/v1$/, "")}${u.pathname.slice(4)}${u.search}`;
      else if (u.pathname.startsWith("/venue/")) target = `${stack.venue.url}${u.pathname.slice(6)}${u.search}`;
      else return new Response("not found", { status: 404, headers: CORS });
      const r = await fetch(target, { method: req.method, headers: { "content-type": req.headers.get("content-type") ?? "application/json" }, ...(req.method === "GET" ? {} : { body: await req.text() }) });
      const h = new Headers({ "content-type": r.headers.get("content-type") ?? "application/json", ...CORS });
      return new Response(await r.arrayBuffer(), { status: r.status, headers: h });
    },
  });
  const proxyUrl = `http://127.0.0.1:${proxy.port}`;
  const pins = await stackPins(stack);
  const dist = await buildOnce({
    VITE_PROFILE: "fork",
    VITE_NETWORK: "mainnet",
    VITE_API_BASE: `${proxyUrl}/api/v1`,
    VITE_PINS: JSON.stringify(pins),
    VITE_VENUE_HOSTS: JSON.stringify({ hyperliquid: `${proxyUrl}/venue` }),
    VITE_RECEIPT_SIGNERS: JSON.stringify([stack.receiptSigner]),
  });
  const srv = serveDist(dist);
  try {
    return await withBrowser(async (browser) => {
      const ctx = await browser.newContext({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
      const page = await ctx.newPage();
      await page.clock.setFixedTime(T0);
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
        return await fn({ page, site: srv.url, stack, wallet }, browser);
      } finally {
        await ctx.close();
      }
    });
  } finally {
    srv.stop();
    proxy.stop(true);
    stack.stop();
  }
}

/** The dashboard's Trade view (the owner's sidebar button), where the SDK flow screens live. */
export async function openTrade(p: Page, site: string): Promise<void> {
  await p.goto(`${site}/dashboard`, { waitUntil: "networkidle" });
  await waitForPreloader(p);
  await p.locator('.dash-nav[data-view="trade"]').click();
  await p.locator('[data-live="trade"] [data-screen="connect"]').waitFor();
}

/** A sub-screen of the Trade view (the SDK screens' own navigation). */
export const tradeNav = (p: Page, name: string) => p.getByRole("navigation", { name: "Dashboard", exact: true }).getByRole("link", { name, exact: true }).click();

/** Connect the test wallet and onboard Hyperliquid through the real screens. */
export async function connectAndOnboard(d: BrowserDash, shot?: (name: string) => Promise<void>): Promise<void> {
  const p = d.page;
  await openTrade(p, d.site);
  await p.getByRole("button", { name: "Connect Test Wallet" }).click();
  await p.locator("[data-connected]").waitFor();
  await shot?.("connected");
  await p.getByRole("link", { name: "Hyperliquid", exact: true }).click();
  await p.getByRole("button", { name: /Start onboarding/ }).click();
  await p.locator("[data-confirm]").waitFor();
  await shot?.("onboarding-steps");
  await p.getByRole("button", { name: "Continue to your wallet" }).click();
  await p.locator("[data-delegation]").waitFor({ timeout: 20_000 });
  await shot?.("onboarding-done");
}
