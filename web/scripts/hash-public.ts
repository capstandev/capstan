// After `vite build`: gives every file Vite copied from public/ (the owner's styles, scripts, bundles, images and
// videos) a content-hashed name under assets/, rewrites every reference to it in the built HTML, CSS and JS, and
// removes public files nothing references. Vite's own output (_app/) is hashed already. With every name hashed, the
// host can serve assets/ and _app/ as immutable (vercel.json) and a changed file always gets a new URL.
// Usage: bun scripts/hash-public.ts [distDir]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const WEB = resolve(import.meta.dir, "..");

/** Public files that keep their names: read by name by the app or by crawlers. */
export const KEEP = new Set(["contracts.json", "robots.txt", "favicon.ico"]);
const TEXT = /\.(html|css|js|mjs|json|svg|txt)$/i;

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A reference to `path` in text: not preceded or followed by a path or name character (an optional "/" or "./" prefix). */
export const refPattern = (path: string) => new RegExp(`(?<![A-Za-z0-9_\\-./])(\\.?/)?${esc(path)}(?![A-Za-z0-9_\\-])`, "g");

export function hashedName(path: string, content: Buffer | string): string {
  const hash = createHash("sha256").update(content).digest("base64url").slice(0, 10).replace(/[-_]/g, "x");
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length).replace(/^assets\//, "");
  return `assets/${stem}-${hash}${ext}`;
}

export interface HashResult {
  renamed: Record<string, string>;
  pruned: string[];
}

export function hashPublic(dist: string, publicDir = join(WEB, "public")): HashResult {
  const pub = walk(publicDir).filter((p) => !KEEP.has(p) && existsSync(join(dist, p)));
  const pubSet = new Set(pub);
  const all = () => walk(dist).filter((p) => TEXT.test(p));
  const read = (p: string) => readFileSync(join(dist, p), "utf8");
  const refsIn = (text: string) => pub.filter((q) => refPattern(q).test(text));

  // which public files are referenced at all (from the pages, Vite's chunks, or another referenced public file)
  const used = new Set<string>();
  const queue = all()
    .filter((p) => !pubSet.has(p))
    .flatMap((p) => refsIn(read(p)));
  while (queue.length) {
    const q = queue.pop() as string;
    if (used.has(q)) continue;
    used.add(q);
    if (TEXT.test(q)) queue.push(...refsIn(read(q)));
  }
  const pruned = pub.filter((p) => !used.has(p));
  for (const p of pruned) rmSync(join(dist, p));

  // hash leaves first: a text file's hash is taken after its own references were rewritten
  const renamed: Record<string, string> = {};
  const done = new Set<string>();
  const visit = (p: string, stack: Set<string>) => {
    if (done.has(p)) return;
    if (stack.has(p)) throw new Error(`hash-public: reference cycle through ${p}`);
    stack.add(p);
    if (TEXT.test(p)) {
      for (const q of refsIn(read(p))) if (used.has(q) && q !== p) visit(q, stack);
      let text = read(p);
      for (const [from, to] of Object.entries(renamed)) text = text.replace(refPattern(from), (_m, pre) => `${pre ?? ""}${to}`);
      writeFileSync(join(dist, p), text);
    }
    const target = hashedName(p, readFileSync(join(dist, p)));
    mkdirSync(dirname(join(dist, target)), { recursive: true });
    renameSync(join(dist, p), join(dist, target));
    renamed[p] = target;
    stack.delete(p);
    done.add(p);
  };
  for (const p of [...used].sort()) visit(p, new Set());

  // then every page and Vite chunk
  for (const p of all()) {
    if (Object.values(renamed).includes(p)) continue;
    let text = read(p);
    const before = text;
    for (const [from, to] of Object.entries(renamed)) text = text.replace(refPattern(from), (_m, pre) => `${pre ?? ""}${to}`);
    if (text !== before) writeFileSync(join(dist, p), text);
  }
  // empty folders left by moves
  for (const d of ["assets/supplied"]) {
    const p = join(dist, d);
    if (existsSync(p) && readdirSync(p).length === 0) rmSync(p, { recursive: true });
  }
  return { renamed, pruned };
}

/** Every reference in the built text that still names a public file by its unhashed name. */
export function unhashedRefs(dist: string, publicDir = join(WEB, "public")): { file: string; ref: string }[] {
  const pub = walk(publicDir).filter((p) => !KEEP.has(p));
  const out: { file: string; ref: string }[] = [];
  for (const f of walk(dist).filter((p) => TEXT.test(p))) {
    const text = readFileSync(join(dist, f), "utf8");
    for (const q of pub) if (refPattern(q).test(text)) out.push({ file: f, ref: q });
  }
  return out;
}

if (import.meta.main) {
  const dist = resolve(process.argv[2] ?? join(WEB, "dist"));
  const r = hashPublic(dist);
  const left = unhashedRefs(dist);
  if (left.length) {
    for (const l of left) console.error(`hash-public: ${l.file} still names ${l.ref}`);
    process.exit(1);
  }
  console.log(`hash-public: ${Object.keys(r.renamed).length} files hashed, ${r.pruned.length} unreferenced public files left out`);
}
