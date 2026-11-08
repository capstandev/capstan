// Live wiring for the owner's marketing pages. The owner's markup stays; where it showed placeholder values (the
// "01 02 03" rows of each feature page's detail sheet, the fixed 2 bps in the pricing calculator) the real API value
// goes in, and each feature page gets one live section in the owner's classes, inserted before the closing panel.
import type { AppConfig } from "../config";
import { assetsOf, builderFeeBps, builderFeeUsd, createReader, fmtBps, fmtClock, fmtInterval, fmtPrice, fmtRatePct, fmtSize, fmtUntil, listMarkets, readBook, readFunding, readLive, readQuote, readVenues, bookStats, assetLabel, escapeHtml as h, type LiveState, type Reader } from "./data";
import { bookHtml, fundingTableHtml, quoteCardsHtml, stateHtml } from "./render";
import type { FundingRowLike, Market, OrderBook, RouteQuote } from "./types";
import { venueName } from "../app/venues";

const now = (cfg: AppConfig) => (cfg.now ?? Date.now)();

/** Inserts a live section before the page's closing panel (or at the end of main) and returns its body element. */
export function liveSection(id: string, title: string, intro: string): HTMLElement | null {
  const main = document.querySelector("main.bl-page");
  if (!main) return null;
  const sec = document.createElement("section");
  sec.className = "bl-section cap-live-section";
  sec.dataset.live = id;
  sec.innerHTML = `<div class="bl-wrap"><div class="bl-heading"><h2>${h(title)}</h2><p>${h(intro)}</p></div><div class="dash-panel cap-live-panel" data-live-body=""></div></div>`;
  const end = main.querySelector("section.bl-end");
  main.insertBefore(sec, end ?? null);
  return sec.querySelector<HTMLElement>("[data-live-body]");
}

/**
 * Fills the owner's detail sheet ("PLANNED VIEW", three rows) with live values for the selected tab, and again
 * every time the owner's tab handler re-renders it. `values(i)` gives the three values for tab i (null keeps the
 * owner's placeholder while loading).
 */
export function fillDetailSheet(values: (tab: number) => (string | null)[] | null): () => void {
  const host = document.querySelector<HTMLElement>("#bl-detail-visual");
  const pane = document.querySelector<HTMLElement>("#bl-detail-pane");
  if (!host || !pane) return () => {};
  const apply = () => {
    const v = values(Number(pane.dataset.detailState ?? 0));
    if (!v) return;
    host.querySelectorAll<HTMLElement>(".bl-detail-sheet > div > b").forEach((b, i) => {
      const x = v[i];
      if (x !== null && x !== undefined && b.textContent !== x) {
        b.textContent = x;
        b.dataset.liveValue = "";
      }
    });
  };
  const mo = new MutationObserver(apply);
  mo.observe(host, { childList: true, subtree: false });
  apply();
  return apply;
}

// ---- markets.html ------------------------------------------------------------------------------------------------

interface MarketsData {
  markets: Market[];
  asset: string;
  funding: FundingRowLike[];
  book: OrderBook | null;
}

export async function loadMarketsData(r: Reader, asset: string | null): Promise<MarketsData> {
  const markets = await listMarkets(r);
  const assets = assetsOf(markets);
  const a = asset && assets.includes(asset) ? asset : (assets[0] ?? "CR:BTC");
  const { rows } = await readFunding(r, a);
  const first = markets.find((m) => m.canonicalAsset === a && m.marketType === "perp" && m.executable) ?? markets.find((m) => m.canonicalAsset === a);
  const book = first ? await readBook(r, first.id, 10).catch(() => null) : null;
  return { markets, asset: a, funding: rows, book };
}

