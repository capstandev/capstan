// Tests for the CI invariant checks: each must fail on a planted violation and pass on clean input.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findBannedWords } from "./check-banned-words";
import { findKeyIdentifiers } from "./check-key-identifiers";
import { lex } from "./lex";

const roots: string[] = [];
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "capstan-ci-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("lex", () => {
  test("blanks comments and strings, keeps template expressions as code", () => {
    const { code, strings } = lex('const a = "x"; // note\nconst b = `t ${c} u`; /* d */');
    expect(code).toContain("const a");
    expect(code).not.toContain("note");
    expect(code).toContain("${c}");
    expect(code).not.toContain(" d ");
    expect(strings.map((s) => s.value)).toEqual(["x", "t ", " u"]);
  });
});

describe("check-key-identifiers", () => {
  test("fails on a planted privateKey in apps/", () => {
    const root = repo({ "apps/api/src/bad.ts": "export function sign(privateKey: string) { return privateKey; }\n" });
    const hits = findKeyIdentifiers(root);
    expect(hits.length).toBe(2);
    expect(hits[0]).toEqual({ file: "apps/api/src/bad.ts", line: 1, name: "privateKey" });
  });
  test("fails on seed and mnemonic identifiers, any case, and quoted property names", () => {
    const root = repo({
      "apps/relay/src/a.ts": 'const userSeed = 1;\nconst MNEMONIC = 2;\nconst o: Record<string, number> = {};\no["privateKey"] = 3;\n',
    });
    expect(findKeyIdentifiers(root).map((h) => h.name)).toEqual(["userSeed", "MNEMONIC", '"privateKey"']);
  });
  test("ignores comments and prose strings, and packages/sdk", () => {
    const root = repo({
      "apps/mcp/src/ok.ts": '// never accepts a privateKey\nexport const d = "no tool takes a seed phrase";\n',
      "packages/sdk/src/key.ts": "export const privateKey = 1;\n",
    });
    expect(findKeyIdentifiers(root)).toEqual([]);
  });
  test("the real repo is clean", () => {
    expect(findKeyIdentifiers(join(import.meta.dir, "../.."))).toEqual([]);
  });
});

describe("check-banned-words", () => {
  test("fails on a planted word in a doc and in an API string", () => {
    const root = repo({
      "README.md": "# X\nA risk-free carry.\n",
      "apps/api/src/copy.ts": 'export const m = "Guaranteed returns";\n',
    });
    const hits = findBannedWords(root);
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(["README.md:2", "apps/api/src/copy.ts:1"]);
  });
  test("catches endorsement and shared-margin claims", () => {
    const root = repo({ "web/index.html": "<p>Official Hyperliquid API with unified margin</p>\n" });
    expect(findBannedWords(root).length).toBe(2);
  });
  test("skips venue wire formats, tests and code comments", () => {
    const root = repo({
      "packages/adapters/hyperliquid/src/a.ts": 'export const mode = "cross margin";\n',
      "apps/api/src/a.test.ts": 'const x = "risk-free";\n',
      "apps/api/src/b.ts": "// risk-free is banned\nexport const y = 1;\n",
    });
    expect(findBannedWords(root)).toEqual([]);
  });
  test("the real repo is clean", () => {
    expect(findBannedWords(join(import.meta.dir, "../.."))).toEqual([]);
  });
});
