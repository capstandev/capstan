// R10: the build output is clean. No source maps, no server or home paths, no value from any .env file, nothing the
// public guard refuses (its denylist and the 64-hex key rule), and no third-party script or font host.
// Usage: bun scripts/check-dist.ts [distDir]   (runs after `vite build`)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB = resolve(import.meta.dir, "..");
const REPO = resolve(WEB, "..");

export interface DistProblem {
  file: string;
  what: string;
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

/** Values of every .env file in the web folder and the repo root (only values of 6 characters or more). */
export function envValues(dirs: string[] = [WEB, REPO]): string[] {
  const vals: string[] = [];
  for (const d of dirs) {
    for (const n of readdirSync(d)) {
      if (!/^\.env/.test(n) || n === ".env.example") continue;
      const p = join(d, n);
      if (!statSync(p).isFile()) continue;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
        const v = m?.[1]?.trim().replace(/^["']|["']$/g, "");
        if (v && v.length >= 6) vals.push(v);
      }
    }
  }
  return vals;
}

export function denylist(): RegExp[] {
  const p = join(REPO, ".githooks/public-guard.denylist");
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new RegExp(l, "i"));
}

const SERVER_PATH = /(\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|\/private\/tmp\/|\/var\/folders\/|[A-Z]:\\\\Users\\\\)/;
const THIRD_PARTY = /<script[^>]+src=["']https?:\/\/|fonts\.googleapis\.com|fonts\.gstatic\.com|googletagmanager|google-analytics|plausible\.io|segment\.(io|com)|hotjar|mixpanel/i;
const HEX64 = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;

export function checkDist(dist = join(WEB, "dist"), o: { env?: string[]; deny?: RegExp[]; allowHex?: Set<string> } = {}): DistProblem[] {
  if (!existsSync(dist)) return [{ file: dist, what: "no build output (run vite build first)" }];
  const env = o.env ?? envValues();
  const deny = o.deny ?? denylist();
  const out: DistProblem[] = [];
  for (const f of files(dist)) {
    const rel = relative(dist, f);
    if (rel.endsWith(".map")) out.push({ file: rel, what: "source map file" });
    if (/\.(png|jpe?g|webp|gif|ico|woff2?|wasm)$/i.test(rel)) continue;
    const text = readFileSync(f, "utf8");
    if (/[#@]\s*sourceMappingURL=/.test(text)) out.push({ file: rel, what: "sourceMappingURL comment" });
    const sp = SERVER_PATH.exec(text);
    if (sp) out.push({ file: rel, what: `server path ${sp[0]}` });
    if (text.includes(REPO)) out.push({ file: rel, what: "the repo's absolute path" });
    for (const v of env) if (text.includes(v)) out.push({ file: rel, what: "a value from a .env file" });
    for (const re of deny) if (re.test(text)) out.push({ file: rel, what: `public guard word /${re.source}/` });
    const tp = THIRD_PARTY.exec(text);
    if (tp) out.push({ file: rel, what: `third-party script or font: ${tp[0]}` });
    for (const m of text.matchAll(HEX64)) if (!o.allowHex?.has(m[0].toLowerCase())) out.push({ file: rel, what: `64-hex value ${m[0].slice(0, 12)}...` });
  }
  return out;
}

/** 64-hex constants that legitimately ship in the bundle: typed-data type hashes, curve constants and pinned hashes. */
export function bundledConstants(): Set<string> {
  const p = join(WEB, "scripts/dist-hex-allow.txt");
  if (!existsSync(p)) return new Set();
  return new Set(
    readFileSync(p, "utf8")
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0]?.toLowerCase() ?? "")
      .filter((l) => /^0x[0-9a-f]{64}$/.test(l)),
  );
}

if (import.meta.main) {
  const dist = resolve(process.argv[2] ?? join(WEB, "dist"));
  const problems = checkDist(dist, { allowHex: bundledConstants() });
  if (problems.length) {
    for (const p of problems) console.error(`check-dist: ${p.file}: ${p.what}`);
    console.error(`check-dist: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log("check-dist: clean (no source maps, no server paths, no .env values, public guard words absent)");
}
