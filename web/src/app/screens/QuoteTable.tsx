// Quote widget (spec 13.1 POST /quote): one row per venue market with venue fee, builder fee, slippage, funding per
// hour, estimated liquidation price, collateral and status in separate columns. Data-only venues are greyed and
// labelled "data only" and are never marked best, whatever the server's `best` says.
import { useState, type FormEvent } from "react";
import { Disclaimer } from "../../components/Disclaimer";
import type { QuoteRequest, RouteQuote, VenueQuote } from "../../lib/capstan";
import { useSession } from "../session";
import { venueName } from "../venues";

export const QUOTE_COLUMNS = ["Venue", "Market", "Venue fee", "Builder fee", "Slippage", "Funding per hour", "Est. liquidation price", "Collateral", "Status"] as const;

const bps = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)} bps`;

/** The row the table marks best: the server's pick, only when it is an executable ("ok") row. */
export function bestOf(q: RouteQuote): string | null {
  const leg = q.legs.find((l) => l.marketId === q.best);
  return leg && leg.status === "ok" ? leg.marketId : null;
}

export function statusText(l: VenueQuote): string {
  if (l.status === "data_only") return "data only";
  if (l.status === "refused") return `refused: ${l.refusal?.reason ?? l.refusal?.code ?? "not eligible"}`;
  if (l.status === "insufficient_depth") return "not enough depth";
  return "ok";
}

export function QuoteRows({ quote, holdHours }: { quote: RouteQuote; holdHours: number }) {
  const best = bestOf(quote);
  return (
    <div className="table-wrap" role="region" aria-label="Quote per venue" tabIndex={0}>
      <table data-quote-table="">
        <caption className="visually-hidden">Quote per venue</caption>
        <thead>
          <tr>
            {QUOTE_COLUMNS.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {quote.legs.map((l) => {
            const dataOnly = l.status === "data_only";
            const perHour = holdHours > 0 ? l.fundingCostBps / holdHours : 0;
            return (
              <tr key={l.marketId} className={dataOnly ? "data-only" : undefined} data-market={l.marketId} data-best={best === l.marketId ? "true" : undefined}>
                <td>
                  {venueName(l.venue)}
                  {best === l.marketId ? <strong> (best)</strong> : null}
                </td>
                <td className="mono">{l.marketId}</td>
                <td data-col="venue-fee">{dataOnly ? "n/a" : bps(l.venueFeeBps)}</td>
                <td data-col="builder-fee">{dataOnly ? "n/a" : bps(l.builderFeeBps)}</td>
                <td data-col="slippage">{bps(l.slippageBps)}</td>
                <td data-col="funding">{bps(perHour)}</td>
                <td data-col="liq">{l.estLiqPx ?? "unknown"}</td>
                <td data-col="collateral">{l.collateralAsset}</td>
                <td data-col="status">{statusText(l)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function QuoteTable({ initial }: { initial?: { quote: RouteQuote; holdHours: number } }) {
  const s = useSession();
  const [asset, setAsset] = useState("CR:BTC");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [size, setSize] = useState("0.01");
  const [leverage, setLeverage] = useState("3");
  const [hold, setHold] = useState("24");
  const [quote, setQuote] = useState<{ quote: RouteQuote; holdHours: number } | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const req: QuoteRequest = { canonicalAsset: asset as QuoteRequest["canonicalAsset"], side, sizeBase: size, leverage: Number(leverage), holdHours: Number(hold), orderType: "market", ...(s.connected ? { owner: s.connected.owner } : {}) };
    try {
      const q = s.client ? await s.client.quote(req) : await s.api.post<RouteQuote>("/quote", req);
      setQuote({ quote: q, holdHours: req.holdHours });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section aria-labelledby="quote-title" data-screen="quote">
      <h2 id="quote-title">Quote</h2>
      <form className="row" onSubmit={onSubmit}>
        <label>
          Asset <input value={asset} onChange={(e) => setAsset(e.target.value)} size={10} />
        </label>
        <label>
          Side{" "}
          <select value={side} onChange={(e) => setSide(e.target.value as "buy" | "sell")}>
            <option value="buy">buy</option>
            <option value="sell">sell</option>
          </select>
        </label>
        <label>
          Size <input value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal" size={8} />
        </label>
        <label>
          Leverage <input value={leverage} onChange={(e) => setLeverage(e.target.value)} inputMode="numeric" size={4} />
        </label>
        <label>
          Hold hours <input value={hold} onChange={(e) => setHold(e.target.value)} inputMode="numeric" size={4} />
        </label>
        <button type="submit" className="button">
          Get quote
        </button>
      </form>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {quote ? <QuoteRows quote={quote.quote} holdHours={quote.holdHours} /> : null}
      <Disclaimer compact />
    </section>
  );
}
