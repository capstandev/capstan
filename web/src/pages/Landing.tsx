import { Link } from "react-router";
import { Disclaimer } from "../components/Disclaimer";
import { Table } from "../components/Table";
import { TokenAddressBox } from "../components/TokenAddressBox";
import { FEES, LANDING, PUBLIC_APIS, VENUES, landingClaims } from "../copy";
import { LIVE, type LiveFlags } from "../live";
import type { ContractsJson } from "../lib/contracts";

export function Landing({ live = LIVE, contracts }: { live?: LiveFlags; contracts?: ContractsJson }) {
  return (
    <article className="page">
      <section className="hero" aria-labelledby="hero-title">
        <h1 id="hero-title">Capstan</h1>
        <p className="lead">{LANDING.oneLiner}</p>
        {LANDING.threeSentences.map((s) => (
          <p key={s}>{s}</p>
        ))}
        <p>
          <Link className="button" to="/docs">
            {LANDING.cta}
          </Link>
        </p>
      </section>

      <Disclaimer />

      <section aria-labelledby="how-title">
        <h2 id="how-title">{LANDING.howTitle}</h2>
        <ol className="steps">
          {LANDING.how.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="claims-title">
        <h2 id="claims-title">{LANDING.claimsTitle}</h2>
        <ul className="claims">
          {landingClaims(live).map((c) => (
            <li key={c.id} data-claim={c.id}>
              {c.text}
            </li>
          ))}
        </ul>
        <h3>{LANDING.neverTitle}</h3>
        <ul>
          {LANDING.never.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="venues-title">
        <h2 id="venues-title">{LANDING.venuesTitle}</h2>
        <p>{PUBLIC_APIS}</p>
        <Table label="Venues" head={["Venue", "Markets", "Access"]} rows={VENUES.map((v) => [v.venue, v.markets, v.access])} />
      </section>

      <section aria-labelledby="fees-title">
        <h2 id="fees-title">{LANDING.feesTitle}</h2>
        <Table label="Integration fees per venue" head={["Venue", "Approval your main wallet signs", "Default fee", "With a lock tier"]} rows={FEES.map((f) => [f.venue, f.approval, f.charge, f.lockCharge])} />
        <p>{LANDING.feesNote}</p>
      </section>

      <TokenAddressBox {...(contracts ? { data: contracts } : {})} />
    </article>
  );
}
