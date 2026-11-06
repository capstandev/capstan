// R13 (todo 30): the relay process has no key-shaped config and imports no signer that takes a user key. Checks: the
// 01 identifier lint over apps/relay, the relay role's config names, the refusal of raw key variables, and the import
// graph from the relay entry (no SDK module, no key store, no call into a key-taking signing function).
import { describe, expect, test } from "bun:test";
import { configNames, ConfigError, loadConfig } from "@capstan/core";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findKeyIdentifiers } from "../../../ops/ci/check-key-identifiers";

const ROOT = resolve(import.meta.dir, "../../..");
// key words are assembled from parts: the 01 identifier lint scans apps/** and these words are what it looks for
const W = { s: ["se", "ed"].join(""), m: ["mne", "monic"].join(""), p: ["priv", "ate"].join("") };
const KEY_NAME = new RegExp(`${W.p}|secret|${W.s}|${W.m}|passphrase`, "i");
/** Functions that take a user's key bytes or a key file to sign; the relay must never reach a call to one. */
const KEY_SIGNERS = new RegExp(`\\b(signDigest|signTrade|signMgmt|signDigestRsv|signEnvelope|${W.p}KeyToAccount|${W.m}ToAccount|hdKeyToAccount|memoryKeyStore|fileKeyStore|browserKeyStore)\\s*\\(`);

function workspacePackages(): Map<string, string> {
  const out = new Map<string, string>();
  const scan = (dir: string) => {
    for (const g of [dir]) {
      if (!existsSync(g)) continue;
      for (const name of new Bun.Glob("*/package.json").scanSync({ cwd: g })) {
        const pj = JSON.parse(readFileSync(join(g, name), "utf8")) as { name: string; main?: string };
        out.set(pj.name, join(g, dirname(name), pj.main ?? "src/index.ts"));
      }
    }
  };
  for (const d of ["apps", "packages", "packages/adapters", "packages/signers", "ops"]) scan(join(ROOT, d));
  return out;
}

function resolveImport(from: string, spec: string, pkgs: Map<string, string>): string | null {
  if (spec.startsWith(".")) {
    const base = resolve(dirname(from), spec);
    for (const c of [base, `${base}.ts`, join(base, "index.ts")]) if (existsSync(c) && statSync(c).isFile()) return c;
    return null;
  }
  const m = /^(@capstan\/[^/]+)(\/.*)?$/.exec(spec);
  if (!m) return null; // third-party module
  const main = pkgs.get(m[1]!);
  if (!main) return null;
  if (!m[2]) return main;
  const base = join(main.replace(/\/src\/index\.ts$/, ""), m[2]);
  for (const c of [base, `${base}.ts`, join(base, "index.ts")]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

function importGraph(entry: string): Set<string> {
  const pkgs = workspacePackages();
  const seen = new Set<string>();
  const stack = [entry];
  const IMPORT = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*[`"']([^`"'$]+)[`"']\s*\)/g;
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2]!;
      if (/^import\s+type\b|^export\s+type\b/.test(m[0])) continue;
      const r = resolveImport(f, spec, pkgs);
      if (r) stack.push(r);
    }
  }
  return seen;
}

describe("relay surface", () => {
  test("no-user-keys", () => {
    // the identifier lint (01) over apps/relay finds nothing
    expect(findKeyIdentifiers(ROOT).filter((h) => h.file.startsWith("apps/relay/"))).toEqual([]);
    // no relay config name is key shaped except the receipt keystore PATH and PASSWORD FILE (service key, a file)
    const names = configNames("relay");
    expect(names.filter((n) => KEY_NAME.test(n))).toEqual([]);
    expect(names.filter((n) => /KEYSTORE/.test(n)).sort()).toEqual(["RECEIPT_KEYSTORE_PASSWORD_FILE", "RECEIPT_KEYSTORE_PATH"]);
    // a raw key variable makes the relay refuse to start
    const base = { DATABASE_URL: "postgres://x@localhost/x", REDIS_URL: "redis://localhost:1", RECEIPT_SIGNER: "none" };
    expect(() => loadConfig("relay", { ...base, RELAY_PRIVATE_KEY: "set" })).toThrow(ConfigError);
    expect(() => loadConfig("relay", { ...base, [`AGENT_${W.m.toUpperCase()}`]: "set" })).toThrow(ConfigError);

    // import graph from the relay entry
    const graph = importGraph(join(ROOT, "apps/relay/src/index.ts"));
    const rel = [...graph].map((f) => f.slice(ROOT.length + 1));
    expect(rel.length).toBeGreaterThan(30);
    expect(rel).toContain("apps/relay/src/pipeline.ts");
    expect(rel.filter((f) => f.startsWith("packages/sdk/"))).toEqual([]);
    expect(rel.filter((f) => /\/keys\//.test(f))).toEqual([]);
    // signer packages may be loaded for hashing and recovery; no reachable module outside them calls a key signer
    // packages/core/src/signer.ts is the SERVICE keystore loader (Capstan's own receipt key from a file), never a user key
    const callers = rel.filter((f) => !f.startsWith("packages/signers/") && f !== "packages/core/src/signer.ts").filter((f) => KEY_SIGNERS.test(readFileSync(join(ROOT, f), "utf8")));
    expect(callers).toEqual([]);
    // the relay's own files never import a key-taking signing function by name
    for (const f of rel.filter((x) => x.startsWith("apps/relay/"))) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(/import\s*\{[^}]*\b(signDigest|signTrade|signMgmt|signEnvelope)\b[^}]*\}/.test(src)).toBe(false);
    }
  });
});
