// The owner's own page code (public/bloop-views.js and app.js) drawn in happy-dom, then the live wiring over it
// against the stub API: the placeholders take live values, each live view shows its loading, empty, error and
// offline states, and the owner's markup and copy stay in place.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { configFromEnv, type AppConfig } from "../../src/config";
import { startDashboard } from "../../src/site/dashboard";
import { wireMarketsPage, wirePricingPage, wireQuotesPage } from "../../src/site/feature";
import { NOW, stubApi, type Stub } from "./stub-api";

const PUBLIC = join(import.meta.dir, "../../public");
const OWNER = readFileSync(join(PUBLIC, "bloop-views.js"), "utf8") + "\n" + readFileSync(join(PUBLIC, "app.js"), "utf8");
const ATTACHED = readFileSync(join(PUBLIC, "capstan-attached-a.js"), "utf8");

/** Draws an owner page the way the browser does: the shell, then bloop-views.js and app.js as one classic script. */
function ownerPage(page: string) {
  document.body.innerHTML = `<div id="app"></div><dialog id="social-dialog"><div class="dialog-inner"><button class="dialog-close"></button><button class="button primary dialog-done"></button></div></dialog>`;
  document.body.dataset.page = page;
  (0, eval)(OWNER);
  if (["markets", "developers", "risk", "about", "how-it-works"].includes(page)) {
    history.replaceState(null, "", `/${page}.html`);
    (0, eval)(ATTACHED);
  }
}

const cfgFor = (s: Stub): AppConfig => ({ ...configFromEnv({}), apiBase: "http://api.test/v1", fetch: s.fetch, now: () => NOW });
const settle = async (ms = 30) => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, ms / 6)));
};
const sheet = () => [...document.querySelectorAll("#bl-detail-visual .bl-detail-sheet > div > b")].map((b) => b.textContent);

afterEach(() => {
  delete (window as unknown as { capstanLive?: unknown }).capstanLive;
  document.body.innerHTML = "";
  delete document.body.dataset.page;
});

