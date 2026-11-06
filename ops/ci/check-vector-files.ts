// Recorded venue fixtures and signing vectors are public data, but they must never carry key material. Fails when any
// file under packages/**/fixtures/ or any **/test/vectors/ folder has a key or identifier named like
// privateKey|testKey|secret|mnemonic|seed. The one public SDK test key line may carry `// test-key gitleaks:allow`.
// Usage: bun ops/ci/check-vector-files.ts [repoRoot]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { walk } from "./lex";

export const KEYISH = /(private_?key|test_?key|secret|mnemonic|seed)/i;
const IDENT = /["']?([A-Za-z_$][\w$-]*)["']?\s*[:=]/g;
const ALLOW_MARK = /\/\/ test-key gitleaks:allow/;

export function isVectorFile(rel: string): boolean {
  return (/^packages\/(.+\/)?fixtures\//.test(rel) || /(^|\/)test\/vectors\//.test(rel)) && !/\.(png|jpe?g|gif|wasm|lz4|gz)$/i.test(rel);
}

export function findKeyishNames(root: string): { file: string; line: number; name: string }[] {
  const out: { file: string; line: number; name: string }[] = [];
  for (const f of walk(root, ".", isVectorFile)) {
    readFileSync(join(root, f), "utf8")
      .split("\n")
      .forEach((text, i) => {
        if (ALLOW_MARK.test(text)) return;
        for (const m of text.matchAll(IDENT)) if (KEYISH.test(m[1]!)) out.push({ file: f, line: i + 1, name: m[1]! });
      });
  }
  return out;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, "../.."));
  const hits = findKeyishNames(root);
  if (hits.length) {
    for (const h of hits) console.error(`check-vector-files: ${h.file}:${h.line} key-like name ${h.name}`);
    process.exit(1);
  }
  console.log("check-vector-files: no key-like names in fixtures or vectors");
}
