// The dashboard (todo 39): a thin UI over the SDK. Connect, onboarding per venue, quote, order ticket, risk,
// receipts, policy and kill, spread planner. A refused region sees one sentence and nothing else.
import { NavLink, Route, Routes } from "react-router";
import { Disclaimer } from "../components/Disclaimer";
import { REGION_REFUSED } from "../copy";
import { Connect } from "./screens/Connect";
import { Onboarding } from "./screens/Onboarding";
import { OrderTicket } from "./screens/OrderTicket";
import { PolicyKill } from "./screens/PolicyKill";
import { QuoteTable } from "./screens/QuoteTable";
import { Receipts } from "./screens/Receipts";
import { RiskPanel } from "./screens/RiskPanel";
import { Spreads, type SpreadsDeps } from "./screens/Spreads";
import { SessionProvider, useSession, type SessionDeps } from "./session";

export const DASH_NAV = [
  { to: "/app", label: "Connect" },
  { to: "/app/onboard/hyperliquid", label: "Onboard" },
  { to: "/app/quote", label: "Quote" },
  { to: "/app/order", label: "Order" },
  { to: "/app/risk", label: "Risk" },
  { to: "/app/receipts", label: "Receipts" },
  { to: "/app/policy", label: "Policy and kill" },
  { to: "/app/spreads", label: "Spreads" },
] as const;

function Screens({ spreads }: { spreads?: SpreadsDeps }) {
  const s = useSession();
  if (s.eligibility && !s.eligibility.allowed && s.eligibility.code === "GEO_REFUSED") {
    return (
      <p className="callout" data-region-refused="">
        {REGION_REFUSED}
      </p>
    );
  }
  return (
    <>
      <nav aria-label="Dashboard">
        <ul className="row subnav">
          {DASH_NAV.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} end={n.to === "/app"}>
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Routes>
        <Route index element={<Connect />} />
        <Route path="onboard/:venue" element={<Onboarding />} />
        <Route path="quote" element={<QuoteTable />} />
        <Route path="order" element={<OrderTicket />} />
        <Route path="risk" element={<RiskPanel />} />
        <Route path="receipts" element={<Receipts />} />
        <Route path="policy" element={<PolicyKill />} />
        <Route path="spreads" element={<Spreads {...(spreads ? { deps: spreads } : {})} />} />
      </Routes>
    </>
  );
}

export function Dashboard({ deps, spreads }: { deps?: SessionDeps; spreads?: SpreadsDeps }) {
  return (
    <article className="page" data-dashboard="">
      <h1>Dashboard</h1>
      <SessionProvider {...(deps ? { deps } : {})}>
        <Screens {...(spreads ? { spreads } : {})} />
      </SessionProvider>
      <Disclaimer />
    </article>
  );
}
