// HTML for the live views, in the owner's own classes (dash-panel, panel-head, market-row, row-status, bl-receipt) so
// live values sit inside the supplied design. Every value from the API is escaped. The words here are labels and
// state lines only; the owner's copy stays in the owner's files.
import { assetLabel, bookStats, escapeHtml as h, fmtAge, fmtBps, fmtClock, fmtInterval, fmtPrice, fmtRatePct, fmtSize, fmtUntil, type LiveState } from "./data";
import type { FundingRowLike, Market, OrderBook, RouteQuote } from "./types";
import { venueName } from "../app/venues";
import { DISCLAIMER } from "../copy";

export const STATE_TEXT = {
  loading: "Reading the Capstan API.",
  offline: "You are offline. Live values come back when the connection does.",
  empty: "Nothing to show yet.",
  error: (m: string) => `The Capstan API could not be read: ${m}`,
};

/** The line shown for a state that is not "ok" (null when it is). */
export function stateHtml<T>(s: LiveState<T>, empty: string = STATE_TEXT.empty): string | null {
  if (s.kind === "ok") return null;
  const text = s.kind === "loading" ? STATE_TEXT.loading : s.kind === "offline" ? STATE_TEXT.offline : s.kind === "empty" ? empty : STATE_TEXT.error(s.message);
  const role = s.kind === "error" || s.kind === "offline" ? "alert" : "status";
  return `<p class="cap-state cap-state-${s.kind}" role="${role}" data-live-state="${s.kind}">${h(text)}</p>`;
}

const NAMES: Record<string, [glyph: string, name: string, cls: string]> = {
  BTC: ["₿", "Bitcoin", "btc"],
  ETH: ["♦", "Ethereum", "eth"],
  SOL: ["≋", "Solana", "sol"],
};

export function assetName(asset: string): { glyph: string; name: string; cls: string; label: string } {
  const label = assetLabel(asset);
  const n = NAMES[label];
  return n ? { glyph: n[0], name: n[1], cls: n[2], label } : { glyph: label.slice(0, 1), name: label, cls: "btc", label };
}

/** One owner-style market row per canonical asset. `status` is the right-hand value (a price or a venue count). */
export function marketRowHtml(asset: string, small: string, status: string, o: { button?: boolean } = {}): string {
  const a = assetName(asset);
  const inner = `<span class="coin ${a.cls}">${h(a.glyph)}</span><div><b>${h(a.name)}</b><small>${h(small)}</small></div><span class="row-status" data-live-value="">${h(status)}</span>`;
  const search = `${a.name.toLowerCase()} ${a.label.toLowerCase()}`;
  return o.button
    ? `<button type="button" class="market-row cap-market-button" data-market="${h(search)}" data-asset="${h(asset)}">${inner}</button>`
    : `<div class="market-row" data-market="${h(search)}" data-asset="${h(asset)}">${inner}</div>`;
}

export function venueCount(markets: Market[], asset: string): number {
  return new Set(markets.filter((m) => m.canonicalAsset === asset && m.marketType === "perp").map((m) => m.venue)).size;
}

export function fundingTableHtml(rows: FundingRowLike[], nowMs: number): string {
  const body = rows
    .map(
      (r) => `<tr data-funding-row="${h(r.marketId)}"${r.executable ? "" : ' class="cap-data-only"'}><td data-label="Venue">${h(venueName(r.venue))}${r.executable ? "" : " <small>(data only)</small>"}</td><td data-label="Market" class="cap-mono">${h(r.marketId)}</td><td data-label="Funding per interval" data-col="rate">${r.status === "ok" ? h(fmtRatePct(r.ratePerInterval)) : "unavailable"}</td><td data-label="Observed, annualised" data-col="annualised">${r.status === "ok" ? h(fmtRatePct(r.rateAnnualised, 2)) : "n/a"}</td><td data-label="Interval">${h(fmtInterval(r.intervalS))}</td><td data-label="Next settlement">${r.nextSettlementAt ? `${h(fmtClock(r.nextSettlementAt))} <small>(${h(fmtUntil(r.nextSettlementAt, nowMs))})</small>` : "n/a"}</td><td><button type="button" class="cap-link-button" data-book="${h(r.marketId)}">Order book</button></td></tr>`,
    )
    .join("");
  return `<div class="cap-table-wrap" role="region" aria-label="Funding per venue" tabindex="0"><table class="cap-table" data-funding-table=""><thead><tr><th scope="col">Venue</th><th scope="col">Market</th><th scope="col">Funding per interval</th><th scope="col">Observed, annualised</th><th scope="col">Interval</th><th scope="col">Next settlement</th><th scope="col"><span class="cap-visually-hidden">Book</span></th></tr></thead><tbody>${body}</tbody></table></div>`;
}

