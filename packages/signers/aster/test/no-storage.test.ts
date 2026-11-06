// R14 (todo 14): the signer package never stores or loads a key.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("aster signer storage", () => {
  test("stateless", () => {
    const dir = join(import.meta.dir, "../src");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const banned = [/\bfs\b/, /node:fs/, /\bprocess\.env\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /Bun\.(file|write)/, /\bprivateKeyToAccount\b/, /\bmnemonicToAccount\b/, /\bprivateKey\b/i, /\breadFile/, /\bwriteFile/, /require\(/];
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const re of banned) expect({ file: f, hit: re.test(text) ? re.source : null }).toEqual({ file: f, hit: null });
    }
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@capstan/schema", "@noble/curves", "viem"]);
  });
});
