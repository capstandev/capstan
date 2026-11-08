// R4: every product claim has a CLAIMS.md row saying how an outsider checks it today; claims that are not live are
// marked so; every endpoint or tool a check names exists in the shipped API and MCP descriptions.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { landingClaims, paymentRails } from "../src/copy";
import mcpTools from "../src/generated/mcp-tools.json";
import { LIVE } from "../src/live";

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

    // each product claim the code knows has a live row with the same text and a real check (the site copy itself is
    // the owner's; lines the product cannot back are listed in the private copy notes, not here)
    for (const c of landingClaims(LIVE)) {
      const r = byId.get(c.id);
      expect({ id: c.id, row: !!r }).toEqual({ id: c.id, row: true });
      expect(r!.claim).toBe(c.text);
      expect(r!.status).toBe("live");
      expect(r!.how.length).toBeGreaterThan(30);
    }
    const notLive = rows.filter((r) => r.status === "not live").map((r) => r.id);
    expect(notLive.sort()).toEqual(["npm", "source"]);
    expect(paymentRails(OFF)).toEqual(["USDC on Base", "USDC on Solana"]);
    expect(paymentRails(ON)).toContain("USDG on Robinhood Chain");
    for (const c of landingClaims(ON)) expect(byId.has(c.id)).toBe(true);
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
