// R1: the disclaimer block (DECISIONS #13) is on the home page, docs, pricing, the dashboard and inside every quote
// widget. On the owner's pages src/site/decorate.ts adds it; the docs page and the quote widgets render it themselves.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import openapi from "../src/generated/openapi.json";
import mcpTools from "../src/generated/mcp-tools.json";
import { configFromEnv } from "../src/config";
import { DISCLAIMER } from "../src/copy";
import { ApiDocs, type McpToolRow, type OpenApiDoc } from "../src/pages/ApiDocs";
import { decorate, DISCLAIMER_PAGES } from "../src/site/decorate";
import { quoteCardsHtml } from "../src/site/render";
import { SAMPLE_QUOTE } from "../src/app/samples";
import { mount } from "./helpers";

const SRC = join(import.meta.dir, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Source files that render a quote: a component file whose name says Quote. */
export function quoteWidgetFiles(): string[] {
  return walk(SRC).filter((f) => /Quote[A-Za-z]*\.tsx$/.test(f));
}

function expectDisclaimer(text: string) {
  for (const l of DISCLAIMER.lines) expect(text).toContain(l);
}

describe("disclaimer", () => {
  test("present-everywhere", async () => {
    expect(DISCLAIMER.lines).toEqual([
      "Each venue liquidates independently.",
      "Legging risk is yours.",
      "A trade-only key can still trade and liquidate its account.",
      "Not available in refused regions.",
      "Receipts prove what Capstan did, not venue fill quality.",
    ]);
    for (const p of ["index", "pricing", "dashboard", "quotes"]) expect(DISCLAIMER_PAGES.has(p)).toBe(true);
    const cfg = configFromEnv({});
    // an owner page: once, at the end of main
    document.body.innerHTML = `<main class="bl-page"><section class="bl-hero"></section><section class="bl-section bl-end"></section></main>`;
    decorate(cfg, "index");
    decorate(cfg, "index");
    expect(document.querySelectorAll("[data-disclaimer]").length).toBe(1);
    expectDisclaimer(document.body.textContent ?? "");
    // the dashboard: right after the view content
    document.body.innerHTML = `<div class="dash-shell"><main class="dash-main"><div id="dash-content"></div><div class="dash-bottom"></div></main></div>`;
    decorate(cfg, "dashboard");
    expect(document.querySelector("#dash-content + [data-disclaimer]")).not.toBeNull();
    // a page without the rule gets none
    document.body.innerHTML = `<main class="bl-page"></main>`;
    decorate(cfg, "about");
    expect(document.querySelector("[data-disclaimer]")).toBeNull();
    document.body.innerHTML = "";

    // the docs page renders it itself, once
    const m = await mount(<ApiDocs doc={openapi as unknown as OpenApiDoc} tools={mcpTools as McpToolRow[]} />, { path: "/docs" });
    expect(m.host.querySelectorAll("[data-disclaimer]").length).toBe(1);
    expectDisclaimer(m.text());
    await m.unmount();
    // every React quote widget imports and renders the disclaimer
    for (const f of quoteWidgetFiles()) {
      const src = readFileSync(f, "utf8");
      expect({ file: relative(SRC, f), imports: /import \{[^}]*\bDisclaimer\b[^}]*\} from/.test(src), renders: /<Disclaimer\b/.test(src) }).toEqual({ file: relative(SRC, f), imports: true, renders: true });
    }
    // the quote cards on the quotes page sit on a page that carries it
    expect(quoteCardsHtml(SAMPLE_QUOTE, 24)).toContain("data-quote-cards");
  });
});
