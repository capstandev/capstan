// Invariant 1 (CI): no code path in apps/* accepts, stores, logs or imports a user private key, seed or mnemonic.
// Fails on any identifier matching privateKey|seed|mnemonic (any case) in apps/**, including quoted property names
// such as obj["privateKey"]. Comments and prose strings are not identifiers and are ignored.
// Only packages/sdk (client side) may hold the delegated key, so packages/ is out of scope here.
// Usage: bun ops/ci/check-key-identifiers.ts [repoRoot]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CODE_FILE, lex, walk } from "./lex";

export const KEY_IDENTIFIER = /privatekey|seed|mnemonic/i;
const IDENT = /[A-Za-z_$][\w$]*/g;
const WHOLE_IDENT = /^[A-Za-z_$][\w$]*$/;

export interface Hit {
  file: string;
  line: number;
  name: string;
}

export function findKeyIdentifiers(root: string): Hit[] {
  const hits: Hit[] = [];
  for (const file of walk(root, "apps", (rel) => CODE_FILE.test(rel))) {
    const { code, strings } = lex(readFileSync(join(root, file), "utf8"));
    code.split("\n").forEach((text, idx) => {
      for (const m of text.matchAll(IDENT)) {
        if (KEY_IDENTIFIER.test(m[0])) hits.push({ file, line: idx + 1, name: m[0] });
      }
    });
    for (const s of strings) {
      if (WHOLE_IDENT.test(s.value) && KEY_IDENTIFIER.test(s.value)) hits.push({ file, line: s.line, name: `"${s.value}"` });
    }
  }
  return hits;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, "../.."));
  const hits = findKeyIdentifiers(root);
  if (hits.length) {
    for (const h of hits) console.error(`check-key-identifiers: ${h.file}:${h.line} identifier ${h.name}`);
    console.error(`check-key-identifiers: ${hits.length} hit(s). apps/* must never touch a user key, seed or mnemonic.`);
    process.exit(1);
  }
  console.log("check-key-identifiers: clean (apps/*)");
}
