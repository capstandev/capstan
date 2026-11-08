// Agent-safe policy editor and the kill switch (spec 7.6). The policy is signed by the main wallet as a step of the
// next onboarding bundle (agent-safe mode, relay only). Kill: the SDK signs the stop (the agent key for itself, or the
// wallet), the relay refuses the agent at once, the local key is wiped, and the venue revocation steps are shown:
// only the main wallet can revoke a venue key.
import { useState, type FormEvent } from "react";
import { ConnectLink } from "../nav";
import type { AgentPolicy, KillResult, VenueId } from "../../lib/capstan";
import { useSession } from "../session";
import { EXECUTION_VENUES, venueName } from "../venues";

export const ONLY_WALLET = "Only your wallet can revoke the venue key.";

/** The steps a venue needs to fully remove the key, after Capstan's relay stopped it. */
export function revocationSteps(venue: VenueId, k: KillResult): string[] {
  const fromServer = k.revocation?.humanReadable ?? [];
  if (fromServer.length) return [...fromServer];
  if (venue === "hyperliquid") return ["In your main wallet, approve a new agent with the same name to replace this key on Hyperliquid, or let it expire."];
  if (venue === "aster") return ["In your main wallet, sign Aster's remove-agent request (DELETE /agent) for this key.", "Optional: sign Aster's remove-builder request (DELETE /builder)."];
  return [`On ${venueName(venue)}, register a new API key at the same key index with your main wallet; the old key stops working.`];
}

function inDays(now: number, d: number) {
  return new Date(now + d * 86_400_000).toISOString();
}

export function PolicyKill() {
  const s = useSession();
  const now = (s.cfg.now ?? Date.now)();
  const [perOrder, setPerOrder] = useState("1000");
  const [gross, setGross] = useState("5000");
  const [lev, setLev] = useState("3");
  const [perDay, setPerDay] = useState("50");
  const [markets, setMarkets] = useState("*");
  const [days, setDays] = useState("7");
  const [venues, setVenues] = useState<VenueId[]>(["hyperliquid"]);
  const [kills, setKills] = useState<Record<string, { venue: VenueId; result: KillResult; keyGone: boolean }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const owner = s.connected?.owner;

  function savePolicy(e: FormEvent) {
    e.preventDefault();
    if (!owner) return;
    const p: AgentPolicy = {
      owner,
      agents: [],
      maxNotionalPerOrderUsd: perOrder,
      maxGrossNotionalUsd: gross,
      maxLeverage: Number(lev),
      allowedMarkets: markets.trim() === "*" ? "*" : markets.split(",").map((m) => m.trim()).filter(Boolean),
      allowedVenues: venues,
      maxOrdersPerDay: Number(perDay),
      expiresAt: inDays(now, Number(days)),
      nonce: Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join(""),
    };
    s.setPolicyDraft(p);
  }

  async function kill(agentRef: string, venue: VenueId) {
    if (!s.client) return;
    setBusy(agentRef);
    try {
      const result = await s.client.kill(agentRef);
      const keyGone = !(await s.keystore.list()).some((k) => (k as { tags?: Record<string, string> }).tags?.agentRef === agentRef);
      setKills((old) => ({ ...old, [agentRef]: { venue, result, keyGone } }));
      s.setVenue(venue, { status: "none", message: result.relayBlocked ? "Stopped. Onboard again to trade here." : `The relay could not be reached: ${result.error ?? "no answer"}. The local key was wiped anyway.` });
    } finally {
      setBusy(null);
    }
  }

  const agents = s.client?.agents() ?? [];
  return (
    <section aria-labelledby="policy-title" data-screen="policy">
      <h2 id="policy-title">Policy and kill switch</h2>
      {!owner ? (
        <p>
          <ConnectLink /> to use this screen.
        </p>
      ) : null}
      <h3>Agent-safe policy</h3>
      <p>Your main wallet signs these caps during the next onboarding. The relay and the SDK both enforce them; agent-safe mode is relay only.</p>
      <form className="stack" onSubmit={savePolicy} data-policy-form="">
        <label>
          Max notional per order (USD) <input value={perOrder} onChange={(e) => setPerOrder(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Max gross notional (USD) <input value={gross} onChange={(e) => setGross(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Max leverage <input value={lev} onChange={(e) => setLev(e.target.value)} inputMode="numeric" />
        </label>
        <label>
          Max orders per day <input value={perDay} onChange={(e) => setPerDay(e.target.value)} inputMode="numeric" />
        </label>
        <label>
          Markets (comma separated, or * for all) <input value={markets} onChange={(e) => setMarkets(e.target.value)} />
        </label>
        <label>
          Expires after (days) <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" />
        </label>
        <fieldset>
          <legend>Venues</legend>
          {EXECUTION_VENUES.map((v) => (
            <label key={v} className="row">
              <input type="checkbox" checked={venues.includes(v)} onChange={(e) => setVenues((old) => (e.target.checked ? [...old, v] : old.filter((x) => x !== v)))} /> {venueName(v)}
            </label>
          ))}
        </fieldset>
        <p>
          <button type="submit" className="button" disabled={!owner}>
            Use this policy for the next onboarding
          </button>
        </p>
      </form>
      {s.policyDraft ? (
        <p className="ok" data-policy-draft="">
          Policy ready: at most {s.policyDraft.maxNotionalPerOrderUsd} USD per order, {s.policyDraft.maxOrdersPerDay} orders a day, leverage {s.policyDraft.maxLeverage}, until {s.policyDraft.expiresAt}.
        </p>
      ) : null}

      <h3>Kill switch</h3>
      <p>{ONLY_WALLET} The kill switch stops Capstan's relay for that key at once and wipes the key from this browser.</p>
      {agents.length === 0 ? <p>No trade-only key in this browser.</p> : null}
      <ul>
        {agents.map((a) => (
          <li key={a.agentRef} className="card">
            <p>
              {venueName(a.venue)}: key <span className="mono break">{a.publicPart}</span> ({a.mode})
            </p>
            <button type="button" className="button button-danger" onClick={() => void kill(a.agentRef, a.venue)} disabled={busy !== null}>
              Kill this key
            </button>
          </li>
        ))}
      </ul>
      {Object.entries(kills).map(([ref, k]) => (
        <div key={ref} className="card" data-kill-result={ref}>
          <h4>Stopped: {venueName(k.venue)}</h4>
          <p>{k.result.relayBlocked ? "Capstan's relay refuses this key from now on." : `The relay was not reached (${k.result.error ?? "no answer"}).`}</p>
          <p>{k.keyGone ? "The key was wiped from this browser." : "The key could not be confirmed wiped; reload the page."}</p>
          <p>
            <strong>{ONLY_WALLET}</strong> To remove it from {venueName(k.venue)} too:
          </p>
          <ol data-revocation-steps="">
            {revocationSteps(k.venue, k.result).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}
