// R10: the build output carries no source maps with server paths, no .env values, and nothing the public guard
// refuses. Builds the site into a temp folder and runs scripts/check-dist.ts on it; then plants each problem.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledConstants, checkDist, denylist } from "../scripts/check-dist";
import { buildOnce } from "./browser";

describe("build", () => {
  test("clean-dist", async () => {
    const dist = await buildOnce();
    expect(existsSync(join(dist, "index.html"))).toBe(true);
    expect(readdirSync(join(dist, "assets")).some((f) => f.endsWith(".map"))).toBe(false);
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
  }, 120_000);
});
