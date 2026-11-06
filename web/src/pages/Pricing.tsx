import { Disclaimer } from "../components/Disclaimer";
import { Table } from "../components/Table";
import { PRICES, PRICING, paymentRails } from "../copy";
import { LIVE, type LiveFlags } from "../live";

export function Pricing({ live = LIVE }: { live?: LiveFlags }) {
  return (
    <article className="page">
      <h1>{PRICING.title}</h1>
      <p>{PRICING.intro}</p>
      <section aria-labelledby="prices-title">
        <h2 id="prices-title">{PRICING.pricesTitle}</h2>
        <Table label="Prices per endpoint group" head={["Endpoint group", "Price"]} rows={PRICES.map((p) => [p.group, p.price])} />
        <p data-rails="">
          {PRICING.railsLabel}: {paymentRails(live).join(", ")}.
        </p>
        <p>{PRICING.executionNote}</p>
      </section>
      <section aria-labelledby="plans-title">
        <h2 id="plans-title">{PRICING.plansTitle}</h2>
        <dl className="plans">
          {PRICING.plans.map((p) => (
            <div key={p.name}>
              <dt>{p.name}</dt>
              <dd>{p.text}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby="lock-title">
        <h2 id="lock-title">{PRICING.lockTitle}</h2>
        <p>{PRICING.lockIntro}</p>
        <Table label="Lock tiers" head={["Tier", "Locked amount", "Perks"]} rows={PRICING.lockTiers.map((t) => [t.name, t.need, t.perks])} />
        <p>{PRICING.lockNote}</p>
      </section>
      <Disclaimer />
    </article>
  );
}
