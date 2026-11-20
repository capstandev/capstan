// Crawlers read the main pages: each one's static HTML carries its own title, description, headings and body copy
// (scripts/prerender.ts), counted the way the launch check counts (tags, scripts and styles removed). And the
// browser still runs the page as before: app.js, run over the prerendered page, writes the very same markup into #app.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_PAGES, PRERENDER } from "../scripts/prerender";
import { CHANGELOG_COPY, ROADMAP_COPY } from "../src/copy";
import { buildOnce, WEB } from "./browser";

/** Words a crawler that runs no JavaScript reads (launch-visible-check.sh's count). */
export function crawlerWords(html: string): number {
  const t = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "");
  return t.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
}

const appInner = (html: string) => /<div id="app">([\s\S]*?)<\/div><dialog id="social-dialog">/.exec(html)?.[1] ?? "";

/** Each page's own title and description: the six main pages as the owner approved them (2026-11-20), and /roadmap
 *  and /changelog in words those pages carry. The page shells hold them; the build must not change them. */
export const PAGE_META: Record<string, { title: string; description: string }> = {
  index: { title: "Capstan: On-chain perps you can see clearly", description: "Capstan brings markets, quotes and risk across venues into one API, SDK and MCP server. Every venue stays in view, and your keys stay with you." },
  "how-it-works": { title: "How Capstan works: compare, preview, sign | Capstan", description: "See how Capstan brings together markets, quotes, local signing and venue-specific risk. Four steps from a market question to a clearer view." },
  pricing: { title: "Capstan Pricing: Free reads, pay per call data", description: "Core reads and workflows are free, with pay-as-you-go premium data and a Pro tier. Builder fee default is 2 bps. Lighter routes carry no builder fee." },
  developers: { title: "Capstan Toolkit: API, SDK and MCP for on-chain perps", description: "Tools for market data, quotes, risk and building on-chain perps products. Markets and data, quotes and orders, risk and receipts, in one view." },
  markets: { title: "Capstan Markets: Books and funding across venues", description: "Capstan normalizes venue markets, books and funding into one common view. Includes canonical markets, order books, mark prices and annualised funding." },
  docs: { title: "Capstan API Docs: REST endpoints and MCP tools", description: "Every write endpoint returns an unsigned payload. Nothing accepts a private key. Your SDK or agent host signs locally. REST endpoints and MCP tools." },
  roadmap: { title: "Capstan Roadmap: one update an hour from launch", description: ROADMAP_COPY.intro },
  changelog: { title: "Capstan Changelog: every update, bonus update and fix", description: "The Capstan changelog: each update, bonus update and fix, with its date." },
};
const metaOf = (html: string) => ({
  title: /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? "",
  description: /<meta name="description" content="([^"]+)"/.exec(html)?.[1] ?? "",
});
/** Pages whose content is short until releases exist: held by their real heading and lines, not by a word count. */
const SHORT_UNTIL_RELEASES = new Set(["changelog"]);

