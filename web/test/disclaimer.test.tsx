// R1: the disclaimer block (DECISIONS #13) renders on /, /docs, /pricing and inside every quote widget.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import openapi from "../src/generated/openapi.json";
import mcpTools from "../src/generated/mcp-tools.json";
import { DISCLAIMER } from "../src/copy";
import { ApiDocs, type McpToolRow, type OpenApiDoc } from "../src/pages/ApiDocs";
import { Landing } from "../src/pages/Landing";
import { Pricing } from "../src/pages/Pricing";
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
    // the DECISIONS #13 text, exactly
    expect(DISCLAIMER.lines).toEqual([
      "Each venue liquidates independently.",
      "Legging risk is yours.",
      "A trade-only key can still trade and liquidate its account.",
      "Not available in refused regions.",
      "Receipts prove what Capstan did, not venue fill quality.",
    ]);
    const pages = [
      { path: "/", el: <Landing /> },
      { path: "/docs", el: <ApiDocs doc={openapi as unknown as OpenApiDoc} tools={mcpTools as McpToolRow[]} /> },
      { path: "/pricing", el: <Pricing /> },
    ];
    for (const p of pages) {
      const m = await mount(p.el, { path: p.path });
      expect(m.host.querySelectorAll("[data-disclaimer]").length).toBeGreaterThanOrEqual(1);
      expectDisclaimer(m.text());
      await m.unmount();
    }
    // every quote widget imports and renders the disclaimer (the dashboard's quote table is one)
    for (const f of quoteWidgetFiles()) {
      const src = readFileSync(f, "utf8");
      expect({ file: relative(SRC, f), imports: /import \{[^}]*\bDisclaimer\b[^}]*\} from/.test(src), renders: /<Disclaimer\b/.test(src) }).toEqual({ file: relative(SRC, f), imports: true, renders: true });
    }
  });
});
