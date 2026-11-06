// Every page and screen with the data it needs to render statically. The copy check (scripts/check-copy.ts) and the
// claims test render this list, so copy hidden behind a live flag or behind data (the token box) is checked too.
import type { ReactNode } from "react";
import { configFromEnv, type AppConfig } from "./config";
import openapi from "./generated/openapi.json";
import mcpTools from "./generated/mcp-tools.json";
import type { LiveFlags } from "./live";
import type { ContractsJson } from "./lib/contracts";
import { ApiDocs, type McpToolRow, type OpenApiDoc } from "./pages/ApiDocs";
import { Landing } from "./pages/Landing";
import { Legal } from "./pages/Legal";
import { NotFound } from "./pages/NotFound";
import { Pricing } from "./pages/Pricing";
import { Status } from "./pages/Status";
import { Verify } from "./pages/Verify";
import { Layout } from "./components/Layout";
import { Route, Routes } from "react-router";
import { Dashboard, DASH_NAV } from "./app/Dashboard";
import { SAMPLE_QUOTE, SAMPLE_RISK } from "./app/samples";
import { builderLine } from "./app/screens/Onboarding";
import { QuoteRows } from "./app/screens/QuoteTable";
import { RiskCards } from "./app/screens/RiskPanel";
import { SessionProvider } from "./app/session";
import { FEE_FREE_UNAVAILABLE } from "./app/venues";

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

export function siteRenderables(live: LiveFlags): Renderable[] {
  const live4663 = configFromEnv({});
  const fork = configFromEnv({ VITE_PROFILE: "fork" });
  const page = (name: string, path: string, el: ReactNode, config = live4663): Renderable => ({ name, path, element: <Layout>{el}</Layout>, config });
  return [
    page("landing", "/", <Landing live={live} />),
    page("landing with token box", "/", <Landing live={live} contracts={SAMPLE_CONTRACTS} />),
    page("docs", "/docs", <ApiDocs doc={openapi as unknown as OpenApiDoc} tools={mcpTools as McpToolRow[]} />),
    page("pricing", "/pricing", <Pricing live={live} />),
    page("status", "/status", <Status />),
    page("verify", "/verify", <Verify />),
    page("legal", "/legal", <Legal />),
    page("not found", "/nope", <NotFound />),
    page("landing on the fork profile", "/", <Landing live={live} />, fork),
    ...DASH_NAV.map((n) => page(`dashboard ${n.label}`, n.to, <Routes><Route path="/app/*" element={<Dashboard />} /></Routes>)),
    page("dashboard samples", "/app", (
      <SessionProvider>
        <QuoteRows quote={SAMPLE_QUOTE} holdHours={24} />
        <RiskCards view={SAMPLE_RISK} />
        <p>{builderLine("hyperliquid", "0.03%")}</p>
        <p>{builderLine("aster", "0.0003")}</p>
        <p>{FEE_FREE_UNAVAILABLE("hyperliquid")}</p>
      </SessionProvider>
    )),
  ];
}
