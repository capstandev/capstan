// Onboarding ceremony for one venue (spec 7.2): preflight, then the SDK makes the trade-only key, fetches the bundle
// and checks it against its pins. Only a bundle the SDK accepts reaches this screen's step list, and every line is on
// screen before the wallet is asked for anything. Declining the builder step leaves the venue fee_free_unavailable.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { SdkError, type Hex, type VenueId } from "../../lib/capstan";
import { useSession } from "../session";
import { BUILDER_VENUES, EXECUTION_VENUES, FEE_FREE_UNAVAILABLE, venueName } from "../venues";
import { WalletStepError, WriteRefused, isBuilderStep } from "../wallet";

const BUNDLE_REFUSALS = new Set(["TEMPLATE_UNKNOWN", "PAYLOAD_MISMATCH", "DEPLOYMENT_MISMATCH", "BUILD_EXPIRED"]);

/** "0.03%" stays as is; Aster's decimal rate 0.0003 reads as 0.03%. */
export function percentOf(ceiling: string): string {
  if (ceiling.endsWith("%")) return ceiling;
  const pct = (Number(ceiling) * 100).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `${pct}%`;
}

/** The builder step in plain words, from the SDK's pinned ceiling (the bundle was checked against it). */
export function builderLine(venue: VenueId, ceiling: string): string {
  if (venue === "aster") return `Builder fee: max ${percentOf(ceiling)} per order (Aster maxFeeRate ${ceiling}, which is 3 bps). It is charged only on fills Capstan routes.`;
  return `Builder fee: max ${percentOf(ceiling)} per trade (3 bps). It is charged only on fills Capstan routes, and you can revoke it from your wallet.`;
}

interface Preflight {
  slotsFree?: number;
  builderApprovedBps?: number;
  depositRequired?: boolean;
  accountIndex?: number;
  freeKeyIndex?: number;
  eligibility?: { allowed?: boolean; code?: string };
}

