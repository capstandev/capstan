import { TOKEN_LINE } from "../copy";
import { useConfig } from "../config";
import { CONTRACTS, cpstOn, type ContractsJson } from "../lib/contracts";
import { CopyButton } from "./CopyButton";

/** Hidden until contracts.json has a CPST address for this build's chain; then the address, a copy button and the explorer link. */
export function TokenAddressBox({ data = CONTRACTS }: { data?: ContractsJson }) {
  const cfg = useConfig();
  const e = cpstOn(cfg.tokenChainId, data);
  if (!e) return null;
  const href = `${cfg.explorerBase.replace(/\/$/, "")}/token/${e.address}`;
  return (
    <section className="token-box" aria-labelledby="token-box-title" data-token-box="">
      <h2 id="token-box-title">{TOKEN_LINE}</h2>
      <p className="mono break" data-token-address="">
        {e.address}
      </p>
      <p className="row">
        <CopyButton value={e.address} label="Copy the token address" />
        <a href={href} rel="noreferrer noopener" target="_blank">
          View on the explorer
        </a>
      </p>
    </section>
  );
}
