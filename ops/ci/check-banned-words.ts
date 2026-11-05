// Invariant 5 (CI): the banned-word list (ops/ci/banned-words.txt) never appears in public docs, copy, API strings or
// MCP tool descriptions. Scans:
//   - every Markdown file (README, SECURITY, CHANGELOG, package docs, ops docs), except vendored folders
//   - everything under web/ (site copy)
//   - every string literal in apps/** and packages/** source, except venue wire formats (packages/adapters,
//     packages/signers) and test files (tests plant banned words on purpose)
// Usage: bun ops/ci/check-banned-words.ts [repoRoot]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CODE_FILE, lex, walk } from "./lex";

export interface Hit {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

export function loadBanned(path = join(import.meta.dir, "banned-words.txt")): RegExp[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new RegExp(l, "i"));
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SELF = "ops/ci/banned-words.txt";

export function findBannedWords(root: string, banned: RegExp[] = loadBanned()): Hit[] {
  const hits: Hit[] = [];
  const check = (file: string, line: number, text: string) => {
    for (const re of banned) if (re.test(text)) hits.push({ file, line, pattern: re.source, text: text.trim().slice(0, 160) });
  };
  const docs = walk(root, ".", (rel) => /\.md$/i.test(rel) && !rel.startsWith("contracts/lib/"));
  const web = walk(root, "web", (rel) => !/\.(png|jpe?g|webp|gif|ico|woff2?|lockb?)$/i.test(rel));
  for (const file of new Set([...docs, ...web])) {
    if (file === SELF) continue;
    readFileSync(join(root, file), "utf8")
      .split("\n")
      .forEach((l, i) => check(file, i + 1, l));
  }
  const code = [...walk(root, "apps", (r) => CODE_FILE.test(r)), ...walk(root, "packages", (r) => CODE_FILE.test(r))].filter(
    (f) => !TEST_FILE.test(f) && !f.startsWith("packages/adapters/") && !f.startsWith("packages/signers/"),
  );
  for (const file of code) {
    for (const s of lex(readFileSync(join(root, file), "utf8")).strings) check(file, s.line, s.value);
  }
  return hits;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, "../.."));
  const hits = findBannedWords(root);
  if (hits.length) {
    for (const h of hits) console.error(`check-banned-words: ${h.file}:${h.line} /${h.pattern}/ ${h.text}`);
    console.error(`check-banned-words: ${hits.length} hit(s). Reword (see ops/ci/banned-words.txt).`);
    process.exit(1);
  }
  console.log("check-banned-words: clean");
}