describe("prerender", () => {
  test("each-page-has-its-own-title-and-description", async () => {
    const dist = await buildOnce();
    expect(PRERENDER.map((p) => p.page).sort()).toEqual(Object.keys(PAGE_META).sort());
    for (const { page } of PRERENDER) {
      // the same in the page shell and in the built, prerendered page
      expect({ page, ...metaOf(readFileSync(join(WEB, `${page}.html`), "utf8")) }).toEqual({ page, ...PAGE_META[page]! });
      expect({ page, ...metaOf(readFileSync(join(dist, `${page}.html`), "utf8")) }).toEqual({ page, ...PAGE_META[page]! });
      const html = readFileSync(join(dist, `${page}.html`), "utf8");
      expect({ page, titles: html.split("<title>").length - 1, descriptions: html.split('<meta name="description"').length - 1 }).toEqual({ page, titles: 1, descriptions: 1 });
      // og tags, when a page has them, say the same
      for (const [prop, want] of [["og:title", PAGE_META[page]!.title], ["og:description", PAGE_META[page]!.description]] as const) {
        const og = new RegExp(`<meta property="${prop}" content="([^"]*)"`).exec(html)?.[1];
        if (og !== undefined) expect({ page, prop, og }).toEqual({ page, prop, og: want });
      }
    }
    const all = Object.values(PAGE_META);
    expect(new Set(all.map((m) => m.title)).size).toBe(all.length);
    expect(new Set(all.map((m) => m.description)).size).toBe(all.length);
    for (const m of all) expect({ t: m.title, title: m.title.length <= 60, description: m.description.length <= 160 }).toEqual({ t: m.title, title: true, description: true });
  }, 120_000);

  test("crawlers-read-each-page", async () => {
    const dist = await buildOnce();
    for (const { page } of PRERENDER) {
      const html = readFileSync(join(dist, `${page}.html`), "utf8");
      const title = /<title>([^<]+)<\/title>/.exec(html)?.[1]?.trim() ?? "";
      const description = /<meta name="description" content="([^"]+)"/.exec(html)?.[1] ?? "";
      const inner = appInner(html);
      if (!SHORT_UNTIL_RELEASES.has(page)) expect({ page, words: crawlerWords(html) >= 200 }).toEqual({ page, words: true });
      expect({ page, title: title.length > 0, description: description.length > 0 }).toEqual({ page, title: true, description: true });
      expect({ page, h1: /<h1[\s>]/.test(inner), nav: inner.includes('class="site-header"') }).toEqual({ page, h1: true, nav: true });
      // no script of its own in the page text, and the page still loads app.js and the module entry
      expect(inner).not.toMatch(/<script/i);
      expect(html).toMatch(/<script src="assets\/app-[A-Za-z0-9]+\.js">/);
      expect(html).toMatch(/<script type="module"[^>]+src="\/_app\/main-[^"]+\.js">/);
    }
    // /docs carries the API reference itself, not only the frame around it
    const docs = readFileSync(join(dist, "docs.html"), "utf8");
    expect(docs).toContain("/v1/history/funding");
    expect(docs).toContain("MCP tools");
    // /roadmap carries the queue itself: the heading, the intro, every day and the first and last update
    const roadmap = appInner(readFileSync(join(dist, "roadmap.html"), "utf8"));
    expect(roadmap).toContain(`<h1>${ROADMAP_COPY.title}</h1>`);
    expect(roadmap).toContain(ROADMAP_COPY.intro);
    expect(roadmap).toContain(`>${ROADMAP_COPY.day(1)}</h2>`);
    expect((roadmap.match(/<li class="card" data-update="\d+">/g) ?? []).length).toBeGreaterThanOrEqual(72);
    // /changelog carries its heading and either the released entries or the line that says there are none yet
    const changelog = appInner(readFileSync(join(dist, "changelog.html"), "utf8"));
    expect(changelog).toContain(`<h1>${CHANGELOG_COPY.title}</h1>`);
    const entries = (changelog.match(/<li class="card" data-entry="/g) ?? []).length;
    expect({ entries: entries > 0, empty: changelog.includes(CHANGELOG_COPY.empty) }).toEqual(entries > 0 ? { entries: true, empty: false } : { entries: false, empty: true });
  });

  test("app-js-writes-the-same-markup", async () => {
    const dist = await buildOnce();
    // in its own process: appMarkup registers happy-dom globals of its own
    const code = `import { appMarkup, PRERENDER } from "./scripts/prerender"; import { readFileSync } from "node:fs";
      const out = {}; for (const { page, path } of PRERENDER) out[page] = appMarkup(${JSON.stringify(dist)}, readFileSync(${JSON.stringify(dist)} + "/" + page + ".html", "utf8"), path);
      console.log(JSON.stringify(out));`;
    const r = Bun.spawnSync(["bun", "-e", code], { cwd: WEB, stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).toBe("");
    const rerun = JSON.parse(r.stdout.toString()) as Record<string, string>;
    for (const { page } of PRERENDER) {
      let inner = appInner(readFileSync(join(dist, `${page}.html`), "utf8"));
      // the React pages: React mounts into #cap-live after app.js has emptied it, exactly as before
      if ((LIVE_PAGES as readonly string[]).includes(page)) inner = inner.replace(/(<div id="cap-live"[^>]*>)[\s\S]*<\/div>(<\/div><\/section><\/main>)/, "$1</div>$2");
      expect({ page, same: rerun[page] === inner }).toEqual({ page, same: true });
    }
  });
});
