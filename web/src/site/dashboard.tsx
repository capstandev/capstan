// The owner's dashboard (dashboard.html), wired to the API. app.js still draws every view; after each draw it calls
// window.capstanLive.dashboardView(view, content) and this module puts live values into the owner's markup:
//   overview   stat cards, venue coverage, the funding bars and the three market rows
//   markets    the market list (the owner's search still filters it) and, on a click, funding and the book
//   trade      the SDK flow screens: connect, onboard, quote, order ticket, spreads, policy and kill
//   risk       one card per venue under the fixed banner (never a cross-venue number)
//   activity   receipts, each linked to the verify page
//   developers API status and links to the docs
// Lines the owner wrote for the not-connected state ("not live", "Awaiting connection", the specification notice) stay
// as the offline state and are hidden while live values show.
import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Route, Routes, useNavigate } from "react-router";
import type { AppConfig } from "../config";
import { DashboardScreens } from "../app/Dashboard";
import { Receipts } from "../app/screens/Receipts";
import { RiskPanel } from "../app/screens/RiskPanel";
import type { RiskView } from "../lib/capstan";
import { assetsOf, bookStats, createReader, escapeHtml as h, fmtPrice, fmtRatePct, listMarkets, readBook, readFunding, readHealth, readLive, readVenues, type LiveState, type Reader } from "./data";
import { bookHtml, fundingTableHtml, marketRowHtml, stateHtml, venueCount } from "./render";
import { mount, Providers } from "./react";
import type { Market, VenueCapabilities } from "./types";

export interface DashData {
  markets: Market[];
  venues: VenueCapabilities[];
}

/** One read of the public data the overview and markets views need. */
export async function loadDashData(r: Reader): Promise<DashData> {
  const [markets, venues] = await Promise.all([listMarkets(r), readVenues(r)]);
  return { markets, venues };
}

export interface OverviewNumbers {
  marketsTracked: number;
  venuesWithMarkets: number;
  executionVenues: number;
}

export function overviewNumbers(d: DashData): OverviewNumbers {
  const perps = d.markets.filter((m) => m.marketType === "perp");
  return {
    marketsTracked: perps.length,
    venuesWithMarkets: new Set(perps.map((m) => m.venue)).size,
    executionVenues: d.venues.filter((v) => v.execution).length,
  };
}

/** The executable market a row's price is read from: Hyperliquid core first, then any executable perp. */
export function priceMarketFor(markets: Market[], asset: string): Market | null {
  const perps = markets.filter((m) => m.canonicalAsset === asset && m.marketType === "perp");
  return perps.find((m) => m.venue === "hyperliquid" && m.dex === null && m.executable) ?? perps.find((m) => m.executable) ?? perps[0] ?? null;
}

// ---- a tiny store the React root reads: which view is showing and where its live mount is ----------------------

type View = { name: string; el: HTMLElement | null };
let current: View = { name: "overview", el: null };
const subs = new Set<() => void>();
const setView = (v: View) => {
  current = v;
  subs.forEach((f) => f());
};
const useView = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => current,
  );

let pendingPath: string | null = null;
let lastRisk: RiskView | null = null;

const showView = (v: string) => (window as unknown as { capstanShowView?: (v: string) => void }).capstanShowView?.(v);

function GoTo() {
  const nav = useNavigate();
  useEffect(() => {
    if (pendingPath) {
      nav(pendingPath);
      pendingPath = null;
    }
  });
  return null;
}

function LiveViews() {
  const v = useView();
  if (!v.el) return null;
  const node =
    v.name === "trade" ? (
      <>
        <GoTo />
        <Routes>
          <Route path="/app/*" element={<DashboardScreens />} />
        </Routes>
      </>
    ) : v.name === "risk" ? (
      <RiskPanel
        onLoaded={(r) => {
          lastRisk = r;
        }}
        {...(lastRisk ? { initial: lastRisk } : {})}
      />
    ) : v.name === "activity" ? (
      <Receipts />
    ) : null;
  return node ? createPortal(<div className="cap-live">{node}</div>, v.el) : null;
}

// ---- the overview and markets views (owner markup, live values) -------------------------------------------------

function hideStateCopy(root: ParentNode, live: boolean) {
  root.querySelectorAll<HTMLElement>(".dash-notice").forEach((n) => (n.hidden = live));
}

