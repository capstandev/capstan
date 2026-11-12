// Tracker line 69: the two npm packages (capstan-sdk, capstan-mcp) are ready for their first publish. This checks the
// package.json metadata npm and the publish workflow rely on, so a later edit cannot quietly break it: unscoped name,
// a real version, public access with provenance (a laptop publish then fails: provenance needs the CI run), a files
// whitelist with no source maps or source folders, MIT licence, README, Node engines, ESM, and repository links that
// match the folder the workflow publishes from. The build and tarball contents are checked by each smoke.mjs.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const PKGS = ["capstan-sdk", "capstan-mcp"] as const;
const dir = (p: string) => join(ROOT, "ops", "release", "npm", p);
const pkgOf = (p: string) => JSON.parse(readFileSync(join(dir(p), "package.json"), "utf8"));

describe("npm package metadata", () => {
  for (const p of PKGS) {
    test(`${p}: publishable metadata`, () => {
      const pkg = pkgOf(p);
      expect(pkg.name).toBe(p);
      expect(pkg.private).toBeUndefined();
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pkg.version).not.toBe("0.0.0");
      expect(pkg.license).toBe("MIT");
      expect(pkg.type).toBe("module");
      expect(pkg.engines.node).toBe(">=20");
      expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
      expect(pkg.repository.directory).toBe(`ops/release/npm/${p}`);
      expect(pkg.bugs.url).toBe("https://github.com/capstandev/capstan/security/advisories/new");
      expect(typeof pkg.description).toBe("string");
      expect(pkg.description.length).toBeGreaterThan(20);
      expect(Array.isArray(pkg.files)).toBe(true);
      for (const f of pkg.files as string[]) {
        expect(f.endsWith(".map")).toBe(false);
        expect(f.includes("*")).toBe(false);
        expect(/^(src|test|scripts)\//.test(f)).toBe(false);
      }
      expect(existsSync(join(dir(p), "README.md"))).toBe(true);
      expect(existsSync(join(ROOT, "LICENSE"))).toBe(true);
    });
  }

  test("capstan-sdk: entry points name the bundle the build writes", () => {
    const pkg = pkgOf("capstan-sdk");
    expect(pkg.main).toBe("dist/capstan-sdk.js");
    expect(pkg.exports).toEqual({ ".": "./dist/capstan-sdk.js" });
    expect(pkg.files).toContain(pkg.main);
    expect(readFileSync(join(dir("capstan-sdk"), "build.ts"), "utf8")).toContain('copyFileSync(join(root, "LICENSE")');
  });

  test("capstan-mcp: bin has a node shebang and versions agree", () => {
    const pkg = pkgOf("capstan-mcp");
    const bin = pkg.bin["capstan-mcp"] as string;
    expect(pkg.files).toEqual([bin]);
    const src = readFileSync(join(dir("capstan-mcp"), bin), "utf8");
    expect(src.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(src).toContain(`const VERSION = "${pkg.version}"`);
    const server = JSON.parse(readFileSync(join(dir("capstan-mcp"), "server.json"), "utf8"));
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(pkg.scripts.prepack).toContain("LICENSE");
  });
});
