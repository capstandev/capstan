// R7: at 390 px wide no page scrolls sideways (headless Chromium; skipped with a note when none is installed). The
// owner's typography sets its own small sizes (labels, kickers), so the old 14 px floor is not applied (DECISIONS 222).
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
          await page.waitForSelector("#app main", { state: "attached" });
          const m = (await page.evaluate(MEASURE)) as { vw: number; sw: number; small: string[] };
          expect({ path, vw: m.vw, overflow: m.sw > m.vw }).toEqual({ path, vw: 390, overflow: false });
        }
        await page.close();
        console.log(`responsive: ${SITE_PATHS.length} pages fit 390 px`);
      });
    } finally {
      srv.stop();
    }
  }, 400_000);
});
