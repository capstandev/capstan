// React inside the owner's pages: the dashboard screens, the quote widget, the risk widget and the docs, verify,
// status, legal and not-found pages, each mounted into an element the owner's markup provides, under a ".cap-live"
// wrapper that src/site/live.css styles in the owner's colours and type. One SessionProvider per page, so a wallet
// connected once stays connected across the dashboard's views.
import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { ConfigContext, type AppConfig } from "../config";
import { ConnectNav } from "../app/nav";
import { QuoteTable } from "../app/screens/QuoteTable";
import { RiskPanel } from "../app/screens/RiskPanel";
import { SessionProvider, useSession, type SessionDeps } from "../app/session";
import { ApiDocs } from "../pages/ApiDocs";
import { Legal } from "../pages/Legal";
import { Status } from "../pages/Status";
import { Verify } from "../pages/Verify";
import type { RiskView } from "../lib/capstan";
import { venueName } from "../app/venues";
import { fmtPrice, fmtUsd } from "./data";
import type { RiskSummary } from "./feature";

/** Config, an in-memory router (the screens' own links), the session, and an optional "connect" handler. */
export function Providers({ cfg, children, onConnect, onNavigate, deps, initialPath = "/app" }: { cfg: AppConfig; children: ReactNode; onConnect?: () => void; onNavigate?: (path: string) => void; deps?: SessionDeps; initialPath?: string }) {
  return (
    <ConfigContext.Provider value={cfg}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SessionProvider {...(deps ? { deps } : {})}>
          <ConnectNav.Provider value={onConnect ?? null}>
            {onNavigate ? <NavWatch onNavigate={onNavigate} /> : null}
            {children}
          </ConnectNav.Provider>
        </SessionProvider>
      </MemoryRouter>
    </ConfigContext.Provider>
  );
}

function NavWatch({ onNavigate }: { onNavigate: (path: string) => void }) {
  const loc = useLocation();
  useEffect(() => onNavigate(loc.pathname), [loc.pathname, onNavigate]);
  return null;
}

export function mount(el: Element, node: ReactNode) {
  const root = createRoot(el);
  root.render(<StrictMode>{node}</StrictMode>);
  return root;
}

/** A short connect step: the wallets found (or the Reown picker), or the connected address. */
export function ConnectStrip({ id = "cap-connect" }: { id?: string }) {
  const s = useSession();
  useEffect(() => {
    if (s.wallets === null) void s.findWallets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (s.connected)
    return (
      <p className="cap-connected" id={id} data-connected="">
        Connected: <span className="mono break">{s.connected.owner}</span> on chain {s.connected.chainId}.
      </p>
    );
  return (
    <div className="row" id={id} data-connect-strip="">
      {s.wallets === null ? <span role="status">Looking for wallets in this browser.</span> : null}
      {s.wallets && s.wallets.length === 0 ? <span>No browser wallet found. Install or unlock one, then reload the page.</span> : null}
      {(s.wallets ?? []).map((w) => (
        <button key={w.info.uuid} type="button" className="button" onClick={() => void s.connect(w)}>
          Connect {w.info.name}
        </button>
      ))}
      {s.connectError ? (
        <span className="error" role="alert">
          {s.connectError}
        </span>
      ) : null}
    </div>
  );
}

/** The values the risk page's detail sheet shows, from the first venue account with a position. */
export function riskSummary(v: RiskView): RiskSummary | null {
  const a = v.perVenue.find((x) => x.positions.length > 0) ?? v.perVenue[0];
  if (!a) return null;
  const p = a.positions[0];
  const eq = Number(a.equityUsd);
  const free = Number(a.freeCollateralUsd);
  const used = Number.isFinite(eq) && Number.isFinite(free) ? eq - free : NaN;
  const exposure = p?.canonicalAsset ? v.exposureByAsset.find((e) => e.canonicalAsset === p.canonicalAsset) : undefined;
  return {
    venue: venueName(a.venue),
    position: p ? `${p.size} ${p.marketId.split(":").pop()}` : "no position",
    direction: p ? p.side : "n/a",
    collateral: Number.isFinite(eq) ? fmtUsd(eq) : "n/a",
    marginUsed: Number.isFinite(used) ? fmtUsd(used) : "n/a",
    marginRatio: p?.marginRatio ? p.marginRatio : Number.isFinite(used) && eq > 0 ? `${((used / eq) * 100).toFixed(2)}%` : "n/a",
    liq: p?.liqPx ? fmtPrice(p.liqPx) : "none",
    exposure: exposure ? fmtUsd(Number(exposure.grossUsd)) : p ? fmtUsd(Number(p.notionalUsd)) : "n/a",
    receipt: "check it on the verify page",
  };
}

const live = (node: ReactNode) => <div className="cap-live">{node}</div>;

export function mountQuoteWidget(el: HTMLElement, cfg: AppConfig) {
  return mount(el, live(<Providers cfg={cfg}>{<QuoteTable />}</Providers>));
}

export function mountRiskWidget(el: HTMLElement, cfg: AppConfig, onRisk: (s: RiskSummary | null) => void) {
  const focusConnect = () => document.getElementById("cap-connect")?.querySelector<HTMLElement>("button")?.focus();
  return mount(
    el,
    live(
      <Providers cfg={cfg} onConnect={focusConnect}>
        <ConnectStrip />
        <RiskPanel onLoaded={(v) => onRisk(riskSummary(v))} />
      </Providers>,
    ),
  );
}

function NotFoundPage() {
  return (
    <article className="page">
      <h1>Page not found</h1>
      <p>
        <a href="index.html">Back to the home page</a>
      </p>
    </article>
  );
}

/** docs, verify, status, legal and 404: the old site's pages inside the owner's page head and footer. */
export function mountPage(page: string, el: HTMLElement, cfg: AppConfig) {
  const body =
    page === "docs" ? (
      <ApiDocs />
    ) : page === "verify" ? (
      <Verify />
    ) : page === "status" ? (
      <Status />
    ) : page === "legal" ? (
      <Legal />
    ) : (
      <NotFoundPage />
    );
  // the verify page reads ?id= through the router: start it at this page's own URL
  return mount(
    el,
    live(
      <ConfigContext.Provider value={cfg}>
        <MemoryRouter initialEntries={[`${location.pathname}${location.search}`]}>{body}</MemoryRouter>
      </ConfigContext.Provider>,
    ),
  );
}
