// Audit 2026-11-08 (frontend, no-csp-frame-ancestors): the site answered without Content-Security-Policy or
// frame-ancestors, so an injected script could run in the origin that holds the delegated keys, and any site could
// frame the signing screens. vercel.json now sends a CSP on every page: scripts from this origin only (no inline, no
// eval), no plugins, no framing, and only the wallet hosts may be framed. A built page with an inline script would
// break under it, so the test also checks the built pages carry none.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildOnce } from "./browser";

type Header = { key: string; value: string };
const cfg = JSON.parse(readFileSync(join(import.meta.dir, "../vercel.json"), "utf8")) as { headers: { source: string; headers: Header[] }[] };
const pageRule = cfg.headers.find((h) => h.source.startsWith("/((?!assets/"));
const header = (k: string) => pageRule?.headers.find((h) => h.key.toLowerCase() === k.toLowerCase())?.value ?? "";
const directives = () => Object.fromEntries(header("Content-Security-Policy").split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...v] = d.split(/\s+/); return [name!, v]; }));

describe("security headers on every page", () => {
  test("a CSP with frame-ancestors 'none', self-only scripts, no plugins, and X-Frame-Options DENY", () => {
    const d = directives();
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(d["connect-src"]).toContain("'self'");
    // no plain-http connections and no wildcard script host
    expect(d["connect-src"]).not.toContain("http:");
    expect(d["connect-src"]).not.toContain("*");
    // only the wallet sign-in hosts may be framed by the site
    for (const f of d["frame-src"] ?? []) expect(f).toMatch(/^https:\/\/(verify|secure)\.walletconnect\.(org|com)$/);
    expect(header("X-Frame-Options")).toBe("DENY");
  });

  test("the built pages have no inline scripts or inline event handlers (script-src 'self' would block them)", async () => {
    const dist = await buildOnce();
    for (const f of readdirSync(dist).filter((n) => n.endsWith(".html"))) {
      const html = readFileSync(join(dist, f), "utf8");
      const inline = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\ssrc=/.test(m[1]!) && !/application\/ld\+json/.test(m[1]!) && m[2]!.trim() !== "");
      expect({ f, inline: inline.length, handlers: (html.match(/\son[a-z]+="/g) ?? []).length }).toEqual({ f, inline: 0, handlers: 0 });
    }
  }, 120_000);

  test("the built scripts write no inline event handler attributes into the page (blocked by script-src-attr)", async () => {
    // 2026-11-08 (tracker 82): the owner's app.js and bloop-views.js drew images with onerror="..." fallbacks, which the
    // CSP refuses on every page; they now carry data-fallback-src and one delegated error listener swaps the image.
    const dist = await buildOnce();
    const found: string[] = [];
    for (const d of ["assets", "_app"]) {
      for (const f of readdirSync(join(dist, d)).filter((n) => /\.m?js$/.test(n))) {
        for (const m of readFileSync(join(dist, d, f), "utf8").matchAll(/<[a-z][^<>]*\son(?:error|load|click|mouseover|focus|input|change|submit)=\\?["'`]/g)) found.push(`${d}/${f}: ${m[0].slice(-60)}`);
      }
    }
    expect(found).toEqual([]);
  }, 120_000);
});
