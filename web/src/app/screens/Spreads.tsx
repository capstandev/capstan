// Spread planner (spec 7.5): scan results, the plan, the risk label next to every hedge word, an explicit ack checkbox
// and the main wallet's signature of the exact ack text. "Execute" stays off until both are done and the server
// answered acked. Execution runs here (where the keys are) through the SDK; each step goes to the log.
import { useState, type FormEvent, type ReactNode } from "react";
import { ConnectLink } from "../nav";
import { Disclaimer } from "../../components/Disclaimer";
import { SPREAD_ACK_TEXT, SPREAD_RISK_LABEL, spreadAckMessage, type ExecutorEvent, type SpreadPlan } from "../../lib/capstan";
import { useSession } from "../session";
import { venueName } from "../venues";

/** Every mention of hedging carries the label right next to it. */
export function Hedge({ children }: { children: ReactNode }) {
  return (
    <span data-hedge="">
      {children} <strong className="risk-label">{SPREAD_RISK_LABEL}</strong>
    </span>
  );
}

interface ScanRow {
  equivalenceId: string;
  legA: { marketId: string; venue: string };
  legB: { marketId: string; venue: string };
  fundingDiffPerHourBps: number;
  roundTripCostBps: number;
  breakevenHours: number | null;
}

const POLICY_TEXT: Record<SpreadPlan["hedgeFailurePolicy"], string> = {
  leave_open: "leave leg A open",
  flatten_leg_a: "close leg A",
  retry_then_flatten: "retry leg B once, then close leg A",
};

export interface SpreadsDeps {
  execute?: (planId: string, log: (e: ExecutorEvent) => void) => Promise<{ status: string }>;
}

