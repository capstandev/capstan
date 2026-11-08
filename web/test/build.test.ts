// R10: the build output carries no source maps with server paths, no .env values, and nothing the public guard
// refuses. Builds the site into a temp folder and runs scripts/check-dist.ts on it; then plants each problem.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledConstants, checkDist, denylist } from "../scripts/check-dist";
import { buildOnce } from "./browser";
import { unhashedRefs } from "../scripts/hash-public";
import { PAGES } from "../vite.config";

describe("build", () => {
  test("clean-dist", async () => {
    const dist = await buildOnce();
    for (const p of PAGES) expect({ p, built: existsSync(join(dist, p)) }).toEqual({ p, built: true });
    expect(readdirSync(join(dist, "_app")).some((f) => f.endsWith(".map"))).toBe(false);
    // every cached file has a hashed name, and nothing still points at an unhashed public file
    expect(unhashedRefs(dist)).toEqual([]);
    for (const f of readdirSync(join(dist, "assets"))) if (!statSync(join(dist, "assets", f)).isDirectory()) expect({ f, hashed: /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(f) }).toEqual({ f, hashed: true });
    // the owner's videos ship, each under the size cap; no page loads a font or script from another host
    const videos = readdirSync(join(dist, "assets")).filter((f) => f.endsWith(".mp4"));
    expect(videos.length).toBeGreaterThanOrEqual(8);
    for (const p of PAGES) expect(readFileSync(join(dist, p), "utf8")).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    expect(checkDist(dist, { allowHex: bundledConstants(), env: ["capstan-env-sample-value"] })).toEqual([]);

    // each problem is caught
    const bad = mkdtempSync(join(tmpdir(), "capstan-web-bad-"));
    mkdirSync(join(bad, "assets"));
    writeFileSync(join(bad, "assets/a.js.map"), "{}");
    writeFileSync(join(bad, "assets/b.js"), "console.log(1)\n//# sourceMappingURL=b.js.map\n");
    writeFileSync(join(bad, "assets/c.js"), 'const p="/Users/someone/repo/src/x.ts";');
    writeFileSync(join(bad, "assets/d.js"), 'const k="capstan-env-sample-value";');
    writeFileSync(join(bad, "assets/e.js"), `const z="0x${"ab".repeat(32)}";`); // not-a-key (planted)
    const deny = denylist();
    expect(deny.length).toBeGreaterThan(5);
    writeFileSync(join(bad, "assets/f.js"), `const w="${["internal", "notes"].join(" ")}";`);
    writeFileSync(join(bad, "index.html"), '<script src="https://www.googletagmanager.com/gtag/js"></script>');
    const found = checkDist(bad, { allowHex: bundledConstants(), env: ["capstan-env-sample-value"], deny });
    const what = found.map((p) => `${p.file}: ${p.what.split(" ")[0]}`);
    for (const w of ["assets/a.js.map: source", "assets/b.js: sourceMappingURL", "assets/c.js: server", "assets/d.js: a", "assets/e.js: 64-hex", "assets/f.js: public", "index.html: third-party"]) expect(what).toContain(w);
  }, 300_000);
});
