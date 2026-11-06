// R7: headless browser timing. A static page served by Bun.serve on port 0 loads the browser bundle of this
// package, which verifies the artifacts and signs in a module Worker; the page posts p99 back. Uses an already
// installed Playwright Chromium headless shell (or LIGHTER_WASM_CHROME); never installs a browser. Skips otherwise.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PKG } from "./helpers";

function findChrome(): string | null {
  const env = process.env.LIGHTER_WASM_CHROME;
  if (env && existsSync(env)) return env;
  for (const root of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const d of dirs) {
      for (const sub of readdirSync(join(root, d))) {
        const bin = join(root, d, sub, "chrome-headless-shell");
        if (existsSync(bin)) return bin;
      }
    }
  }
  return null;
}

const chrome = findChrome();
if (!chrome) console.warn("browser.test: no Playwright Chromium headless shell installed; skipping (CI never installs one)");

const PAGE = `<!doctype html><meta charset="utf-8"><title>lighter-wasm timing</title><script type="module">
import { createLighterSigner } from "/bundle.js";
const send = (o) => fetch("/result", { method: "POST", body: JSON.stringify(o) });
try {
  const base = location.origin;
  const t0 = performance.now();
  const s = await createLighterSigner(304, { wasmUrl: base + "/artifacts/lighter-signer.wasm", wasmExecUrl: base + "/artifacts/wasm_exec.js", workerUrl: base + "/worker.mjs" });
  const coldMs = performance.now() - t0;
  s.generateApiKey();
  const ds = [];
  for (let i = 0; i < 1000; i++) {
    const a = performance.now();
    await s.signCreateOrder({ marketIndex: i % 200, clientOrderIndex: i + 1, baseAmount: 1000 + i, price: 50000 + i, isAsk: false, orderType: 0, timeInForce: 1, reduceOnly: false, triggerPrice: 0, orderExpiry: 1893542400000, integratorAccountIndex: 0, integratorTakerFee: 0, integratorMakerFee: 0, selfTradeBehaviorMode: 0, selfTradeEqualityMode: 0, nonce: i, apiKeyIndex: 4, accountIndex: 12345, expiredAt: 1893456000000 });
    ds.push(performance.now() - a);
  }
  s.close();
  ds.sort((x, y) => x - y);
  await send({ ok: true, ua: navigator.userAgent, coldMs, p50Ms: ds[500], p99Ms: ds[990], maxMs: ds[999] });
} catch (e) {
  await send({ ok: false, error: String(e && e.stack || e) });
}
</script>`;

describe("browser", () => {
  test.skipIf(!chrome)(
    "under-50ms",
    async () => {
      const built = await Bun.build({ entrypoints: [join(PKG, "src/index.ts")], target: "browser", format: "esm", external: ["node:*"] });
      if (!built.success) throw new Error(built.logs.map(String).join("\n"));
      const bundle = await built.outputs[0]!.text();
      let resolveResult: (v: Record<string, unknown>) => void = () => undefined;
      const result = new Promise<Record<string, unknown>>((r) => (resolveResult = r));
      const files: Record<string, { path: string; type: string }> = {
        "/worker.mjs": { path: join(PKG, "src/worker.mjs"), type: "text/javascript" },
        "/artifacts/lighter-signer.wasm": { path: join(PKG, "artifacts/lighter-signer.wasm"), type: "application/wasm" },
        "/artifacts/wasm_exec.js": { path: join(PKG, "artifacts/wasm_exec.js"), type: "text/javascript" },
      };
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          const p = new URL(req.url).pathname;
          if (p === "/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
          if (p === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
          if (p === "/result" && req.method === "POST") {
            resolveResult(JSON.parse(await req.text()));
            return new Response("ok");
          }
          const f = files[p];
          if (f) return new Response(Bun.file(f.path), { headers: { "content-type": f.type } });
          return new Response("Not Found", { status: 404 });
        },
      });
      const profile = mkdtempSync(join(tmpdir(), "lighter-chrome-"));
      const proc = Bun.spawn([chrome!, "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, `http://127.0.0.1:${server.port}/`], { stdout: "ignore", stderr: "ignore" });
      try {
        const r: Record<string, unknown> = await Promise.race([result, Bun.sleep(150_000).then(() => ({ ok: false, error: "timeout" }))]);
        writeFileSync(join(PKG, "test/browser-timing.json"), JSON.stringify({ at: new Date().toISOString(), ...r }, null, 2) + "\n");
        expect(r.error ?? null).toBeNull();
        expect(r.ok).toBe(true);
        expect(r.p99Ms as number).toBeLessThan(50);
      } finally {
        proc.kill(); // the browser this test started, by its own handle
        await proc.exited;
        server.stop(true);
        rmSync(profile, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