export function Spreads({ deps = {} }: { deps?: SpreadsDeps }) {
  const s = useSession();
  const [scan, setScan] = useState<ScanRow[] | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [equivalenceId, setEquivalenceId] = useState("");
  const [sizeBase, setSizeBase] = useState("0.01");
  const [leverage, setLeverage] = useState("2");
  const [policy, setPolicy] = useState<SpreadPlan["hedgeFailurePolicy"]>("flatten_leg_a");
  const [plan, setPlan] = useState<SpreadPlan | null>(null);
  const [ackChecked, setAckChecked] = useState(false);
  const [acked, setAcked] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = s.connected?.owner;

  async function runScan() {
    setScanNote(null);
    try {
      const r = await s.api.get<{ pairs: ScanRow[] }>("/spreads/scan");
      setScan(r.pairs);
    } catch (e) {
      const status = (e as { status?: number }).status;
      setScanNote(status === 402 ? "The spread scan is paid per call ($0.02) with x402. This dashboard does not pay calls; enter an approved equivalence id below." : (e as Error).message);
    }
  }

  async function makePlan(e: FormEvent) {
    e.preventDefault();
    if (!owner) return;
    setError(null);
    setPlan(null);
    setAcked(false);
    setAckChecked(false);
    setLog([]);
    try {
      setPlan(await s.api.signed<SpreadPlan>("POST", "/spreads/plan", { owner, equivalenceId, sizeBase, leverage: Number(leverage), hedgeFailurePolicy: policy }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function signAck() {
    if (!plan || !owner || !s.client || !s.wallet) return;
    setBusy(true);
    setError(null);
    try {
      const issuedAt = (s.cfg.now ?? Date.now)();
      const message = spreadAckMessage({ planId: plan.planId, owner, host: s.api.host, chainId: s.client.pins.networks[s.cfg.network].anchor.chainId, nonce: `ack-${plan.planId}-${issuedAt}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80), issuedAt });
      const sig = await s.wallet.signMessage(message);
      const r = await s.api.post<{ status: string }>(`/spreads/${encodeURIComponent(plan.planId)}/ack`, { sig, message, by: owner });
      setAcked(r.status === "acked");
      if (r.status !== "acked") setError(`The server did not accept the acknowledgement (${r.status}).`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (!plan || !acked) return;
    setBusy(true);
    const push = (ev: ExecutorEvent) => setLog((old) => [...old, `${ev.kind}${(ev as { data?: { venue?: string } }).data?.venue ? ` on ${venueName(String((ev as { data?: { venue?: string } }).data?.venue))}` : ""}`]);
    try {
      const run = deps.execute ?? defaultExecute(s);
      const r = await run(plan.planId, push);
      setLog((old) => [...old, `finished: ${r.status}`]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canExecute = !!plan && ackChecked && acked && !busy;
  return (
    <section aria-labelledby="spreads-title" data-screen="spreads">
      <h2 id="spreads-title">Funding-rate spread trades (at-risk)</h2>
      <p>
        A spread pairs the same asset on two venues. Each venue liquidates independently, and the funding difference is observed and changes every hour. <Hedge>Nothing here is a hedge you can rely on.</Hedge>
      </p>
      {!owner ? (
        <p>
          <ConnectLink /> to use this screen.
        </p>
      ) : null}
      <h3>Scan</h3>
      <p>
        <button type="button" className="button button-secondary" onClick={() => void runScan()}>
          Scan pairs
        </button>
      </p>
      {scanNote ? <p className="callout">{scanNote}</p> : null}
      {scan ? (
        <ul data-scan="">
          {scan.map((r) => (
            <li key={r.equivalenceId}>
              <button type="button" className="button button-small button-secondary" onClick={() => setEquivalenceId(r.equivalenceId)}>
                Use
              </button>{" "}
              {r.legA.marketId} and {r.legB.marketId}: funding difference {r.fundingDiffPerHourBps} bps per hour (observed), round trip {r.roundTripCostBps} bps, breakeven {r.breakevenHours ?? "never at current rates"} h
            </li>
          ))}
        </ul>
      ) : null}
      <h3>Plan</h3>
      <form className="stack" onSubmit={makePlan}>
        <label>
          Equivalence id <input value={equivalenceId} onChange={(e) => setEquivalenceId(e.target.value)} />
        </label>
        <label>
          Size per leg (base) <input value={sizeBase} onChange={(e) => setSizeBase(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Leverage <input value={leverage} onChange={(e) => setLeverage(e.target.value)} inputMode="numeric" />
        </label>
        <label>
          <Hedge>If leg B fails (hedge failure policy):</Hedge>{" "}
          <select value={policy} onChange={(e) => setPolicy(e.target.value as SpreadPlan["hedgeFailurePolicy"])}>
            <option value="flatten_leg_a">close leg A</option>
            <option value="retry_then_flatten">retry leg B once, then close leg A</option>
            <option value="leave_open">leave leg A open</option>
          </select>
        </label>
        <p>
          <button type="submit" className="button" disabled={!owner || !equivalenceId}>
            Make a plan
          </button>
        </p>
      </form>
      {plan ? (
        <div className="card" data-plan={plan.planId}>
          <h3>Plan {plan.planId}</h3>
          <p className="banner" data-plan-label="">
            {plan.riskLabel}
          </p>
          <dl className="checks">
            <div>
              <dt>Leg A (sent before leg B)</dt>
              <dd>
                {venueName(plan.legA.venue)} {plan.legA.side} {plan.legA.size} {plan.legA.marketId}, liquidation price {plan.legA.estLiqPx ?? "unknown"}
              </dd>
            </div>
            <div>
              <dt>Leg B</dt>
              <dd>
                {venueName(plan.legB.venue)} {plan.legB.side} {plan.legB.size} {plan.legB.marketId}, liquidation price {plan.legB.estLiqPx ?? "unknown"}
              </dd>
            </div>
            <div>
              <dt>Leftover delta</dt>
              <dd>{plan.residualDeltaBase}</dd>
            </div>
            <div>
              <dt>Funding difference (observed)</dt>
              <dd>{plan.fundingDiffPerHourBps} bps per hour</dd>
            </div>
            <div>
              <dt>Round trip cost</dt>
              <dd>{plan.roundTripCostBps} bps</dd>
            </div>
            <div>
              <dt>Breakeven</dt>
              <dd>{plan.breakevenHours === null ? "never at current rates" : `${plan.breakevenHours} hours`}</dd>
            </div>
            <div>
              <dt>
                <Hedge>Hedge failure policy</Hedge>
              </dt>
              <dd>{POLICY_TEXT[plan.hedgeFailurePolicy]}</dd>
            </div>
          </dl>
          <label className="row">
            <input type="checkbox" checked={ackChecked} onChange={(e) => setAckChecked(e.target.checked)} data-ack-box="" /> I read the plan. {SPREAD_RISK_LABEL}
          </label>
          <p className="mono break" data-ack-text="">
            {SPREAD_ACK_TEXT(plan.planId)}
          </p>
          <p className="row">
            <button type="button" className="button" disabled={!ackChecked || acked || busy} onClick={() => void signAck()}>
              {acked ? "Acknowledgement signed" : "Sign the acknowledgement"}
            </button>
            <button type="button" className="button" disabled={!canExecute} onClick={() => void execute()} data-execute="">
              Execute
            </button>
          </p>
        </div>
      ) : null}
      {log.length ? (
        <>
          <h3>Execution log</h3>
          <ol data-exec-log="">
            {log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
        </>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <Disclaimer compact />
    </section>
  );
}

/**
 * The SDK's executor over this session's client. Fills are read on Hyperliquid only; a plan with a leg on a venue
 * whose fill cannot be read here is refused before any order is sent, and an unread fill is never a no-fill (R1-8-01).
 */
export function defaultExecute(s: ReturnType<typeof useSession>) {
  return async (planId: string, log: (e: ExecutorEvent) => void) => {
    const { executeSpreadPlan, createApi, venueFillReader } = await import("../../lib/capstan");
    if (!s.client || !s.connected) throw new Error("Connect your wallet to do this.");
    const owner = s.connected.owner;
    const base = createApi(s.cfg.apiBase, s.cfg.fetch ?? fetch);
    const api = { ...base, get: base.get, host: base.host, post: async <T,>(path: string, body: unknown) => {
      if (path.endsWith("/events")) log(body as ExecutorEvent);
      return base.post<T>(path, body);
    } };
    const reader = venueFillReader({ owner, fetch: s.cfg.fetch ?? fetch, hyperliquidHost: s.cfg.venueHosts?.hyperliquid ?? "https://api.hyperliquid.xyz" });
    const r = await executeSpreadPlan(planId, s.client, api, reader);
    return { status: r.status };
  };
}
