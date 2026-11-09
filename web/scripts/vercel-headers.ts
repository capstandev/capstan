// The response headers vercel.json gives a request path, so tests can serve a build the way the host does (CSP, frame
// and robots headers, cache rules). Every `source` in vercel.json is written as a plain regular expression (groups and
// lookaheads only, no :named params), which is how path-to-regexp reads it too; a later rule overrides an earlier one
// for the same header, as on Vercel. Usage: headersFor("/docs") or headersFor("/_app/x-abc123.js").
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WEB = resolve(import.meta.dir, "..");

export interface VercelConfig {
  ignoreCommand?: string;
  headers: { source: string; headers: { key: string; value: string }[] }[];
  [k: string]: unknown;
}

export const readVercelConfig = (dir = WEB): VercelConfig => JSON.parse(readFileSync(join(dir, "vercel.json"), "utf8")) as VercelConfig;

/** The source pattern as an anchored RegExp. Throws on a path-to-regexp feature this helper does not model. */
export function sourceRegExp(source: string): RegExp {
  if (/:[A-Za-z_]/.test(source)) throw new Error(`vercel.json source ${source} uses a named parameter; write it as a plain group`);
  return new RegExp(`^${source}$`);
}

/** Headers (lower-case keys) for one request path. */
export function headersFor(pathname: string, cfg: VercelConfig = readVercelConfig()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of cfg.headers ?? []) {
    if (!sourceRegExp(rule.source).test(pathname)) continue;
    for (const h of rule.headers) out[h.key.toLowerCase()] = h.value;
  }
  return out;
}