export function patchOverview(content: HTMLElement, d: DashData, prices: Record<string, string>, funding: { label: string; annualised: number }[]) {
  const n = overviewNumbers(d);
  const cards = content.querySelectorAll<HTMLElement>(".stats-grid .stat-card");
  const set = (card: HTMLElement | undefined, value: string, small?: string) => {
    if (!card) return;
    const strong = card.querySelector("strong");
    if (strong) {
      strong.textContent = value;
      strong.setAttribute("data-live-value", "");
    }
    const sm = card.querySelector("small");
    if (sm && small !== undefined) sm.textContent = small;
  };
  set(cards[0], String(n.marketsTracked), `Across ${n.venuesWithMarkets} venues`);
  set(cards[1], String(n.executionVenues));
  if (lastRisk) {
    const open = lastRisk.perVenue.reduce((s, a) => s + a.positions.length, 0);
    set(cards[2], String(open), `On ${lastRisk.perVenue.filter((a) => a.positions.length).length} venues`);
  }
  // cards[3] (portfolio risk) stays "Shown by venue": one risk figure across venues would pool their margin
  const donut = content.querySelector<HTMLElement>(".venues-panel .donut > div");
  if (donut?.firstChild) {
    donut.firstChild.textContent = String(n.executionVenues);
    donut.setAttribute("data-live-value", "");
  }
  content.querySelectorAll<HTMLElement>(".venues-panel .tiny-pill").forEach((p) => (p.hidden = true));
  // the three owner rows (Bitcoin, Ethereum, Solana): their price from the book mid
  content.querySelectorAll<HTMLElement>(".markets-panel .market-row").forEach((row) => {
    const label = row.querySelector("small")?.textContent?.split(" ")[0] ?? "";
    const st = row.querySelector<HTMLElement>(".row-status");
    const p = prices[`CR:${label}`];
    if (st && p) {
      st.textContent = p;
      st.setAttribute("data-live-value", "");
    }
  });
  // the bars: observed annualised funding of up to seven markets (height relative to the largest)
  const bars = content.querySelectorAll<HTMLElement>(".overview-panel .bars i");
  const cap = content.querySelector<HTMLElement>(".overview-panel .chart-caption");
  if (bars.length && funding.length) {
    const max = Math.max(...funding.map((f) => Math.abs(f.annualised)), 1e-12);
    bars.forEach((b, i) => {
      const f = funding[i];
      b.style.height = f ? `${Math.max(6, Math.round((Math.abs(f.annualised) / max) * 92))}%` : "4%";
      b.title = f ? `${f.label}: ${fmtRatePct(f.annualised, 2)} observed, annualised` : "";
      b.setAttribute("data-live-value", "");
    });
    const range = content.querySelector<HTMLSelectElement>("#chart-range");
    range?.addEventListener("change", () => patchOverview(content, d, prices, funding));
    if (cap) cap.textContent = `Observed funding, annualised: ${funding.map((f) => f.label).join(", ")}`;
  }
}

export function patchMarketsView(content: HTMLElement, d: DashData, r: Reader, nowMs: () => number) {
  const list = content.querySelector<HTMLElement>("#market-list");
  if (!list) return;
  const assets = assetsOf(d.markets);
  if (!assets.length) {
    list.innerHTML = stateHtml({ kind: "empty" }, "The API lists no markets yet.") ?? "";
    return;
  }
  list.innerHTML = assets.map((a) => marketRowHtml(a, `${a} perpetuals`, `${venueCount(d.markets, a)} venues`, { button: true })).join("");
  content.querySelectorAll<HTMLElement>(".view-panel .tiny-pill").forEach((p) => (p.hidden = true));
  let detail = content.querySelector<HTMLElement>("#cap-market-detail");
  if (!detail) {
    detail = document.createElement("div");
    detail.id = "cap-market-detail";
    detail.className = "dash-panel view-panel cap-live-panel";
    detail.hidden = true;
    list.closest(".view-panel")?.after(detail);
  }
  const search = document.querySelector<HTMLInputElement>("#market-search");
  search?.dispatchEvent(new Event("input"));
  const open = async (asset: string) => {
    if (!detail) return;
    detail.hidden = false;
    detail.innerHTML = stateHtml({ kind: "loading" }) ?? "";
    const s = await readLive(() => readFunding(r, asset), { isEmpty: (f) => f.rows.length === 0 });
    detail.innerHTML = s.kind === "ok" ? `<div class="panel-head"><h3>${h(asset)}</h3></div>${fundingTableHtml(s.data.rows, nowMs())}<div data-book-slot=""></div>` : (stateHtml(s, "No venue publishes funding for this market yet.") ?? "");
    const m = priceMarketFor(d.markets, asset);
    if (m && s.kind === "ok") await showBook(m.id);
  };
  const showBook = async (id: string) => {
    const slot = detail?.querySelector<HTMLElement>("[data-book-slot]");
    if (!slot) return;
    slot.innerHTML = stateHtml({ kind: "loading" }) ?? "";
    const b = await readLive(() => readBook(r, id, 10), { isEmpty: (x) => x.bids.length === 0 && x.asks.length === 0 });
    slot.innerHTML = b.kind === "ok" ? bookHtml(b.data, nowMs()) : (stateHtml(b, "This market's book is empty right now.") ?? "");
  };
  list.onclick = (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-asset]");
    if (row?.dataset.asset) void open(row.dataset.asset);
  };
  detail.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-book]");
    if (b?.dataset.book) void showBook(b.dataset.book);
  };
}

