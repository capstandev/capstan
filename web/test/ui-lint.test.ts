// R8: no AI-tell UI. Fails on CSS animations (pulse, blink and any other keyframes), "online"/"live"/"REC" badges,
// sparkle icons and numbered feature cards, in the source and in every rendered page.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderAll, visibleText } from "../scripts/check-copy";

const SRC = join(import.meta.dir, "../src");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? (n === "generated" ? [] : walk(join(d, n))) : [join(d, n)]));

export interface Tell {
  where: string;
  what: string;
}

export function cssTells(css: string, where: string): Tell[] {
  const out: Tell[] = [];
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)/g)) out.push({ where, what: `keyframes ${m[1]}` });
  if (/(^|[\s;{])animation(-name)?\s*:/m.test(css)) out.push({ where, what: "animation property" });
  if (/\b(pulse|blink|ping|glow|shimmer)\b/i.test(css)) out.push({ where, what: "pulse or blink style name" });
  return out;
}

export function htmlTells(html: string, where: string): Tell[] {
  const out: Tell[] = [];
  // badges whose whole text is online, live, REC or similar
  for (const m of html.matchAll(/<(span|div|p|small|strong|em|b|i)\b[^>]*>([^<]{1,20})<\/\1>/g)) {
    if (/^\s*(online|offline|live|rec|recording|on air|new)\s*$/i.test(m[2]!)) out.push({ where, what: `badge "${m[2]!.trim()}"` });
  }
  if (/class="[^"]*\b(badge|pill|dot|pulse|blink|sparkle)\b/i.test(html)) out.push({ where, what: "badge, dot or sparkle class" });
  if (/[✨❇✦✧\u{1F31F}\u{1F4AB}\u{1F680}\u{1F525}]/u.test(html)) out.push({ where, what: "sparkle or hype emoji" });
  if (/sparkle|magic-wand|stars-icon/i.test(html)) out.push({ where, what: "sparkle icon" });
  // numbered feature cards: a card whose heading or leading element is a number
  for (const m of html.matchAll(/class="[^"]*\b(card|feature|tile)\b[^"]*"[^>]*>\s*(<[^>]+>\s*)*(0?\d{1,2}[.)]?)\s*</gi)) out.push({ where, what: `numbered card "${m[3]}"` });
  return out;
}

describe("ui lint", () => {
  test("no-ai-tells", async () => {
    const tells: Tell[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f);
      const text = readFileSync(f, "utf8");
      if (f.endsWith(".css")) tells.push(...cssTells(text, rel));
      if (/\.(tsx?|css)$/.test(f)) {
        if (/[✨❇✦✧\u{1F31F}\u{1F4AB}]/u.test(text)) tells.push({ where: rel, what: "sparkle character" });
        if (/\b(pulse|blink|sparkle)\b/i.test(text.replace(/\/\/.*$/gm, ""))) tells.push({ where: rel, what: "pulse, blink or sparkle name" });
        if (/style=\{\{[^}]*animation/.test(text)) tells.push({ where: rel, what: "inline animation" });
      }
    }
    for (const p of await renderAll()) {
      tells.push(...htmlTells(p.html, p.where));
      if (/^\s*(online|live)\s*$/im.test(visibleText(p.html))) tells.push({ where: p.where, what: "a line that only says online or live" });
    }
    expect(tells).toEqual([]);

    // the lint catches each tell
    expect(cssTells("@keyframes pulse { from { opacity: 1 } }", "x").length).toBeGreaterThan(0);
    expect(cssTells(".a { animation: spin 1s infinite }", "x").length).toBeGreaterThan(0);
    expect(htmlTells('<span class="x">Online</span>', "x").length).toBe(1);
    expect(htmlTells("<b>REC</b>", "x").length).toBe(1);
    expect(htmlTells("<p>✨ New</p>", "x").length).toBe(1);
    expect(htmlTells('<div class="card"><h3>01</h3><p>Fast</p></div>', "x").length).toBe(1);
    expect(htmlTells('<li class="card"><span>2.</span> Fast</li>', "x").length).toBe(1);
    expect(htmlTells('<div class="card"><h3>Hyperliquid</h3></div>', "x")).toEqual([]);
  });
});