export function bookHtml(b: OrderBook, nowMs: number, levels = 5): string {
  const s = bookStats(b);
  const side = (rows: [string, string][], cls: string) => rows.slice(0, levels).map(([px, sz]) => `<div class="${cls}"><span>${h(fmtPrice(px))}</span><b>${h(fmtSize(Number(sz)))}</b></div>`).join("") || `<div class="${cls}"><span>none</span><b></b></div>`;
  return `<div class="cap-book" data-book-for="${h(b.marketId)}"><div class="panel-head"><h3>Order book <small class="cap-mono">${h(b.marketId)}</small></h3><small class="cap-age">read ${h(fmtAge(b.asOf, nowMs))}</small></div><dl class="cap-facts"><div><dt>Best bid</dt><dd data-book-bid="">${h(fmtPrice(s.bestBid))}</dd></div><div><dt>Best ask</dt><dd data-book-ask="">${h(fmtPrice(s.bestAsk))}</dd></div><div><dt>Mid</dt><dd data-book-mid="">${h(fmtPrice(s.mid))}</dd></div><div><dt>Spread</dt><dd>${h(fmtBps(s.spreadBps))}</dd></div></dl><div class="cap-book-sides"><div><small>BIDS</small>${side(b.bids, "cap-bid")}</div><div><small>ASKS</small>${side(b.asks, "cap-ask")}</div></div></div>`;
}

/** The quote breakdown: one card per venue market, each cost on its own line, never a total across venues. */
export function quoteCardsHtml(q: RouteQuote, holdHours: number): string {
  const cards = q.legs
    .map((l) => {
      const dataOnly = l.status === "data_only";
      const perHour = holdHours > 0 ? l.fundingCostBps / holdHours : 0;
      const status = l.status === "ok" ? "can execute" : l.status === "data_only" ? "data only" : l.status === "insufficient_depth" ? "not enough depth" : `refused: ${l.refusal?.reason ?? l.refusal?.code ?? "not eligible"}`;
      return `<article class="bl-receipt cap-quote-card" data-quote-leg="${h(l.marketId)}"><h3>${h(venueName(l.venue))} <small class="cap-mono">${h(l.marketId)}</small></h3><div><span>Venue fee</span><b data-col="venue-fee">${dataOnly ? "n/a" : h(fmtBps(l.venueFeeBps))}</b></div><div><span>Capstan builder fee</span><b data-col="builder-fee">${dataOnly ? "n/a" : h(fmtBps(l.builderFeeBps))}</b></div><div><span>Estimated slippage</span><b data-col="slippage">${h(fmtBps(l.slippageBps))}</b></div><div><span>Funding per hour</span><b data-col="funding">${h(fmtBps(perHour))}</b></div><div><span>Liquidation estimate</span><b data-col="liq">${h(l.estLiqPx ? fmtPrice(l.estLiqPx) : "unknown")}</b></div><small>${h(status)} · collateral ${h(l.collateralAsset)}</small></article>`;
    })
    .join("");
  return `<div class="cap-quote-cards" data-quote-cards="">${cards}</div>`;
}

export function disclaimerHtml(): string {
  return `<aside class="cap-disclaimer" aria-label="${h(DISCLAIMER.title)}" data-disclaimer=""><b>${h(DISCLAIMER.title)}:</b> ${h(DISCLAIMER.lines.join(" "))}</aside>`;
}

export function tokenBoxHtml(e: { address: string; symbol: string }, explorerBase: string, title: string): string {
  const href = `${explorerBase.replace(/\/$/, "")}/token/${e.address}`;
  return `<section class="bl-section cap-token-section" data-token-box=""><div class="bl-wrap"><div class="bl-receipt cap-token-box"><h3>${h(title)}</h3><p class="cap-mono cap-break" data-token-address="">${h(e.address)}</p><p class="cap-row"><button type="button" class="dash-button" data-copy="${h(e.address)}">Copy the token address</button><a href="${h(href)}" rel="noreferrer noopener" target="_blank">View on the explorer ↗</a></p></div></div></section>`;
}
