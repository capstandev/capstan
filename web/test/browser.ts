// Headless Chromium for the phone-width, contrast and browser-pass tests. Uses an already installed Chromium (the
// Playwright headless shell, or CAPSTAN_CHROMIUM); nothing is downloaded. Tests skip with a note when none is found.
// One browser at a time on this Mac: launch() is serialised through a promise chain.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { Browser } from "playwright-core";

export const WEB = resolve(import.meta.dir, "..");

/** The public pages the browser checks visit. */
export const SITE_PATHS = ["/", "/docs", "/pricing", "/status", "/verify", "/legal"];

export function chromiumPath(): string | null {
  const env = process.env.CAPSTAN_CHROMIUM;
  if (env && existsSync(env)) return env;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(cache)) {
    const shells = readdirSync(cache)
      .filter((d) => d.startsWith("chromium_headless_shell-"))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of shells) {
      for (const arch of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64", "chrome-headless-shell-linux64"]) {
        const p = join(cache, d, arch, "chrome-headless-shell");
        if (existsSync(p)) return p;
      }
    }
  }
  const linux = join(homedir(), ".cache/ms-playwright");
  if (existsSync(linux)) {
    for (const d of readdirSync(linux).filter((x) => x.startsWith("chromium_headless_shell-"))) {
      const p = join(linux, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export const SKIP_NO_CHROMIUM = "no headless Chromium on this host (set CAPSTAN_CHROMIUM); browser checks skipped";

const builds = new Map<string, Promise<string>>();

/** Build the site once per profile into a temp folder (the env is the build's VITE_* variables). */
export function buildOnce(env: Record<string, string> = {}): Promise<string> {
  const key = JSON.stringify(env);
  let p = builds.get(key);
  if (!p) {
    p = (async () => {
      const { build } = await import("vite");
      const outDir = mkdtempSync(join(tmpdir(), "capstan-web-build-"));
      const saved: Record<string, string | undefined> = {};
      // a production build, as `bun run build` makes (bun test sets NODE_ENV=test, which keeps JSX source paths)
      for (const [k, v] of Object.entries({ NODE_ENV: "production", ...env })) {
        saved[k] = process.env[k];
        process.env[k] = v;
      }
      try {
        await build({ root: WEB, mode: "production", configFile: join(WEB, "vite.config.ts"), logLevel: "error", build: { outDir, emptyOutDir: true } });
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      return outDir;
    })();
    builds.set(key, p);
  }
  return p;
}

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm" };

/** Serve a build folder with the single-page fallback, on a free port. */
export function serveDist(dir: string): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      let p = join(dir, decodeURIComponent(u.pathname));
      if (!p.startsWith(dir) || !existsSync(p) || statSync(p).isDirectory()) p = join(dir, "index.html");
      return new Response(readFileSync(p), { headers: { "content-type": TYPES[extname(p)] ?? "application/octet-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

let chain: Promise<unknown> = Promise.resolve();

/** Run fn with a fresh headless Chromium; browsers never overlap inside this process. */
export function withBrowser<T>(fn: (b: Browser) => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const exe = chromiumPath();
    if (!exe) throw new Error(SKIP_NO_CHROMIUM);
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: exe, headless: true });
    try {
      return await fn(browser);
    } finally {
      await browser.close();
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

/** Runs in the page: the widest overflow and every text node's font size. */
export const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const small = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent || !n.textContent.trim()) continue;
    const el = n.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1) continue; // visually hidden captions
    const px = parseFloat(cs.fontSize);
    if (px < 14) small.push(el.tagName + " " + px + "px: " + n.textContent.trim().slice(0, 40));
  }
  return { vw, sw, small };
})()`;