export function Onboarding() {
  const s = useSession();
  const params = useParams();
  const venue = (EXECUTION_VENUES.includes(params.venue as VenueId) ? params.venue : "hyperliquid") as VenueId;
  const [pre, setPre] = useState<Preflight | null>(null);
  const [preError, setPreError] = useState<string | null>(null);
  const [mode, setMode] = useState<"relay" | "direct">("relay");
  const [agentSafe, setAgentSafe] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = s.venues[venue];
  const owner = s.connected?.owner ?? null;

  useEffect(() => {
    if (!owner) return;
    let alive = true;
    setPre(null);
    setPreError(null);
    s.api
      .get<Preflight>(`/onboarding/preflight?venue=${encodeURIComponent(venue)}&owner=${owner}`)
      .then((p) => alive && setPre(p))
      .catch((e: Error) => alive && setPreError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venue, owner]);

  if (!s.client || !owner) {
    return (
      <section aria-labelledby="onb-title">
        <h2 id="onb-title">Onboard {venueName(venue)}</h2>
        <p>
          <Link to="/app">Connect your wallet</Link> to use this screen.
        </p>
      </section>
    );
  }

  const ceiling = s.client.pins.networks[s.cfg.network].approvalCeilings[venue === "aster" ? "aster" : "hyperliquid"];

  async function start() {
    if (!s.client) return;
    setBusy(true);
    s.onboardingVenue.current = venue;
    s.setVenue(venue, { status: "onboarding" });
    const promptsBefore = s.prompts.current;
    try {
      const policy = agentSafe && s.policyDraft ? s.policyDraft : undefined;
      const r = await s.client.onboard(venue, { mode: policy ? "relay" : mode, ...(policy ? { policy } : {}) });
      const agent = s.client.agents().find((a) => a.agentRef === r.agentRef);
      const declined = r.routing === "fee_free_unavailable";
      s.setVenue(venue, {
        status: declined ? "fee_free_unavailable" : "active",
        agentRef: r.agentRef,
        ...(agent ? { agentAddress: agent.publicPart, mode: agent.mode } : {}),
        ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
        ...(r.policyId ? { policyId: r.policyId } : {}),
        ...(r.receiptId ? { receiptId: r.receiptId } : {}),
        ...(declined ? { message: FEE_FREE_UNAVAILABLE(venue) } : {}),
      });
      if (r.receiptId) s.addReceipt({ receiptId: r.receiptId, what: `Onboarding on ${venueName(venue)}`, venue });
    } catch (e) {
      const prompted = s.prompts.current > promptsBefore;
      const declinedBuilder = s.lastDecline.current === "declined_builder" || (e instanceof WalletStepError && e.declined && isBuilderStep(e.step));
      if (declinedBuilder && BUILDER_VENUES.has(venue)) s.setVenue(venue, { status: "fee_free_unavailable", message: FEE_FREE_UNAVAILABLE(venue) });
      else if (e instanceof WriteRefused) s.setVenue(venue, { status: "error", message: e.message });
      else if (e instanceof SdkError && BUNDLE_REFUSALS.has(e.code)) s.setVenue(venue, { status: "error", message: `The SDK refused the onboarding bundle from the server (${e.code}${e.field ? `: ${e.field}` : ""}). ${prompted ? "" : "Your wallet was not asked to sign anything. "}No key was kept.` });
      else if (s.lastDecline.current === "cancelled") s.setVenue(venue, { status: "none", message: "You cancelled. No key was kept." });
      else s.setVenue(venue, { status: "error", message: `Onboarding stopped: ${(e as Error).message}. No key was kept.` });
    } finally {
      setBusy(false);
      s.clearConfirm();
      s.onboardingVenue.current = null;
    }
  }

  const confirm = s.confirm && s.confirm.venue === venue ? s.confirm : null;
  return (
    <section aria-labelledby="onb-title" data-screen="onboarding">
      <h2 id="onb-title">Onboard {venueName(venue)}</h2>
      <p>
        One ceremony per venue. The SDK makes a new trade-only key in this browser (it cannot withdraw), then your main wallet signs the venue's approvals. Owner: <span className="mono break">{owner}</span>
      </p>
      <h3>Preflight</h3>
      {preError ? <p className="error">Preflight failed: {preError}</p> : null}
      {pre ? (
        <dl className="checks" data-preflight="">
          {pre.slotsFree !== undefined ? (
            <div>
              <dt>Free agent slots</dt>
              <dd>{pre.slotsFree}</dd>
            </div>
          ) : null}
          {pre.builderApprovedBps !== undefined ? (
            <div>
              <dt>Builder fee approved now</dt>
              <dd>{pre.builderApprovedBps} bps</dd>
            </div>
          ) : null}
          {pre.depositRequired !== undefined ? (
            <div>
              <dt>Deposit needed before onboarding</dt>
              <dd>{pre.depositRequired ? "yes" : "no"}</dd>
            </div>
          ) : null}
          {pre.accountIndex !== undefined ? (
            <div>
              <dt>Account index</dt>
              <dd>{pre.accountIndex}</dd>
            </div>
          ) : null}
          {pre.eligibility ? (
            <div>
              <dt>Eligibility</dt>
              <dd>{pre.eligibility.allowed === false ? "Not available in your region." : "allowed"}</dd>
            </div>
          ) : null}
        </dl>
      ) : !preError ? (
        <p role="status">Reading preflight.</p>
      ) : null}

      {confirm ? (
        <div className="card" data-confirm="" role="group" aria-labelledby="confirm-title">
          <h3 id="confirm-title">What your wallet will sign</h3>
          <p>The SDK checked this bundle against its pinned templates. Read every step before you continue.</p>
          <ol data-lines="">
            {confirm.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ol>
          {BUILDER_VENUES.has(venue) ? (
            <p className="callout" data-builder-line="">
              {builderLine(venue, ceiling)}
            </p>
          ) : (
            <p className="callout">{venueName(venue)} has no builder fee. Capstan charges nothing on these routes.</p>
          )}
          {confirm.answered ? (
            <p role="status" data-waiting-wallet="">
              Sign each step in your wallet. The steps above stay here while you do.
            </p>
          ) : (
            <p className="row">
              <button type="button" className="button" onClick={() => s.answerConfirm(true)}>
                Continue to your wallet
              </button>
              {BUILDER_VENUES.has(venue) ? (
                <button type="button" className="button button-secondary" onClick={() => s.answerConfirm(false, "declined_builder")}>
                  Decline the builder fee
                </button>
              ) : null}
              <button type="button" className="button button-secondary" onClick={() => s.answerConfirm(false, "cancelled")}>
                Cancel
              </button>
            </p>
          )}
        </div>
      ) : null}

      {!confirm ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <fieldset>
            <legend>Mode</legend>
            <label>
              <input type="radio" name="mode" value="relay" checked={mode === "relay" || agentSafe} onChange={() => setMode("relay")} /> Relay: Capstan sends your signed orders
            </label>
            <br />
            <label>
              <input type="radio" name="mode" value="direct" checked={mode === "direct" && !agentSafe} disabled={agentSafe} onChange={() => setMode("direct")} /> Direct: your browser sends them to the venue
            </label>
          </fieldset>
          <label>
            <input type="checkbox" checked={agentSafe} disabled={!s.policyDraft} onChange={(e) => setAgentSafe(e.target.checked)} /> Agent-safe mode with your policy (relay only)
          </label>
          {!s.policyDraft ? (
            <p>
              Set a policy on the <Link to="/app/policy">policy screen</Link> to use agent-safe mode.
            </p>
          ) : null}
          <p>
            <button type="submit" className="button" disabled={busy}>
              {busy ? "Working" : `Start onboarding on ${venueName(venue)}`}
            </button>
          </p>
        </form>
      ) : null}

      {state?.status === "active" ? (
        <div className="ok" data-delegation="">
          <p>
            <strong>Active on {venueName(venue)}.</strong>
          </p>
          <dl className="checks">
            <div>
              <dt>Trade-only key</dt>
              <dd className="mono break" data-agent-address="">
                {state.agentAddress}
              </dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{state.expiresAt ?? "set by the venue"}</dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{state.mode}</dd>
            </div>
            {state.policyId ? (
              <div>
                <dt>Policy</dt>
                <dd className="mono">{state.policyId}</dd>
              </div>
            ) : null}
          </dl>
          {state.receiptId ? (
            <p>
              Receipt <Link to={`/verify?id=${encodeURIComponent(state.receiptId)}`}>{state.receiptId}</Link>
            </p>
          ) : null}
        </div>
      ) : null}
      {state?.status === "fee_free_unavailable" ? (
        <p className="callout" data-fee-free="">
          {state.message ?? FEE_FREE_UNAVAILABLE(venue)}
        </p>
      ) : null}
      {state?.status === "error" || (state?.status === "none" && state.message) ? (
        <p className="error" role="alert" data-onboarding-error="">
          {state.message}
        </p>
      ) : null}
    </section>
  );
}


