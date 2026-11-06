// R7: at 390 px wide no page scrolls sideways and no text is smaller than 14 px (headless Chromium; skipped with a
// note when none is installed).
import { describe, expect, test } from "bun:test";
import { buildOnce, chromiumPath, MEASURE, serveDist, SITE_PATHS, SKIP_NO_CHROMIUM, withBrowser } from "./browser";

describe("responsive", () => {
  test("390px", async () => {
    if (!chromiumPath()) {
      console.warn(`responsive: ${SKIP_NO_CHROMIUM}`);
      return;
    }
    const dist = await buildOnce();
    const srv = serveDist(dist);
    try {
      await withBrowser(async (browser) => {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        for (const path of SITE_PATHS) {
          await page.goto(`${srv.url}${path}`, { waitUntil: "networkidle" });
          await page.waitForSelector("main h1");
          const m = (await page.evaluate(MEASURE)) as { vw: number; sw: number; small: string[] };
          expect({ path, vw: m.vw, overflow: m.sw > m.vw }).toEqual({ path, vw: 390, overflow: false });
          expect({ path, small: m.small }).toEqual({ path, small: [] });
        }
        await page.close();
        console.log(`responsive: ${SITE_PATHS.length} pages fit 390 px with no text under 14 px`);
      });
    } finally {
      srv.stop();
    }
  }, 180_000);
});
