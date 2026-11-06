// R4: every landing claim has a CLAIMS.md row saying how an outsider checks it today; claims that are not live are
// absent from the page; every endpoint or tool a check names exists in the shipped API and MCP descriptions.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderPage, visibleText } from "../scripts/check-copy";
import { landingClaims, paymentRails } from "../src/copy";
import mcpTools from "../src/generated/mcp-tools.json";
import { LIVE } from "../src/live";
import { Landing } from "../src/pages/Landing";
import { Pricing } from "../src/pages/Pricing";

interface Row {
  id: string;
  claim: string;
  how: string;
  status: string;
}

export function claimsTable(md = readFileSync(join(import.meta.dir, "../CLAIMS.md"), "utf8")): Row[] {
  return md
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Id") && !l.startsWith("| ---"))
    .map((l) => {
      const c = l.slice(2, -2).split(" | ").map((x) => x.trim());
      return { id: c[0]!, claim: c[1]!, how: c[2]!, status: c[3]! };
    });
}

const OFF = { npmPublished: false, x402UsdgSettled: false, sourcePublic: false };
const ON = { npmPublished: true, x402UsdgSettled: true, sourcePublic: true };

describe("claims", () => {
  test("each-claim-checkable", () => {
    const rows = claimsTable();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.size).toBe(rows.length);

    // the page as it ships today: each claim has a live row with the same text and a real check
    const html = renderPage(createElement(Landing, { live: LIVE }));
    const ids = [...html.matchAll(/data-claim="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (const c of landingClaims(LIVE)) {
      const r = byId.get(c.id);
      expect({ id: c.id, row: !!r }).toEqual({ id: c.id, row: true });
      expect(r!.claim).toBe(c.text);
      expect(r!.status).toBe("live");
      expect(r!.how.length).toBeGreaterThan(30);
    }
    expect(ids.sort()).toEqual(landingClaims(LIVE).map((c) => c.id).sort());

    // claims about things that are not live yet stay off the page
    const notLive = rows.filter((r) => r.status === "not live").map((r) => r.id);
    expect(notLive.sort()).toEqual(["npm", "source"]);
    for (const id of notLive) expect(ids).not.toContain(id);
    const offText = visibleText(renderPage(createElement(Landing, { live: OFF })));
    expect(offText).not.toMatch(/\bnpm\b/i);
    expect(offText).not.toMatch(/open source/i);
    expect(offText).not.toMatch(/USDG/);
    expect(paymentRails(OFF)).toEqual(["USDC on Base", "USDC on Solana"]);
    expect(visibleText(renderPage(createElement(Pricing, { live: OFF })))).not.toMatch(/USDG/);
    // and appear once their switch is on
    const onIds = [...renderPage(createElement(Landing, { live: ON })).matchAll(/data-claim="([^"]+)"/g)].map((m) => m[1]);
    expect(onIds).toContain("npm");
    expect(onIds).toContain("source");
    expect(paymentRails(ON)).toContain("USDG on Robinhood Chain");
    // every claim id the code can show has a row
    for (const c of landingClaims(ON)) expect(byId.has(c.id)).toBe(true);
    // the live flags in this build are all off until their checks pass
    expect(LIVE).toEqual(OFF);

    // every endpoint and MCP tool named in a check exists
    const spec = JSON.parse(readFileSync(join(import.meta.dir, "../../apps/api/openapi.json"), "utf8")) as { paths: Record<string, Record<string, unknown>> };
    const tools = new Set((mcpTools as { tool: string }[]).map((t) => t.tool));
    for (const r of rows.filter((x) => x.status === "live")) {
      for (const m of r.how.matchAll(/`(GET|POST|DELETE) (\/v1\/[^`\s]+)`/g)) {
        const op = spec.paths[m[2]!]?.[m[1]!.toLowerCase()];
        expect({ claim: r.id, route: `${m[1]} ${m[2]}`, exists: !!op }).toEqual({ claim: r.id, route: `${m[1]} ${m[2]}`, exists: true });
      }
      for (const m of r.how.matchAll(/`(capstan_[a-z_]+)`/g)) expect({ claim: r.id, tool: m[1], exists: tools.has(m[1]!) }).toEqual({ claim: r.id, tool: m[1], exists: true });
      expect(/\/docs|\/verify|typed data|wallet|registry|repository/i.test(r.how)).toBe(true);
    }
  });
});