function developersPanel(content: HTMLElement, cfg: AppConfig, r: Reader) {
  const panel = document.createElement("div");
  panel.className = "dash-panel view-panel cap-live-panel";
  panel.dataset.live = "developers";
  panel.innerHTML = stateHtml({ kind: "loading" }) ?? "";
  content.appendChild(panel);
  void readLive(() => readHealth(r)).then((s) => {
    const up = s.kind === "ok" && s.data;
    panel.innerHTML = `<div class="panel-head"><h3>Capstan API</h3></div><dl class="cap-facts"><div><dt>Base URL</dt><dd class="cap-mono cap-break">${h(cfg.apiBase)}</dd></div><div><dt>Health</dt><dd data-live-value="">${s.kind === "offline" ? "you are offline" : up ? "answering" : "not answering"}</dd></div></dl><p class="cap-row"><a class="dash-button" href="docs.html">API and MCP docs ↗</a><a href="status.html">Status ↗</a><a href="verify.html">Verify a receipt ↗</a></p>`;
  });
}

// ---- start ---------------------------------------------------------------------------------------------------------

export function startDashboard(cfg: AppConfig, r: Reader = createReader({ apiBase: cfg.apiBase, ...(cfg.fetch ? { fetch: cfg.fetch } : {}) })) {
  const nowMs = () => (cfg.now ?? Date.now)();
  let data: Promise<LiveState<DashData>> | null = null;
  const getData = () => (data ??= readLive(() => loadDashData(r), { isEmpty: (d) => d.markets.length === 0 && d.venues.length === 0 }));
  let prices: Promise<{ prices: Record<string, string>; funding: { label: string; annualised: number }[] }> | null = null;
  const getPrices = (d: DashData) =>
    (prices ??= (async () => {
      const out: Record<string, string> = {};
      await Promise.all(
        ["CR:BTC", "CR:ETH", "CR:SOL"].map(async (a) => {
          const m = priceMarketFor(d.markets, a);
          if (!m) return;
          const b = await readBook(r, m.id, 5).catch(() => null);
          const mid = b ? bookStats(b).mid : null;
          if (mid) out[a] = `$${fmtPrice(mid)}`;
        }),
      );
      const fund: { label: string; annualised: number }[] = [];
      for (const a of assetsOf(d.markets).slice(0, 7)) {
        const f = await readFunding(r, a).catch(() => null);
        const row = f?.rows.find((x) => x.status === "ok" && x.rateAnnualised !== null);
        if (row) fund.push({ label: a.split(":").pop() ?? a, annualised: Number(row.rateAnnualised) });
      }
      return { prices: out, funding: fund };
    })());

  // one React root for the screens that need the wallet; its views are portals into the owner's view panels
  const host = document.createElement("div");
  host.hidden = true;
  document.body.appendChild(host);
  mount(
    host,
    <Providers
      cfg={cfg}
      onConnect={() => {
        pendingPath = "/app";
        showView("trade");
      }}
    >
      <LiveViews />
    </Providers>,
  );

  // the owner's account button opens the connect step
  const profile = document.querySelector<HTMLButtonElement>(".dash-tools .profile");
  if (profile) {
    profile.onclick = () => {
      pendingPath = "/app";
      showView("trade");
    };
    profile.setAttribute("aria-label", "Connect your wallet");
  }

  async function dashboardView(view: string, content: HTMLElement) {
    if (["trade", "risk", "activity"].includes(view)) {
      const empty = content.querySelector<HTMLElement>(".view-panel.empty-state");
      const el = document.createElement("div");
      el.className = "dash-panel view-panel cap-live-panel";
      el.dataset.live = view;
      if (empty) empty.replaceWith(el);
      else content.appendChild(el);
      setView({ name: view, el });
    } else setView({ name: view, el: null });
    if (view === "developers") developersPanel(content, cfg, r);
    if (view !== "overview" && view !== "markets") return;
    const s = await getData();
    if (current.name !== view) return;
    hideStateCopy(document, s.kind === "ok");
    if (s.kind !== "ok") {
      const where = content.querySelector(view === "markets" ? "#market-list" : ".stats-grid");
      where?.insertAdjacentHTML(view === "markets" ? "afterbegin" : "beforebegin", stateHtml(s, "The API lists no markets yet.") ?? "");
      return;
    }
    if (view === "markets") return patchMarketsView(content, s.data, r, nowMs);
    patchOverview(content, s.data, {}, []);
    const p = await getPrices(s.data);
    if (current.name === "overview") patchOverview(content, s.data, p.prices, p.funding);
  }

  (window as unknown as { capstanLive?: { dashboardView: typeof dashboardView } }).capstanLive = { dashboardView };
  // app.js drew its first view before this module ran
  const first = document.querySelector<HTMLElement>(".dash-nav.selected")?.dataset.view ?? "overview";
  const content = document.querySelector<HTMLElement>("#dash-content");
  if (content) void dashboardView(first, content);
}
