// Every page and screen with the data it needs to render statically. The copy check (scripts/check-copy.ts) and the
// claims test render this list, so copy hidden behind a live flag or behind data (the token box) is checked too.
import type { ReactNode } from "react";
import { configFromEnv, type AppConfig } from "./config";
import openapi from "./generated/openapi.json";
import mcpTools from "./generated/mcp-tools.json";
import type { LiveFlags } from "./live";
import type { ContractsJson } from "./lib/contracts";
import { ApiDocs, type McpToolRow, type OpenApiDoc } from "./pages/ApiDocs";
import { Legal } from "./pages/Legal";
import { Status } from "./pages/Status";
import { Verify } from "./pages/Verify";
import { Route, Routes } from "react-router";
import { Dashboard, DASH_NAV } from "./app/Dashboard";
import { SAMPLE_QUOTE, SAMPLE_RISK } from "./app/samples";
import { builderLine } from "./app/screens/Onboarding";
import { QuoteRows, QuoteTable } from "./app/screens/QuoteTable";
import { RiskCards } from "./app/screens/RiskPanel";
import { SessionProvider } from "./app/session";
import { FEE_FREE_UNAVAILABLE } from "./app/venues";
import { Disclaimer } from "./components/Disclaimer";
import { bookHtml, disclaimerHtml, fundingTableHtml, marketRowHtml, quoteCardsHtml, stateHtml, STATE_TEXT, tokenBoxHtml } from "./site/render";
import { marketsPanelHtml } from "./site/feature";
import { TOKEN_LINE } from "./copy";

export interface Renderable {
  name: string;
  path: string;
  element: ReactNode;
  config: AppConfig;
}

/** A contracts.json with a CPST address, so the token box copy is rendered and checked. Example values only. */
export const SAMPLE_CONTRACTS: ContractsJson = {
  generatedBy: "ops/ci/gen-deployments.ts",
  cpst: { "4663": { address: "0x00000000000000000000000000000000000000c4", symbol: "CPST", decimals: 18, supply: "1000000000" } },
};

/** The HTML the live views add to the owner's pages, rendered with sample data so the copy rules see it. */
export function liveViewHtml(): string {
  const now = Date.parse("2026-11-08T12:00:00Z");
  const book = { marketId: "hyperliquid:-:BTC", bids: [["100000", "1.5"]] as [string, string][], asks: [["100010", "2"]] as [string, string][], asOf: "2026-11-08T11:59:58Z" };
  const funding = [{ marketId: "hyperliquid:-:BTC", venue: "hyperliquid" as const, executable: true, status: "ok" as const, source: "venue", asOf: "2026-11-08T11:59:00Z", ratePerInterval: "0.0000125", intervalS: 3600, ratePerHour: "0.0000125", rateAnnualised: "0.1095", nextSettlementAt: "2026-11-08T13:00:00Z" }];
  const market = { id: "hyperliquid:-:BTC", venue: "hyperliquid", dex: null, venueSymbol: "BTC", marketType: "perp", canonicalAsset: "CR:BTC", collateralAsset: "USDC", executable: true } as never;
  return [
    stateHtml({ kind: "loading" }),
    stateHtml({ kind: "offline" }),
    stateHtml({ kind: "empty" }, "The API lists no markets yet."),
    stateHtml({ kind: "error", message: "status 503" }),
    marketRowHtml("CR:BTC", "CR:BTC perpetuals", "3 venues", { button: true }),
    fundingTableHtml(funding, now),
    bookHtml(book, now),
    quoteCardsHtml(SAMPLE_QUOTE, 24),
    marketsPanelHtml({ markets: [market], asset: "CR:BTC", funding, book }, now),
    disclaimerHtml(),
    tokenBoxHtml({ address: SAMPLE_CONTRACTS.cpst["4663"]!.address, symbol: "CPST" }, "https://robinhoodchain.blockscout.com", TOKEN_LINE),
    `<p>${STATE_TEXT.loading}</p>`,
  ].join("\n");
}

export function siteRenderables(_live: LiveFlags): Renderable[] {
  const live4663 = configFromEnv({});
  const fork = configFromEnv({ VITE_PROFILE: "fork" });
  const page = (name: string, path: string, el: ReactNode, config = live4663): Renderable => ({ name, path, element: el, config });
  return [
    page("docs", "/docs", <ApiDocs doc={openapi as unknown as OpenApiDoc} tools={mcpTools as McpToolRow[]} />),
    page("status", "/status", <Status />),
    page("verify", "/verify", <Verify />),
    page("legal", "/legal", <Legal />),
    page("quote widget", "/quotes", <SessionProvider><QuoteTable /></SessionProvider>),
    page("docs on the fork profile", "/docs", <ApiDocs doc={openapi as unknown as OpenApiDoc} tools={mcpTools as McpToolRow[]} />, fork),
    ...DASH_NAV.map((n) => page(`dashboard ${n.label}`, n.to, <Routes><Route path="/app/*" element={<Dashboard />} /></Routes>)),
    page("dashboard samples", "/app", (
      <SessionProvider>
        <QuoteRows quote={SAMPLE_QUOTE} holdHours={24} />
        <RiskCards view={SAMPLE_RISK} />
        <p>{builderLine("hyperliquid", "0.03%")}</p>
        <p>{builderLine("aster", "0.0003")}</p>
        <p>{FEE_FREE_UNAVAILABLE("hyperliquid")}</p>
        <Disclaimer />
      </SessionProvider>
    )),
    page("live views", "/markets", <div dangerouslySetInnerHTML={{ __html: liveViewHtml() }} />),
  ];
}
