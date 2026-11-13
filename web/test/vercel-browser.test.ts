// Vercel readiness (tracker 82): the production build, served with the exact headers vercel.json gives each path
// (scripts/vercel-headers.ts), works under its Content-Security-Policy in a real headless Chromium. Every page loads
// with no CSP violation and no page error, the official wallet picker (Reown AppKit) opens on /dashboard, and the
// Lighter signer Worker boots its wasm. Requests to other hosts are answered locally with an empty 204 (no live
// traffic): the CSP check runs in the browser before a request leaves it, so a blocked host still shows up here.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { buildOnce, chromiumPath, SITE_PATHS, SKIP_NO_CHROMIUM, waitForPreloader } from "./browser";
import { headersFor } from "../scripts/vercel-headers";

const PROD_ENV = { VITE_API_BASE: "https://api.get-capstan.com/v1", VITE_NETWORK: "mainnet", VITE_WALLETCONNECT_PROJECT_ID: "0123456789abcdef0123456789abcdef" };
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".mp4": "video/mp4", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain" };

/** Serve dist like Vercel with cleanUrls: /docs is docs.html, 404.html for the rest, vercel.json headers on every path. */
function serveLikeVercel(dir: string) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      let file = join(dir, path === "/" ? "index.html" : path);
      let status = 200;
      try {
        if (!extname(file)) file = `${file}.html`;
        readFileSync(file, { flag: "r" });
      } catch {
        file = join(dir, "404.html");
        status = 404;
      }
      // Chromium treats 127.0.0.1 as a secure context, but upgrade-insecure-requests would still rewrite the
      // loopback http:// subresources to https:// (which this server does not speak); on the https host it is a no-op.
      const headers = headersFor(path);
      headers["content-security-policy"] = (headers["content-security-policy"] ?? "").replace(/;\s*upgrade-insecure-requests/, "");
      return new Response(readFileSync(file), { status, headers: { ...headers, "content-type": TYPES[extname(file)] ?? "application/octet-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const skip = chromiumPath() === null;
if (skip) console.log(SKIP_NO_CHROMIUM);

type Problem = { page: string; kind: string; text: string };

async function withSite<T>(fn: (base: string, page: import("playwright-core").Page, problems: Problem[], dist: string) => Promise<T>): Promise<T> {
  const dist = await buildOnce(PROD_ENV);
  const site = serveLikeVercel(dist);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: chromiumPath()!, headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route(/^(?!http:\/\/127\.0\.0\.1)/, (r) => r.fulfill({ status: 204, body: "" }));
    const page = await ctx.newPage();
    const problems: Problem[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) problems.push({ page: page.url(), kind: "console", text: m.text() });
    });
    page.on("pageerror", (e) => problems.push({ page: page.url(), kind: "pageerror", text: String(e) }));
    page.on("response", (r) => {
      if (r.url().startsWith(site.url) && r.status() >= 400 && !/\/favicon\.ico$/.test(r.url())) problems.push({ page: page.url(), kind: `http ${r.status()}`, text: r.url().slice(site.url.length) });
    });
    page.on("requestfailed", (r) => {
      if (r.url().startsWith(site.url)) problems.push({ page: page.url(), kind: "requestfailed", text: `${r.url().slice(site.url.length)} ${r.failure()?.errorText ?? ""}` });
    });
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => console.error(`Refused to load: CSP ${e.violatedDirective} blocked ${e.blockedURI}`));
    });
    return await fn(site.url, page, problems, dist);
  } finally {
    await browser.close();
    site.stop();
  }
}