/** The five markets tabs: canonical markets, order books, mark prices, annualised funding, settlement times. */
export function marketsDetailValues(d: MarketsData, tab: number, nowMs: number): string[] {
  const m = d.markets.find((x) => x.id === d.book?.marketId) ?? d.markets.find((x) => x.canonicalAsset === d.asset);
  const s = d.book ? bookStats(d.book) : null;
  const f = d.funding.find((x) => x.status === "ok" && x.marketId === m?.id) ?? d.funding.find((x) => x.status === "ok");
  switch (tab) {
    case 0:
      return [assetLabel(d.asset), m?.collateralAsset ?? "n/a", m?.venueSymbol ?? "n/a"];
    case 1:
      return [fmtPrice(s?.bestBid), fmtPrice(s?.bestAsk), s ? `${fmtSize(s.bidDepth)} / ${fmtSize(s.askDepth)}` : "n/a"];
    case 2:
      return [s?.mid ? `${fmtPrice(s.mid)} (book mid)` : "n/a", m ? venueName(m.venue) : "n/a", d.book ? fmtClock(d.book.asOf) : "n/a"];
    case 3:
      return [fmtRatePct(f?.ratePerInterval), fmtRatePct(f?.rateAnnualised, 2), fmtInterval(f?.intervalS)];
    default:
      return [f ? venueName(f.venue) : "n/a", fmtClock(f?.nextSettlementAt), fmtUntil(f?.nextSettlementAt, nowMs)];
  }
}

export function marketsPanelHtml(d: MarketsData, nowMs: number): string {
  const chips = assetsOf(d.markets)
    .slice(0, 12)
    .map((a) => `<button type="button" class="cap-chip${a === d.asset ? " active" : ""}" aria-pressed="${a === d.asset}" data-asset-chip="${h(a)}">${h(assetLabel(a))}</button>`)
    .join("");
  const funding = d.funding.length ? fundingTableHtml(d.funding, nowMs) : `<p class="cap-state" data-live-state="empty">No venue lists ${h(assetLabel(d.asset))} yet.</p>`;
  return `<div class="panel-head"><h3>Funding by venue: ${h(assetLabel(d.asset))}</h3></div><div class="cap-chips" role="group" aria-label="Asset">${chips}</div>${funding}<div data-book-slot="">${d.book ? bookHtml(d.book, nowMs) : ""}</div><p class="bl-fine">Funding is the latest rate each venue published; the annualised figure is that rate times the hours in a year, for comparison only.</p>`;
}

export async function wireMarketsPage(cfg: AppConfig, r: Reader = createReader({ apiBase: cfg.apiBase, ...(cfg.fetch ? { fetch: cfg.fetch } : {}) })) {
  const body = liveSection("markets", "Live markets", "Read from the Capstan API: funding per venue and the order book of each market.");
  let data: MarketsData | null = null;
  const refill = fillDetailSheet((tab) => (data ? marketsDetailValues(data, tab, now(cfg)) : null));
  async function load(asset: string | null) {
    if (body) body.innerHTML = stateHtml({ kind: "loading" }) ?? "";
    const s: LiveState<MarketsData> = await readLive(() => loadMarketsData(r, asset), { isEmpty: (d) => d.markets.length === 0 });
    if (s.kind === "ok") data = s.data;
    if (body) body.innerHTML = s.kind === "ok" ? marketsPanelHtml(s.data, now(cfg)) : (stateHtml(s, "The API lists no markets yet.") ?? "");
    refill();
  }
  body?.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const chip = t.closest<HTMLElement>("[data-asset-chip]");
    if (chip) return void load(chip.dataset.assetChip ?? null);
    const b = t.closest<HTMLElement>("[data-book]");
    if (b && b.dataset.book) {
      const slot = body.querySelector<HTMLElement>("[data-book-slot]");
      if (!slot) return;
      slot.innerHTML = stateHtml({ kind: "loading" }) ?? "";
      const s = await readLive(() => readBook(r, b.dataset.book as string, 10), { isEmpty: (x) => !x || (x.bids.length === 0 && x.asks.length === 0) });
      if (s.kind === "ok" && data) data = { ...data, book: s.data };
      slot.innerHTML = s.kind === "ok" ? bookHtml(s.data, now(cfg)) : (stateHtml(s, "This market's book is empty right now.") ?? "");
      refill();
    }
  });
  await load(null);
  const loaded = data as MarketsData | null; // set inside load()
  if (loaded) await fillMarketsChart(r, loaded.markets);
}

