// Risk panel (spec 5, 13.1 GET /risk): one card per venue, each with its own equity, positions and liquidation
// prices, under the fixed banner. Nothing is added up across venues: there is no total margin or collateral figure.
import { useState } from "react";
import { ConnectLink } from "../nav";
import { RISK_BANNER, type RiskView } from "../../lib/capstan";
import { useSession } from "../session";
import { venueName } from "../venues";

export function RiskCards({ view }: { view: RiskView }) {
  return (
    <div data-risk-view="">
      <p className="banner" data-risk-banner="">
        {RISK_BANNER}
      </p>
      {view.perVenue.length === 0 ? <p>No open venue accounts were read.</p> : null}
      <div className="cards">
        {view.perVenue.map((a) => {
          const ladder = view.liquidationLadder.filter((l) => l.venue === a.venue);
          return (
            <article className="card" key={`${a.venue}:${JSON.stringify(a.identity)}`} data-venue-card={a.venue}>
              <h3>{venueName(a.venue)}</h3>
              <dl className="checks">
                <div>
                  <dt>Equity on this venue</dt>
                  <dd>{a.equityUsd} USD</dd>
                </div>
                <div>
                  <dt>Free collateral on this venue</dt>
                  <dd>{a.freeCollateralUsd} USD</dd>
                </div>
                <div>
                  <dt>As of</dt>
                  <dd>{a.asOf}</dd>
                </div>
              </dl>
              {a.positions.length ? (
                <ul>
                  {a.positions.map((p) => (
                    <li key={p.marketId} data-position={p.marketId}>
                      <span className="mono">{p.marketId}</span>: {p.side} {p.size} at {p.entryPx}, mark {p.markPx}, liquidation price <strong data-liq="">{p.liqPx ?? "none"}</strong>
                      {p.liqPxSource === "computed" ? " (computed)" : ""}
                      {p.marginRatio ? `, margin ratio ${p.marginRatio}` : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No open positions.</p>
              )}
              {ladder.length ? (
                <p>
                  Distance to liquidation:{" "}
                  {ladder.map((l) => `${l.marketId} ${l.distancePct === null ? "n/a" : `${l.distancePct}%`}`).join("; ")}
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function RiskPanel({ initial, onLoaded }: { initial?: RiskView; onLoaded?: (v: RiskView) => void }) {
  const s = useSession();
  const [view, setView] = useState<RiskView | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const owner = s.connected?.owner;

  async function load() {
    if (!owner) return;
    setError(null);
    try {
      const v = await s.api.readGet<RiskView>(`/risk?owner=${owner}`);
      setView(v);
      onLoaded?.(v);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section aria-labelledby="risk-title" data-screen="risk">
      <h2 id="risk-title">Risk</h2>
      {!owner && !view ? (
        <p>
          <ConnectLink /> to read your venue accounts.
        </p>
      ) : (
        <p>
          <button type="button" className="button" onClick={() => void load()} disabled={!owner}>
            Read my venue accounts (signs a read request)
          </button>
        </p>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {view ? <RiskCards view={view} /> : null}
    </section>
  );
}
