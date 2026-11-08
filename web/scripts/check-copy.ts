// check:copy (todo 38 R3): the repo's banned-word checker over web/, then the site copy rules on the text every page
// actually renders (static render of each page, with every live flag off and on, plus index.html):
//   - the banned list (ops/ci/banned-words.txt, exact allowed sentences excepted)
//   - no "official"; no "first" unless the same sentence carries "(U)"
//   - no VPN or workaround wording; no wording that suggests margin is pooled across venues
//   - the ticker only as "$CPST on Robinhood Chain"
//   - every hedge word with "Legging risk is yours" on the same line
// Usage: bun scripts/check-copy.ts
import { resolve } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { findBannedWords, loadAllowed, loadBanned, stripAllowed } from "../../ops/ci/check-banned-words";
import { ConfigContext, configFromEnv, type AppConfig } from "../src/config";
import { TOKEN_LINE } from "../src/copy";
import type { LiveFlags } from "../src/live";
import { syncGenerated } from "./sync-openapi";

const WEB = resolve(import.meta.dir, "..");
const REPO = resolve(WEB, "..");

export interface CopyProblem {
  where: string;
  rule: string;
  text: string;
}

/** Visible text of an HTML string: tags removed, aria-label, alt and title values kept, entities decoded. */
export function visibleText(html: string): string {
  const attrs: string[] = [];
  for (const m of html.matchAll(/\s(?:aria-label|alt|title|placeholder)="([^"]*)"/g)) attrs.push(m[1]!);
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|li|h[1-6]|dt|dd|td|th|div|section|caption|summary|pre|button|a|label|title)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return [body, ...attrs]
    .join("\n")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

const EXTRA: { rule: string; test: (s: string) => boolean }[] = [
  { rule: "no 'official'", test: (s) => /\bofficial(ly)?\b/i.test(s) },
  { rule: "'first' needs '(U)' in the same sentence", test: (s) => /\bfirst\b/i.test(s.replace(/\b(newest|oldest|latest|earliest) first\b/gi, "")) && !s.includes("(U)") },
  { rule: "no VPN or workaround wording", test: (s) => /\bvpns?\b|\bwork-?arounds?\b|\bget around\b|\bbypass(es|ing)?\b/i.test(s) },
  // written split so this file passes the banned-word scan it is part of
  { rule: "no pooled-margin wording", test: (s) => new RegExp(["\\bcross[- ]?mar", "gin|\\bshared[- ]coll", "ateral\\b"].join(""), "i").test(s) },
];

/** Every ticker mention must be the full line "$CPST on Robinhood Chain". */
export function tickerProblems(text: string): string[] {
  const bad: string[] = [];
  const flat = text.replace(/\s+/g, " ");
  for (const m of flat.matchAll(/\$?\bCPST\b/g)) {
    const at = m.index ?? 0;
    const start = flat[at] === "$" ? at : at - 1;
    if (flat.slice(start, start + TOKEN_LINE.length) !== TOKEN_LINE) bad.push(flat.slice(Math.max(0, at - 30), at + 40));
  }
  return bad;
}

export function copyProblems(text: string, where: string, banned = loadBanned(), allowed = loadAllowed()): CopyProblem[] {
  const out: CopyProblem[] = [];
  // exact allowed sentences (the risk banner) are removed from the flat text before it is split into sentences
  for (const s of sentences(stripAllowed(text.replace(/[ \t]+/g, " "), allowed))) {
    const stripped = s;
    for (const re of banned) if (re.test(stripped)) out.push({ where, rule: `banned /${re.source}/`, text: s });
    for (const r of EXTRA) if (r.test(stripped)) out.push({ where, rule: r.rule, text: s });
  }
  for (const t of tickerProblems(text)) out.push({ where, rule: `ticker only as "${TOKEN_LINE}"`, text: t });
  // a hedge word never stands without "legging risk is yours" on the same line (the copy rules)
  for (const line of text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()))
    if (/\bhedg(e|ed|es|ing)\b/i.test(line) && !/legging risk is yours/i.test(line)) out.push({ where, rule: "hedge needs 'Legging risk is yours' next to it", text: line });
  return out;
}

export function renderPage(el: ReactNode, path = "/", cfg: AppConfig = configFromEnv({})): string {
  return renderToStaticMarkup(createElement(ConfigContext.Provider, { value: cfg }, createElement(MemoryRouter, { initialEntries: [path] }, el)));
}

/** Every page and screen, rendered with every live flag off and then on. */
export async function renderAll(): Promise<{ where: string; html: string }[]> {
  syncGenerated();
  const { siteRenderables } = await import("../src/renderables");
  const out: { where: string; html: string }[] = [];
  const flags: LiveFlags[] = [
    { npmPublished: false, x402UsdgSettled: false, sourcePublic: false },
    { npmPublished: true, x402UsdgSettled: true, sourcePublic: true },
  ];
  for (const live of flags) {
    for (const r of siteRenderables(live)) out.push({ where: `${r.name} (live flags ${live.npmPublished ? "on" : "off"})`, html: renderPage(r.element, r.path, r.config) });
  }
  return out;
}

export async function checkCopy(): Promise<{ problems: CopyProblem[]; pages: number }> {
  const problems: CopyProblem[] = [];
  for (const h of findBannedWords(REPO).filter((x) => x.file.startsWith("web/"))) problems.push({ where: `${h.file}:${h.line}`, rule: `banned /${h.pattern}/`, text: h.text });
  const pages = await renderAll();
  for (const p of pages) problems.push(...copyProblems(visibleText(p.html), p.where));
  return { problems, pages: pages.length };
}

if (import.meta.main) {
  const { problems, pages } = await checkCopy();
  if (problems.length) {
    for (const p of problems) console.error(`check:copy: ${p.where}: ${p.rule}: ${p.text}`);
    console.error(`check:copy: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`check:copy: clean (${pages} rendered pages and web/ source)`);
}