/** Up to `n` venue markets with an observed funding rate, across the first listed assets. */
export async function fundingSample(r: Reader, markets: Market[], n = 14): Promise<{ label: string; annualised: number }[]> {
  const out: { label: string; annualised: number }[] = [];
  for (const a of assetsOf(markets).slice(0, 6)) {
    if (out.length >= n) break;
    const f = await readFunding(r, a).catch(() => null);
    for (const row of f?.rows ?? []) if (row.status === "ok" && row.rateAnnualised !== null && out.length < n) out.push({ label: `${assetLabel(a)} ${venueName(row.venue)}`, annualised: Number(row.rateAnnualised) });
  }
  return out;
}

/** The owner's "Illustrative market comparison" card: its bars take observed annualised funding per venue market. */
export async function fillMarketsChart(r: Reader, markets: Market[]) {
  const bars = [...document.querySelectorAll<HTMLElement>(".cap-chart-bars i")];
  if (!bars.length) return;
  const f = await fundingSample(r, markets, bars.length);
  if (!f.length) return;
  const max = Math.max(...f.map((x) => Math.abs(x.annualised)), 1e-12);
  bars.forEach((b, i) => {
    const x = f[i % f.length]!;
    const pct = `${Math.max(8, Math.round((Math.abs(x.annualised) / max) * 92))}%`;
    b.style.setProperty("--h", pct);
    b.style.setProperty("--alt", pct);
    b.title = `${x.label}: ${fmtRatePct(x.annualised, 2)} observed, annualised`;
    b.dataset.liveValue = "";
  });
  const small = document.querySelector<HTMLElement>(".cap-chart-overlay small");
  if (small) small.textContent = `Observed funding, annualised, ${Math.min(f.length, bars.length)} venue markets`;
}

// ---- quotes.html -------------------------------------------------------------------------------------------------

export const DEFAULT_QUOTE = { canonicalAsset: "CR:BTC", side: "buy" as const, sizeBase: "0.01", leverage: 3, holdHours: 24 };

/** The five quotes tabs: venue fees, builder fee, book slippage, funding cost, liquidation estimate. */
export function quotesDetailValues(q: RouteQuote, tab: number, venues: { venue: string; builderFee: unknown }[] = []): string[] {
  const leg = q.legs.find((l) => l.marketId === q.best && l.status === "ok") ?? q.legs.find((l) => l.status === "ok") ?? q.legs[0];
  if (!leg) return ["n/a", "n/a", "n/a"];
  switch (tab) {
    case 0:
      return [venueName(leg.venue), "venue schedule", fmtBps(leg.venueFeeBps)];
    case 1:
      return [venueName(leg.venue), venues.some((v) => v.venue === leg.venue && v.builderFee) ? "approved once per venue" : "no builder fee", fmtBps(leg.builderFeeBps)];
    case 2:
      return [`${DEFAULT_QUOTE.sizeBase} ${assetLabel(DEFAULT_QUOTE.canonicalAsset)}`, venueName(leg.venue), fmtBps(leg.slippageBps)];
    case 3:
      return [fmtBps(DEFAULT_QUOTE.holdHours > 0 ? leg.fundingCostBps / DEFAULT_QUOTE.holdHours : 0) + " per hour", `${DEFAULT_QUOTE.holdHours} hours`, fmtBps(leg.fundingCostBps)];
    default:
      return [leg.collateralAsset, `${DEFAULT_QUOTE.sizeBase} ${assetLabel(DEFAULT_QUOTE.canonicalAsset)} at ${DEFAULT_QUOTE.leverage}x`, leg.estLiqPx ? fmtPrice(leg.estLiqPx) : "unknown"];
  }
}

