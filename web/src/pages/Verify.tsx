import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { useConfig } from "../config";
import { VERIFY_COPY } from "../copy";
import { verifyReceiptInput, type VerifyOutcome } from "../lib/verify";

function word(ok: boolean, yes: string, no: string) {
  return ok ? yes : no;
}

export function rootText(v: VerifyOutcome["checks"]["onChainRoot"]): string {
  if (v === "not_posted") return VERIFY_COPY.notPosted;
  if (v === "unchecked") return VERIFY_COPY.unchecked;
  return v ? "matches the posted root" : "differs from the posted root";
}

export function Verify() {
  const cfg = useConfig();
  const [params] = useSearchParams();
  const [input, setInput] = useState(params.get("id") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<VerifyOutcome | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOut(null);
    try {
      setOut(
        await verifyReceiptInput(input, {
          apiBase: cfg.apiBase,
          network: cfg.network,
          rpcUrl: cfg.rpcUrl,
          ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
          ...(cfg.pinned ? { pinned: cfg.pinned } : {}),
          ...(cfg.receiptSigners ? { receiptSigners: cfg.receiptSigners } : {}),
          ...(cfg.anchorAddress !== undefined ? { anchorAddress: cfg.anchorAddress } : {}),
          ...(cfg.anchorChainId !== undefined ? { anchorChainId: cfg.anchorChainId } : {}),
        }),
      );
    } catch (err) {
      setError((err as Error).message || "The check could not run.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="page">
      <h1>{VERIFY_COPY.title}</h1>
      <p>{VERIFY_COPY.intro}</p>
      <form onSubmit={onSubmit} className="stack">
        <label htmlFor="receipt-input">{VERIFY_COPY.label}</label>
        <textarea id="receipt-input" rows={6} value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} />
        <p>
          <button type="submit" className="button" disabled={busy}>
            {busy ? "Checking" : VERIFY_COPY.button}
          </button>
        </p>
      </form>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {out ? (
        <section aria-labelledby="result-title" data-verify-result={out.valid ? "valid" : "invalid"}>
          <h2 id="result-title">{out.valid ? VERIFY_COPY.valid : VERIFY_COPY.invalid}</h2>
          <dl className="checks">
            <div data-check="signature">
              <dt>{VERIFY_COPY.signature}</dt>
              <dd>{out.signerSource === "none" ? "no published receipt signer in this build" : word(out.checks.signature, "valid", "not valid")}</dd>
            </div>
            <div data-check="leaf">
              <dt>{VERIFY_COPY.leaf}</dt>
              <dd>{word(out.checks.leaf, "recomputed and matches", "does not match")}</dd>
            </div>
            <div data-check="proof">
              <dt>{VERIFY_COPY.proof}</dt>
              <dd>{word(out.checks.proof, "valid for the hourly root", "not valid")}</dd>
            </div>
            <div data-check="hour">
              <dt>{VERIFY_COPY.hour}</dt>
              <dd>{word(out.checks.hour, "the receipt's own hour", "another hour")}</dd>
            </div>
            <div data-check="root">
              <dt>{VERIFY_COPY.root}</dt>
              <dd>{rootText(out.checks.onChainRoot)}</dd>
            </div>
          </dl>
          <p>{VERIFY_COPY.limits}</p>
          <details>
            <summary>Receipt {out.receipt.receiptId}</summary>
            <pre className="mono">{JSON.stringify(out.receipt, null, 2)}</pre>
          </details>
        </section>
      ) : null}
    </article>
  );
}
