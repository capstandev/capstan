// Vercel readiness (tracker 52 and 82): vercel.json installs the workspace root, skips builds only when nothing the
// site reads changed (and survives a shallow clone), keeps the pre-launch noindex header, caches hashed assets forever
// and pages never, and .env.example lists every VITE_ variable the code reads with its production value.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInputs } from "../scripts/build-inputs";
import { headersFor, readVercelConfig } from "../scripts/vercel-headers";
import { buildOnce, WEB } from "./browser";

const cfg = readVercelConfig();
const SCRIPT = join(WEB, "scripts/ignore-build.sh");
const watchList = () => /^WATCH="([^"]+)"/m.exec(readFileSync(SCRIPT, "utf8"))![1]!.split(/\s+/);

describe("ignored-build rule", () => {
  test("vercel.json runs scripts/ignore-build.sh, and its WATCH list is web/ plus every path the build reads", () => {
    expect(cfg.ignoreCommand).toBe("sh scripts/ignore-build.sh");
    expect([...watchList()].sort()).toEqual(["web", ...buildInputs()].sort());
    // the scan finds what the site really imports
    expect(buildInputs()).toEqual(expect.arrayContaining(["packages/sdk", "packages/schema", "packages/receipts", "packages/signers/lighter-wasm", "apps/api/openapi.json", "bun.lock"]));
  });

  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (root: string, rel: string, body: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  /** A repo shaped like this one; returns it and the sha of its first commit. */
  function fixture(): { root: string; base: string } {
    const root = mkdtempSync(join(tmpdir(), "capstan-ignore-"));
    git(root, "init", "-q", "-b", "main");
    for (const f of ["web/index.html", "web/scripts/x.ts", "packages/sdk/src/a.ts", "packages/catalog/src/a.ts", "apps/workers/src/a.ts", "apps/api/openapi.json", "bun.lock", "docs.md"]) write(root, f, "1\n");
    copyFileSync(SCRIPT, join(root, "web/scripts/ignore-build.sh"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    return { root, base: git(root, "rev-parse", "HEAD") };
  }
  const run = (webDir: string, prev: string | undefined) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };
    if (prev !== undefined) env.VERCEL_GIT_PREVIOUS_SHA = prev;
    const r = spawnSync("sh", ["scripts/ignore-build.sh"], { cwd: webDir, env, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  test("skips when only paths the site does not read changed, builds when the site or an imported package changed", () => {
    for (const [file, code] of [["apps/workers/src/a.ts", 0], ["packages/catalog/src/a.ts", 0], ["docs.md", 0], ["web/index.html", 1], ["packages/sdk/src/a.ts", 1], ["apps/api/openapi.json", 1], ["bun.lock", 1]] as const) {
      const { root, base } = fixture();
      write(root, file, "2\n");
      git(root, "commit", "-qam", `change ${file}`);
      expect({ file, code: run(join(root, "web"), base).code }).toEqual({ file, code });
    }
  });

  test("builds (never errors) with no previous sha, a bad sha, or a base the shallow clone does not hold", () => {
    const { root, base } = fixture();
    expect(run(join(root, "web"), undefined).code).toBe(1);
    expect(run(join(root, "web"), "").code).toBe(1);
    expect(run(join(root, "web"), "not-a-sha").code).toBe(1);
    for (let i = 0; i < 3; i++) {
      write(root, "apps/workers/src/a.ts", `${i + 3}\n`);
      git(root, "commit", "-qam", `workers ${i}`);
    }
    const shallow = mkdtempSync(join(tmpdir(), "capstan-shallow-"));
    git(shallow, "clone", "-q", "--depth", "1", `file://${root}`, "c");
    const r = run(join(shallow, "c/web"), base);
    expect(r.code).toBe(1);
    expect(r.out).toContain("not in this clone");
    // the same base in the full repo, where only workers changed: skipped
    expect(run(join(root, "web"), base).code).toBe(0);
  });
});

describe("install, robots and caching", () => {
  test("installCommand installs the workspace root before web/ (the packages' dependencies live there)", () => {
    expect(cfg.installCommand).toBe("cd .. && bun install --frozen-lockfile && cd web && bun install --frozen-lockfile");
  });

  test("the pre-launch noindex header is on every path, and the README says it is removed on launch day", () => {
    for (const p of ["/", "/docs", "/404", "/robots.txt", "/_app/main-abc123.js", "/assets/style-abc123.css"]) expect({ p, robots: headersFor(p, cfg)["x-robots-tag"] }).toEqual({ p, robots: "noindex, nofollow" });
    expect(readFileSync(join(WEB, "README.md"), "utf8")).toMatch(/X-Robots-Tag: noindex, nofollow[\s\S]{0,120}remove that rule on launch day/);
  });

  test("in the production build, hashed files are immutable and every page and kept-name file is not", async () => {
    const dist = await buildOnce({ VITE_API_BASE: "https://api.get-capstan.com/v1", VITE_NETWORK: "mainnet" });
    const files = (d: string, base = ""): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n), `${base}${n}/`) : [`${base}${n}`]));
    const all = files(dist);
    expect(all.length).toBeGreaterThan(20);
    for (const f of all) {
      const path = `/${f}`.replace(/\.html$/, "").replace(/^\/index$/, "/");
      const cache = headersFor(path, cfg)["cache-control"];
      const hashed = /^(assets|_app)\//.test(f);
      expect({ f, cache }).toEqual({ f, cache: hashed ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate" });
      if (hashed) expect(f).toMatch(/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/);
    }
  }, 180_000);
});

describe(".env.example", () => {
  test("lists every VITE_ variable the site reads, each with its production value or a 'set in Vercel' note", () => {
    const src = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? src(join(d, n)) : /\.(tsx?|html)$/.test(n) ? [readFileSync(join(d, n), "utf8")] : []));
    const read = new Set(src(join(WEB, "src")).flatMap((s) => [...s.matchAll(/\bVITE_[A-Z0-9_]+/g)].map((m) => m[0])));
    const example = readFileSync(join(WEB, ".env.example"), "utf8");
    const listed = new Map([...example.matchAll(/^(VITE_[A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1]!, m[2]!]));
    expect([...read].filter((k) => !listed.has(k)).sort()).toEqual([]);
    expect(listed.get("VITE_API_BASE")).toBe("https://api.get-capstan.com/v1");
    expect(listed.get("VITE_NETWORK")).toBe("mainnet");
    expect(listed.get("VITE_PROFILE")).toBe("live");
    // an empty value must say why in its block: set in Vercel, or left unset in production
    for (const block of example.split(/\n\s*\n/)) {
      for (const m of block.matchAll(/^(VITE_[A-Z0-9_]+)=$/gm)) expect({ k: m[1], why: /set in Vercel|leave unset/.test(block) }).toEqual({ k: m[1], why: true });
    }
  });
});