export async function wireQuotesPage(cfg: AppConfig, mountWidget: (el: HTMLElement) => void, r: Reader = createReader({ apiBase: cfg.apiBase, ...(cfg.fetch ? { fetch: cfg.fetch } : {}) })) {
  const body = liveSection("quotes", "Live quote", "Ask the Capstan API for a quote. Every cost is shown on its own line for each venue, before anything is signed.");
  let q: RouteQuote | null = null;
  let venues: { venue: string; builderFee: unknown }[] = [];
  const refill = fillDetailSheet((tab) => (q ? quotesDetailValues(q, tab, venues) : null));
  if (body) {
    body.innerHTML = `<div data-quote-sample=""></div><div data-quote-widget=""></div>`;
    const sample = body.querySelector<HTMLElement>("[data-quote-sample]");
    const widget = body.querySelector<HTMLElement>("[data-quote-widget]");
    if (widget) mountWidget(widget);
    if (sample) sample.innerHTML = stateHtml({ kind: "loading" }) ?? "";
    const [s, v] = await Promise.all([readLive(() => readQuote(r, DEFAULT_QUOTE), { isEmpty: (x) => !x?.legs?.length }), readVenues(r).catch(() => [])]);
    venues = v;
    if (s.kind === "ok") q = s.data;
    if (sample) sample.innerHTML = s.kind === "ok" ? `<div class="panel-head"><h3>Sample: buy ${h(DEFAULT_QUOTE.sizeBase)} ${h(assetLabel(DEFAULT_QUOTE.canonicalAsset))} at ${DEFAULT_QUOTE.leverage}x, held ${DEFAULT_QUOTE.holdHours} hours</h3></div>${quoteCardsHtml(s.data, DEFAULT_QUOTE.holdHours)}` : (stateHtml(s, "No venue quoted this market.") ?? "");
    refill();
  }
}

// ---- risk.html ---------------------------------------------------------------------------------------------------

export interface RiskSummary {
  venue: string;
  position: string;
  direction: string;
  collateral: string;
  marginUsed: string;
  marginRatio: string;
  liq: string;
  exposure: string;
  receipt: string;
}

/** The five risk tabs: venue positions, margin ratios, liquidation levels, asset exposure, signed receipts. */
export function riskDetailValues(s: RiskSummary | null, tab: number): string[] {
  if (!s) {
    const c = "connect a wallet";
    return tab === 4 ? ["each routed order", "signed by Capstan", "check it on the verify page"] : [c, c, c];
  }
  switch (tab) {
    case 0:
      return [s.venue, s.position, s.direction];
    case 1:
      return [s.collateral, s.marginUsed, s.marginRatio];
    case 2:
      return [s.venue, s.position, s.liq];
    case 3:
      return [s.position, s.exposure, s.venue];
    default:
      return ["each routed order", "signed by Capstan", s.receipt];
  }
}

export function wireRiskPage(mountWidget: (el: HTMLElement, onRisk: (s: RiskSummary | null) => void) => void) {
  const body = liveSection("risk", "Your risk, venue by venue", "Connect your wallet to read each venue account on its own. The wallet signs a read request; nothing is sent to a venue.");
  let summary: RiskSummary | null = null;
  const refill = fillDetailSheet((tab) => riskDetailValues(summary, tab));
  if (body) {
    body.innerHTML = `<div data-risk-widget=""></div><p class="cap-row"><a class="dash-button" href="verify.html">Verify a receipt ↗</a><a href="dashboard.html">Open the dashboard to onboard and trade ↗</a></p>`;
    const w = body.querySelector<HTMLElement>("[data-risk-widget]");
    if (w)
      mountWidget(w, (s) => {
        summary = s;
        refill();
      });
  }
}

// ---- pricing.html ------------------------------------------------------------------------------------------------

/** The builder fee calculator: the owner's slider and output, at the fee the API reports for Hyperliquid. */
export async function wirePricingPage(cfg: AppConfig, r: Reader = createReader({ apiBase: cfg.apiBase, ...(cfg.fetch ? { fetch: cfg.fetch } : {}) })) {
  const input = document.querySelector<HTMLInputElement>("#notional");
  const out = document.querySelector<HTMLElement>("#fee-result");
  if (!input || !out) return;
  const s = await readLive(() => readVenues(r), { isEmpty: (v) => v.length === 0 });
  const bps = s.kind === "ok" ? builderFeeBps(s.data, "hyperliquid") : null;
  if (bps === null) return; // the owner's illustrative 2 bps stays when the API cannot be read
  const update = () => {
    out.textContent = `$${builderFeeUsd(Number(input.value), bps).toFixed(2)}`;
    out.dataset.liveValue = String(bps);
  };
  input.addEventListener("input", update);
  update();
}