describe("site pages", () => {
  test("markets", async () => {
    ownerPage("markets");
    const ownerHeading = document.querySelector("main h1")!.textContent;
    expect(sheet()).toEqual(["01", "02", "03"]); // the owner's placeholders before the API answers
    const s = stubApi();
    await wireMarketsPage(cfgFor(s));
    expect(sheet()).toEqual(["BTC", "USDC", "BTC"]);
    // the owner's tab handler redraws the sheet; the live values come back each time
    (document.querySelector('[data-detail="3"]') as HTMLButtonElement).click();
    await settle();
    expect(sheet()).toEqual(["0.0013%", "10.95%", "every hour"]);
    const live = document.querySelector('[data-live="markets"]')!;
    expect(live.querySelector("[data-funding-table]")).not.toBeNull();
    expect(live.querySelectorAll("[data-funding-row]").length).toBe(3);
    expect(live.querySelector("[data-book-mid]")!.textContent).toBe("100,005.00");
    // the live section sits before the closing panel; the owner's heading is unchanged
    expect(live.nextElementSibling?.classList.contains("bl-end")).toBe(true);
    expect(document.querySelector("main h1")!.textContent).toBe(ownerHeading);
    // another asset
    (live.querySelector('[data-asset-chip="CR:ETH"]') as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector('[data-live="markets"] [data-funding-row="hyperliquid:-:ETH"]')).not.toBeNull();
    // the owner's comparison card: its bars carry observed funding now
    expect(document.querySelectorAll(".cap-chart-bars i[data-live-value]").length).toBe(14);
    expect(document.querySelector(".cap-chart-overlay small")!.textContent).toContain("Observed funding");
  });

  test("markets states", async () => {
    for (const [mode, state] of [["empty", "empty"], ["error", "error"], ["down", "offline"]] as const) {
      ownerPage("markets");
      const s = stubApi();
      s.mode = mode;
      await wireMarketsPage(cfgFor(s));
      const el = document.querySelector('[data-live="markets"] [data-live-state]')!;
      expect({ mode, state: el.getAttribute("data-live-state") }).toEqual({ mode, state });
      // the owner's placeholders stay while there is nothing live to show
      expect(sheet()).toEqual(["01", "02", "03"]);
    }
  });

  test("quotes and pricing", async () => {
    ownerPage("quotes");
    const s = stubApi();
    let mounted: HTMLElement | null = null;
    await wireQuotesPage(cfgFor(s), (el) => (mounted = el));
    expect(mounted).not.toBeNull();
    const cards = document.querySelectorAll("[data-quote-leg]");
    expect(cards.length).toBe(3);
    // each cost on its own line, per venue
    const first = cards[0]!;
    for (const c of ["venue-fee", "builder-fee", "slippage", "funding", "liq"]) expect(first.querySelector(`[data-col="${c}"]`)).not.toBeNull();
    expect(sheet()).toEqual(["Hyperliquid", "venue schedule", "4.50 bps"]);
    // no total across venues anywhere in the quote section
    expect(document.querySelector('[data-live="quotes"]')!.textContent).not.toMatch(/total/i);

    ownerPage("pricing");
    await wirePricingPage(cfgFor(s));
    const input = document.querySelector<HTMLInputElement>("#notional")!;
    input.value = "50000";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelector("#fee-result")!.textContent).toBe("$10.00");
    expect(document.querySelector<HTMLElement>("#fee-result")!.dataset.liveValue).toBe("2");
    // API down: the owner's own calculator keeps working
    ownerPage("pricing");
    const d = stubApi();
    d.mode = "down";
    await wirePricingPage(cfgFor(d));
    expect(document.querySelector<HTMLElement>("#fee-result")!.dataset.liveValue).toBeUndefined();
  });

  test("dashboard", async () => {
    ownerPage("dashboard");
    const notice = document.querySelector<HTMLElement>(".dash-notice")!;
    expect(notice.textContent).toContain("specification stage");
    const s = stubApi();
    await act(async () => startDashboard(cfgFor(s)));
    await settle(120);
    const cards = [...document.querySelectorAll(".stats-grid .stat-card strong")].map((x) => x.textContent);
    expect(cards[0]).toBe("6");
    expect(cards[1]).toBe("3");
    expect(cards[3]).toBe("—"); // portfolio risk is never one number across venues
    expect(notice.hidden).toBe(true);
    const prices = [...document.querySelectorAll(".markets-panel .row-status")].map((x) => x.textContent);
    expect(prices).toEqual(["$100,005.00", "$100,005.00", "$100,005.00"]);
    expect(document.querySelectorAll(".overview-panel .bars i[data-live-value]").length).toBe(7);

    // the markets view: the owner's search still filters the live rows
    await act(async () => (document.querySelector('[data-view="markets"]') as HTMLButtonElement).click());
    await settle(60);
    const rows = document.querySelectorAll("#market-list [data-market]");
    expect(rows.length).toBe(4);
    const search = document.querySelector<HTMLInputElement>("#market-search")!;
    search.value = "eth";
    search.dispatchEvent(new Event("input"));
    expect([...document.querySelectorAll<HTMLElement>("#market-list [data-market]")].filter((r) => !r.hidden).length).toBe(1);
    await act(async () => (document.querySelector('#market-list [data-asset="CR:ETH"]') as HTMLButtonElement).click());
    await settle(60);
    expect(document.querySelector("#cap-market-detail [data-funding-table]")).not.toBeNull();
    expect(document.querySelector("#cap-market-detail [data-book-mid]")).not.toBeNull();

    // trade, risk and activity mount the SDK screens in the owner's panel
    for (const [view, screen] of [["trade", "connect"], ["risk", "risk"], ["activity", "receipts"]] as const) {
      await act(async () => (document.querySelector(`[data-view="${view}"]`) as HTMLButtonElement).click());
      await settle(60);
      expect({ view, screen: !!document.querySelector(`[data-live="${view}"] [data-screen="${screen}"]`) }).toEqual({ view, screen: true });
    }
    // the account button opens the connect step
    await act(async () => (document.querySelector('[data-view="overview"]') as HTMLButtonElement).click());
    await act(async () => document.querySelector<HTMLButtonElement>(".dash-tools .profile")!.click());
    await settle(60);
    expect(document.querySelector('[data-live="trade"] [data-screen="connect"]')).not.toBeNull();
  });

  test("dashboard offline", async () => {
    ownerPage("dashboard");
    const s = stubApi();
    s.mode = "down";
    await act(async () => startDashboard(cfgFor(s)));
    await settle(60);
    // the owner's not-connected lines stay; one plain offline line is added
    expect(document.querySelector<HTMLElement>(".dash-notice")!.hidden).toBe(false);
    expect(document.querySelector('[data-live-state="offline"]')).not.toBeNull();
    expect(document.querySelector(".stats-grid .stat-card strong")!.textContent).toBe("—");
  });
});
