// Order ticket (spec 7.3): the SDK builds the order through the API, checks every field of the payload against this
// ticket and recomputes the digest; only then is "Sign and send" offered. The preview shown is the SDK-checked build
// and the digest is the SDK's own. Venues without a builder approval (fee_free_unavailable) get no ticket.
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ConnectLink } from "../nav";
import { VerifyLink } from "../../components/VerifyLink";
import type { CheckedBuild, OrderIntent, VenueId } from "../../lib/capstan";
import { useSession } from "../session";
import { EXECUTION_VENUES, FEE_FREE_UNAVAILABLE, venueName } from "../venues";

export function OrderTicket() {
  const s = useSession();
  const active = EXECUTION_VENUES.filter((v) => s.venues[v]?.status === "active");
  const feeFree = EXECUTION_VENUES.filter((v) => s.venues[v]?.status === "fee_free_unavailable");
  const [venue, setVenue] = useState<VenueId | "">(active[0] ?? "");
  const [marketId, setMarketId] = useState("hyperliquid:-:BTC");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [size, setSize] = useState("0.001");
  const [type, setType] = useState<"market" | "limit">("market");
  const [limitPx, setLimitPx] = useState("");
  const [leverage, setLeverage] = useState("3");
  const [slip, setSlip] = useState("50");
  const [mode, setMode] = useState<"relay" | "direct">("relay");
  const [checked, setChecked] = useState<CheckedBuild | null>(null);
  const [result, setResult] = useState<{ status: string; receiptId: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = (venue || active[0] || "") as VenueId | "";

  async function preview(e: FormEvent) {
    e.preventDefault();
    if (!s.client || !chosen) return;
    setError(null);
    setChecked(null);
    setResult(null);
    setBusy(true);
    const intent: OrderIntent = { marketId, side, size, type, ...(type === "limit" ? { limitPx } : {}), tif: type === "market" ? "ioc" : "gtc", reduceOnly: false, leverage: Number(leverage), maxSlippageBps: Number(slip) };
    try {
      setChecked(await s.client.buildOrder(intent, chosen, mode));
    } catch (err) {
      setError(`The SDK did not accept this build: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!s.client || !checked) return;
    setBusy(true);
    setError(null);
    try {
      const r = await s.client.signAndSubmit(checked);
      setResult({ status: r.order.status, receiptId: r.receiptId });
      // a null receipt id: the order went out and its receipt is still being issued (security r1 R1-07)
      if (r.receiptId) s.addReceipt({ receiptId: r.receiptId, what: `Order ${checked.build.preview.side} ${checked.build.preview.size} ${checked.build.preview.marketId}`, venue: checked.venue });
      setChecked(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!s.client) {
    return (
      <section aria-labelledby="ticket-title">
        <h2 id="ticket-title">Order ticket</h2>
        <p>
          <ConnectLink /> to use this screen.
        </p>
      </section>
    );
  }

  const p = checked?.build.preview;
  return (
    <section aria-labelledby="ticket-title" data-screen="order">
      <h2 id="ticket-title">Order ticket</h2>
      {feeFree.map((v) => (
        <p key={v} className="callout" data-fee-free={v}>
          {FEE_FREE_UNAVAILABLE(v)}
        </p>
      ))}
      {active.length === 0 ? (
        <p data-no-ticket="">
          No venue is ready for orders. <Link to="/app/onboard/hyperliquid">Onboard a venue</Link> to get a ticket.
        </p>
      ) : (
        <form className="stack" onSubmit={preview} data-ticket="">
          <label>
            Venue{" "}
            <select value={chosen} onChange={(e) => setVenue(e.target.value as VenueId)}>
              {active.map((v) => (
                <option key={v} value={v}>
                  {venueName(v)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Market <input value={marketId} onChange={(e) => setMarketId(e.target.value)} />
          </label>
          <div className="row">
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
          </div>
          <div className="row">
            <label>
              Type{" "}
              <select value={type} onChange={(e) => setType(e.target.value as "market" | "limit")}>
                <option value="market">market</option>
                <option value="limit">limit</option>
              </select>
            </label>
            {type === "limit" ? (
              <label>
                Limit price <input value={limitPx} onChange={(e) => setLimitPx(e.target.value)} inputMode="decimal" size={10} />
              </label>
            ) : null}
            <label>
              Max slippage (bps) <input value={slip} onChange={(e) => setSlip(e.target.value)} inputMode="numeric" size={5} />
            </label>
            <label>
              Mode{" "}
              <select value={mode} onChange={(e) => setMode(e.target.value as "relay" | "direct")}>
                <option value="relay">relay</option>
                <option value="direct">direct</option>
              </select>
            </label>
          </div>
          <p>
            <button type="submit" className="button" disabled={busy}>
              Check the order
            </button>
          </p>
        </form>
      )}
      {checked && p ? (
        <div className="card" data-order-preview="">
          <h3>SDK check passed</h3>
          <p>Every field of the venue payload matches this ticket, the builder fee is within your approval, and the SDK computed the digest itself.</p>
          <dl className="checks">
            <div>
              <dt>Market</dt>
              <dd className="mono">{p.marketId}</dd>
            </div>
            <div>
              <dt>Side and size</dt>
              <dd>
                {p.side} {p.size}
              </dd>
            </div>
            <div>
              <dt>Price limit</dt>
              <dd>{p.px ?? "none"}</dd>
            </div>
            <div>
              <dt>Notional</dt>
              <dd>{p.notionalUsd} USD</dd>
            </div>
            <div>
              <dt>Venue fee</dt>
              <dd>{p.venueFeeBps} bps</dd>
            </div>
            <div>
              <dt>Builder fee</dt>
              <dd>{p.builderFeeBps} bps</dd>
            </div>
            <div>
              <dt>Slippage</dt>
              <dd>{p.slippageBps} bps</dd>
            </div>
            <div>
              <dt>Est. liquidation price</dt>
              <dd>{p.estLiqPx ?? "unknown"}</dd>
            </div>
            <div>
              <dt>SDK digest</dt>
              <dd className="mono break">{checked.digest}</dd>
            </div>
            <div>
              <dt>Valid until</dt>
              <dd>{new Date(checked.build.expiresAt).toISOString()}</dd>
            </div>
          </dl>
          {p.warnings.length ? (
            <ul>
              {p.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          <p className="row">
            <button type="button" className="button" onClick={() => void send()} disabled={busy}>
              Sign and send
            </button>
            <button type="button" className="button button-secondary" onClick={() => setChecked(null)}>
              Discard
            </button>
          </p>
        </div>
      ) : null}
      {result ? (
        <p className="ok" data-order-result="">
          Order {result.status}.{" "}
          {result.receiptId ? (
            <>
              Receipt <VerifyLink id={result.receiptId}>{result.receiptId}</VerifyLink>
            </>
          ) : (
            "The order was sent. Its receipt is still being issued; it appears in your receipts list shortly. Do not send the order again."
          )}
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
