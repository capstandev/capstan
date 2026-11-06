import { Disclaimer } from "../components/Disclaimer";
import { LEGAL, REGION_REFUSED } from "../copy";

export function Legal() {
  return (
    <article className="page">
      <h1>{LEGAL.title}</h1>
      <Disclaimer />
      <section aria-labelledby="risk-title">
        <h2 id="risk-title">{LEGAL.riskTitle}</h2>
        <ul>
          {LEGAL.risk.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="regions-title">
        <h2 id="regions-title">{LEGAL.regionsTitle}</h2>
        <p>{LEGAL.regions}</p>
        <p className="callout" data-region-refused="">
          {REGION_REFUSED}
        </p>
      </section>
      <section aria-labelledby="dbip-title">
        <h2 id="dbip-title">{LEGAL.dbipTitle}</h2>
        <p>
          <a href="https://db-ip.com" rel="noreferrer noopener" target="_blank">
            {LEGAL.dbip}
          </a>
          . {LEGAL.dbipLicense}
        </p>
      </section>
      <section aria-labelledby="advice-title">
        <h2 id="advice-title">{LEGAL.nothingTitle}</h2>
        <p>{LEGAL.nothing}</p>
      </section>
    </article>
  );
}