describe.skipIf(skip)("the production build under the vercel.json headers", () => {
  test("every page loads with no CSP violation and no page error", async () => {
    const problems = await withSite(async (base, page, problems) => {
      for (const p of SITE_PATHS) {
        const res = await page.goto(base + p, { waitUntil: "load" });
        expect(res?.headers()["content-security-policy"] ?? "").toContain("frame-ancestors 'none'");
        await waitForPreloader(page);
        await page.waitForTimeout(400);
      }
      return problems;
    });
    expect(problems).toEqual([]);
  }, 240_000);

  test("the wallet picker opens on /dashboard and the Lighter signer boots its wasm", async () => {
    const out = await withSite(async (base, page, problems, dist) => {
      await page.goto(`${base}/dashboard`, { waitUntil: "load" });
      await waitForPreloader(page);
      const trade = page.locator('.dash-nav[data-view="trade"]').first();
      await trade.waitFor({ timeout: 15_000 });
      await trade.click();
      const connect = page.locator('[data-live="trade"] [data-wallets] button').first();
      await connect.waitFor({ timeout: 15_000 });
      await connect.click();
      await page.waitForFunction(() => {
        const m = document.querySelector("w3m-modal");
        return !!m && !!m.shadowRoot && m.shadowRoot.innerHTML.length > 0 && getComputedStyle(m).display !== "none";
      }, undefined, { timeout: 20_000 });
      // The modal's shadow root fills in steps: the header and the first wallet row render before the rest of the
      // list. Wait for the WalletConnect row itself, then read the texts, so the read never races the list render.
      await page.locator("wui-text").filter({ hasText: /^\s*WalletConnect\s*$/ }).first().waitFor({ timeout: 20_000 });
      const picker = { open: await page.locator("w3m-modal").getAttribute("class"), texts: await page.locator("wui-text").allInnerTexts() };
      const app = readdirSync(join(dist, "_app"));
      const worker = app.find((f) => /^worker-.*\.mjs$/.test(f));
      const wasm = app.find((f) => /^lighter-signer-.*\.wasm$/.test(f));
      const exec = app.find((f) => /^wasm_exec-.*\.js$/.test(f));
      const boot = await page.evaluate(async ([w, b, e]) => {
        const [bytes, src] = await Promise.all([fetch(`/_app/${b}`).then((r) => r.arrayBuffer()), fetch(`/_app/${e}`).then((r) => r.text())]);
        const wk = new Worker(`/_app/${w}`, { type: "module" });
        const reply = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
          wk.onmessage = (ev) => resolve(ev.data);
          wk.onerror = (ev) => resolve({ ok: false, error: `worker error: ${ev.message}` });
          wk.postMessage({ id: 1, op: "boot", args: { wasm: new Uint8Array(bytes), wasmExecSource: src, chainId: 304, mode: "hasher" } });
        });
        wk.terminate();
        return reply;
      }, [worker, wasm, exec] as const);
      await page.waitForTimeout(500);
      return { picker, boot: { ok: boot.ok, error: boot.error }, problems };
    });
    expect(out.picker.open).toContain("open");
    expect(out.picker.texts).toContain("Connect Wallet");
    expect(out.picker.texts).toContain("WalletConnect");
    expect(out.boot).toEqual({ ok: true, error: undefined });
    expect(out.problems).toEqual([]);
  }, 180_000);

  test("/roadmap and /changelog serve 200 by clean URL and render under the CSP at 1440 and 390 px", async () => {
    const out = await withSite(async (base, page, problems) => {
      const seen: Record<string, unknown>[] = [];
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of ["/roadmap", "/changelog"]) {
          const res = await page.goto(base + path, { waitUntil: "load" });
          await waitForPreloader(page);
          await page.waitForSelector("#cap-live article", { timeout: 10_000 });
          seen.push({
            path,
            width,
            status: res?.status(),
            csp: (res?.headers()["content-security-policy"] ?? "").includes("script-src 'self'"),
            ...(await page.evaluate(() => ({
              vw: window.innerWidth,
              sw: document.documentElement.scrollWidth,
              h1: document.querySelector("#cap-live h1")?.textContent,
              cards: document.querySelectorAll("#cap-live [data-update]").length,
              planned: document.querySelectorAll('#cap-live [data-update] [data-badge="planned"]').length,
              live: document.querySelectorAll('#cap-live [data-update] [data-badge="live"]').length,
              bonuses: document.querySelectorAll("#cap-live [data-bonus]").length,
              empty: document.querySelector("[data-changelog-empty]")?.textContent ?? null,
              footer: [...document.querySelectorAll(".bl-footer a")].map((a) => a.getAttribute("href")).filter((h) => h === "roadmap.html" || h === "changelog.html"),
            }))),
          });
        }
      }
      return { seen, problems };
    });
    // the build-time data: before launch CHANGELOG.md has no released entry, so every badge reads "planned"
    const rel = JSON.parse(readFileSync(join(import.meta.dir, "../src/generated/releases.json"), "utf8")) as { updates: { live: boolean }[]; changelog: unknown[] };
    const live = rel.updates.filter((u) => u.live).length;
    for (const width of [1440, 390]) {
      expect(out.seen.find((x) => x.path === "/roadmap" && x.width === width)).toEqual({ path: "/roadmap", width, status: 200, csp: true, vw: width, sw: width, h1: "Roadmap", cards: 72, planned: 72 - live, live, bonuses: 3, empty: null, footer: ["roadmap.html", "changelog.html"] });
      expect(out.seen.find((x) => x.path === "/changelog" && x.width === width)).toEqual({ path: "/changelog", width, status: 200, csp: true, vw: width, sw: width, h1: "Changelog", cards: 0, planned: 0, live: 0, bonuses: 0, empty: rel.changelog.length ? null : "No releases yet. The first update ships at launch.", footer: ["roadmap.html", "changelog.html"] });
    }
    expect(out.problems).toEqual([]);
  }, 240_000);
});
