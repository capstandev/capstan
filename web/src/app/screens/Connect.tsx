// Connect: injected wallets found through EIP-6963. WalletConnect (Reown) appears only when the build has a project id
// (BACKLOG B8). The chain is shown, never switched for the user.
import { useEffect } from "react";
import { Link } from "react-router";
import { useSession } from "../session";
import { EXECUTION_VENUES, venueName } from "../venues";
import { reownEnabled } from "../wallet";

export function Connect() {
  const s = useSession();
  useEffect(() => {
    if (s.wallets === null) void s.findWallets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fork = s.cfg.profile === "fork";
  return (
    <section aria-labelledby="connect-title" data-screen="connect">
      <h2 id="connect-title">Connect your wallet</h2>
      {s.connected ? (
        <div data-connected="">
          <p>
            Connected with {s.connected.info.name}: <span className="mono break">{s.connected.owner}</span> on chain {s.connected.chainId}.
          </p>
          {fork && s.cfg.writeChainDenylist.includes(s.connected.chainId) ? (
            <p className="error" role="alert" data-chain-refused="">
              This local test network build never signs a write from chain {s.connected.chainId}. Switch your wallet to a test chain yourself.
            </p>
          ) : null}
          <h3>Venues</h3>
          <ul>
            {EXECUTION_VENUES.map((v) => (
              <li key={v}>
                <Link to={`/app/onboard/${v}`}>{venueName(v)}</Link>: {s.venues[v]?.status === "active" ? "ready" : s.venues[v]?.status === "fee_free_unavailable" ? "fee_free_unavailable" : "not onboarded"}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <p>Your main wallet signs the venue approvals. Capstan never asks for its key, and the trade-only key the SDK makes stays in this browser.</p>
          {s.wallets === null ? <p role="status">Looking for wallets in this browser.</p> : null}
          {s.wallets && s.wallets.length === 0 ? <p>No browser wallet found. Install or unlock one, then reload the page.</p> : null}
          <ul className="stack" data-wallets="">
            {(s.wallets ?? []).map((w) => (
              <li key={w.info.uuid}>
                <button type="button" className="button" onClick={() => void s.connect(w)}>
                  Connect {w.info.name}
                </button>
              </li>
            ))}
          </ul>
          {reownEnabled(s.cfg) ? <p>WalletConnect is configured for this build.</p> : null}
          <p>
            <button type="button" className="button button-secondary" onClick={() => void s.findWallets()}>
              Look again
            </button>
          </p>
          {s.connectError ? (
            <p className="error" role="alert">
              {s.connectError}
            </p>
          ) : null}
        </>
      )}
      <h3>API key (optional)</h3>
      <p>A Capstan API key raises your limits. It is kept in memory for this tab only and sent only to the Capstan API.</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const v = (e.currentTarget.elements.namedItem("apikey") as HTMLInputElement | null)?.value.trim() ?? "";
          s.setApiKey(v || null);
        }}
      >
        <label>
          API key <input name="apikey" type="password" autoComplete="off" />
        </label>
        <button type="submit" className="button button-secondary">
          {s.apiKey ? "Replace" : "Use"}
        </button>
      </form>
    </section>
  );
}
