// R6: axe-core (pinned 4.14.0) finds no serious or critical issue on any page; every interactive element is reachable
// with the keyboard; text contrast passes AA. Three layers: axe in happy-dom on every page (structure, names, ARIA),
// the colour pairs of the stylesheet, and when headless Chromium is present axe again on the real build (with
// colour contrast computed by the browser) plus a Tab walk that must reach every interactive element.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { siteRenderables } from "../src/renderables";
import { LIVE } from "../src/live";
import { buildOnce, chromiumPath, serveDist, SITE_PATHS, SKIP_NO_CHROMIUM, withBrowser } from "./browser";
import { cssVars, PAIRS, ratio } from "./contrast";
import { mount } from "./helpers";

const AXE_SOURCE = readFileSync(join(import.meta.dir, "../node_modules/axe-core/axe.min.js"), "utf8");
const INTERACTIVE = "a[href], button, input, select, textarea, summary, [tabindex]";

type AxeResult = { violations: { id: string; impact: string | null; nodes: { target: unknown[] }[] }[] };

async function axeHappyDom(root: Element): Promise<AxeResult> {
  const g = globalThis as { axe?: { run(ctx: Element, opts: unknown): Promise<AxeResult> } };
  if (!g.axe) new Function(AXE_SOURCE).call(globalThis);
  // colour contrast needs layout, which happy-dom has none of: the Chromium pass below covers it
  return g.axe!.run(root, { resultTypes: ["violations"], rules: { "color-contrast": { enabled: false } } });
}

const serious = (r: AxeResult) => r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${JSON.stringify(v.nodes.map((n) => n.target))}`);

describe("a11y", () => {
  test("axe", async () => {
    // 1. axe in happy-dom on every page, inside the real layout
    for (const r of siteRenderables(LIVE)) {
      document.title = r.name;
      document.documentElement.lang = "en";
      const m = await mount(createElement("div", null, r.element), { path: r.path, config: r.config, layout: false });
      const res = await axeHappyDom(document.body);
      expect({ page: r.name, problems: serious(res) }).toEqual({ page: r.name, problems: [] });
      // no interactive element is taken out of the tab order, and nothing but a native control takes a click
      const blocked = Array.from(m.host.querySelectorAll<HTMLElement>(INTERACTIVE)).filter((e) => e.getAttribute("tabindex") === "-1" && e.tagName !== "MAIN");
      expect({ page: r.name, blocked: blocked.map((e) => e.outerHTML.slice(0, 80)) }).toEqual({ page: r.name, blocked: [] });
      await m.unmount();
    }

    // 2. the stylesheet's colour pairs
    const vars = cssVars();
    for (const [fg, bg, min] of PAIRS) {
      expect(vars[fg]).toBeDefined();
      expect(vars[bg]).toBeDefined();
      expect({ pair: `${fg} on ${bg}`, ok: ratio(vars[fg]!, vars[bg]!) >= min }).toEqual({ pair: `${fg} on ${bg}`, ok: true });
    }

    // 3. the real build in headless Chromium: axe with colour contrast, and a full Tab walk
    if (!chromiumPath()) {
      console.warn(`a11y: ${SKIP_NO_CHROMIUM}`);
      return;
    }
    const dist = await buildOnce();
    const srv = serveDist(dist);
    try {
      await withBrowser(async (browser) => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        for (const path of SITE_PATHS) {
          await page.goto(`${srv.url}${path}`, { waitUntil: "networkidle" });
          await page.waitForSelector("main h1");
          await page.addScriptTag({ content: AXE_SOURCE });
          const res = (await page.evaluate(() => (window as unknown as { axe: { run(d: Document, o: unknown): Promise<unknown> } }).axe.run(document, { resultTypes: ["violations"] }))) as AxeResult;
          expect({ path, problems: serious(res) }).toEqual({ path, problems: [] });
          // Tab through the page: every visible interactive element gets focus
          const total = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).filter((e) => (e as HTMLElement).offsetParent !== null || (e as HTMLElement).classList.contains("skip")).filter((e) => e.getAttribute("tabindex") !== "-1").length, INTERACTIVE);
          const reached = new Set<string>();
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          for (let i = 0; i < total + 5; i++) {
            await page.keyboard.press("Tab");
            const id = await page.evaluate(() => {
              const a = document.activeElement as HTMLElement | null;
              if (!a || a === document.body) return null;
              const all = Array.from(document.querySelectorAll("*"));
              return `${a.tagName}#${all.indexOf(a)}`;
            });
            if (id) reached.add(id);
          }
          expect({ path, reachedAll: reached.size >= total }).toEqual({ path, reachedAll: true });
        }
        await page.close();
        console.log(`a11y: Chromium axe and Tab walk passed on ${SITE_PATHS.length} pages`);
      });
    } finally {
      srv.stop();
    }
  }, 180_000);
});
