// Tiny TS/JS lexer for the CI invariant checks. Splits a source file into code (comments and string contents blanked
// out, newlines kept so line numbers stay right) and the string literals it holds. Template literals keep their
// ${...} parts as code. Regex literals are left in the code (stricter: a /seed/ regex is flagged).
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface StringLit {
  value: string;
  line: number;
}

export function lex(src: string): { code: string; strings: StringLit[] } {
  const out: string[] = [];
  const strings: StringLit[] = [];
  let i = 0;
  let line = 1;
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  // brace depth stack for template ${...} nesting: each entry is the depth at which the template resumes
  const tplStack: number[] = [];
  let depth = 0;

  const readTemplate = () => {
    // at the char after ` or after the } that closed a ${...}
    let buf = "";
    const startLine = line;
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === "\\") {
        buf += src.slice(i, i + 2);
        out.push(blank(ch), blank(src[i + 1] ?? ""));
        if (src[i + 1] === "\n") line++;
        i += 2;
        continue;
      }
      if (ch === "`") {
        out.push(" ");
        i++;
        strings.push({ value: buf, line: startLine });
        return;
      }
      if (ch === "$" && src[i + 1] === "{") {
        strings.push({ value: buf, line: startLine });
        out.push("${");
        i += 2;
        tplStack.push(depth);
        depth++;
        return;
      }
      if (ch === "\n") line++;
      buf += ch;
      out.push(blank(ch));
      i++;
    }
    strings.push({ value: buf, line: startLine });
  };

  while (i < src.length) {
    const ch = src[i]!;
    const nx = src[i + 1];
    if (ch === "/" && nx === "/") {
      while (i < src.length && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (ch === "/" && nx === "*") {
      out.push("  ");
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        out.push(blank(src[i]!));
        i++;
      }
      out.push("  ");
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      const startLine = line;
      let buf = "";
      out.push(" ");
      i++;
      while (i < src.length && src[i] !== q && src[i] !== "\n") {
        if (src[i] === "\\") {
          buf += src.slice(i, i + 2);
          out.push("  ");
          i += 2;
          continue;
        }
        buf += src[i];
        out.push(" ");
        i++;
      }
      out.push(" ");
      i++;
      strings.push({ value: buf, line: startLine });
      continue;
    }
    if (ch === "`") {
      out.push(" ");
      i++;
      readTemplate();
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (tplStack.length && tplStack[tplStack.length - 1] === depth) {
        tplStack.pop();
        out.push("}");
        i++;
        readTemplate();
        continue;
      }
    }
    if (ch === "\n") line++;
    out.push(ch);
    i++;
  }
  return { code: out.join(""), strings };
}

const SKIP_NAMES = new Set(["node_modules", ".git", "dist", "coverage"]);
const SKIP_PATHS = new Set(["contracts/lib", "contracts/out", "contracts/cache", "contracts/broadcast"]);

/** Recursively list files under `dir` (repo-relative to `root`), skipping vendored and generated folders. */
export function walk(root: string, dir: string, keep: (rel: string) => boolean): string[] {
  const abs = join(root, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of entries) {
    const p = join(abs, name);
    const rel = relative(root, p);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (SKIP_NAMES.has(name) || SKIP_PATHS.has(rel)) continue;
      files.push(...walk(root, rel, keep));
    } else if (keep(rel)) files.push(rel);
  }
  return files.sort();
}

export const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
