// Receipts: the ones made in this session, and the owner-signed listing (GET /receipts?owner=, api_request
// signature). Each links to /verify, where the check runs in the browser.
import { useState } from "react";
import { VerifyLink } from "../../components/VerifyLink";
import type { Receipt } from "../../lib/capstan";
import { useSession } from "../session";
import { venueName } from "../venues";

export function Receipts() {
  const s = useSession();
  const [listed, setListed] = useState<Receipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = s.connected?.owner;

  async function load() {
    if (!owner) return;
    setError(null);
    try {
      const r = await s.api.signed<{ receipts: Receipt[] }>("GET", `/receipts?owner=${owner}`);
      setListed(r.receipts);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section aria-labelledby="receipts-title" data-screen="receipts">
      <h2 id="receipts-title">Receipts</h2>
      <h3>This session</h3>
      {s.receipts.length ? (
        <ul data-session-receipts="">
          {s.receipts.map((r) => (
            <li key={r.receiptId}>
              {r.what}
              {r.venue ? ` (${venueName(r.venue)})` : ""}: <VerifyLink id={r.receiptId}>verify {r.receiptId}</VerifyLink>
            </li>
          ))}
        </ul>
      ) : (
        <p>No receipts in this session yet.</p>
      )}
      <h3>All your receipts</h3>
      <p>
        <button type="button" className="button" onClick={() => void load()} disabled={!owner}>
          List my receipts (signs a request)
        </button>
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {listed ? (
        listed.length ? (
          <ul data-listed-receipts="">
            {listed.map((r) => (
              <li key={r.receiptId}>
                {r.ts} {r.action}
                {r.venue ? ` on ${venueName(r.venue)}` : ""}: <VerifyLink id={r.receiptId}>verify {r.receiptId}</VerifyLink>
              </li>
            ))}
          </ul>
        ) : (
          <p>No receipts yet.</p>
        )
      ) : null}
    </section>
  );
}
