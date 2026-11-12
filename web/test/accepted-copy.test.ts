// The owner's copy notes accepted on 2026-11-12 (DECISIONS 271): lines that were false about the built product are
// replaced, and must not come back in the owner's page scripts or the component bundles.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(WEB, p), "utf8");
const bundles = ["public/assets", "public/assets/supplied"].flatMap((d) =>
  readdirSync(join(WEB, d)).filter((f) => f.endsWith(".js")).map((f) => `${d}/${f}`),
);
const OWNER = ["public/bloop-views.js", "public/app.js", "public/capstan-attached-a.js", ...bundles].map(read).join("\n");

describe("accepted copy notes", () => {
  test("false claims stay gone", () => {
    const gone = [
      "Websocket fan-out", // note 1: no fan-out product
      "Priority relay lane",
      "read-only by default", // note 2: the MCP server has write tools
      "READ-ONLY BY DEFAULT",
      "HIP-3 support requires verification", // note 3: HIP-3 builder fees are on
      "Lighter is planned with no builder fee",
      "Venues planned", // note 6: four execution venues run
      "specification stage. Community", // note 8
      "Capstan is currently at specification stage",
      "Product in specification",
      "still in the specification stage",
      "PLANNED COVERAGE ACROSS VENUES", // note 9
      "planned as data-only feeds",
      "Which venues are planned?", // note 10
      "planned API, SDK and MCP", // notes 7 and 11
      "planned toolkit",
      "proposed toolkit",
      "Planned markets", // note 14
      "PLANNED VIEW", // note 16
      "planned default", // note 17
      "planned 2 bps",
    ];
    for (const s of gone) expect({ s, found: OWNER.toLowerCase().includes(s.toLowerCase()) }).toEqual({ s, found: false });
  });

  test("the owner's accepted wording is in place", () => {
    const views = read("public/bloop-views.js");
    for (const s of [
      "<li>More WebSocket subscriptions</li><li>Pro relay lane (higher order limits)</li>",
      "MCP tools for agents: reads need nothing, writes need your API key and stay inside the caps you sign.",
      "* Lighter routes carry no builder fee. Hyperliquid HIP-3 markets carry the same 2 bps as core markets.",
      "Capstan is in testing. Market data is live; trading opens at launch.",
      "<p>COVERAGE ACROSS VENUES</p>",
      "Variational and Arcus are data-only feeds.",
      "Which venues does Capstan cover?",
      "Hyperliquid (core and HIP-3), Lighter on mainnet and on Robinhood Chain, and Aster for trading; Variational and Arcus as data-only feeds.",
      "<small>LIVE VIEW</small>",
      "Estimate the builder fee at Capstan’s 2 bps default on supported venues.",
    ])
      expect({ s, found: views.includes(s) }).toEqual({ s, found: true });
    const dash = read("public/app.js");
    expect(dash).toContain("<span>Venues you can trade on</span>");
    expect(dash).toContain("<h3>Markets</h3>");
    // note 12 was rejected: the offline notice stays word for word
    expect(dash).toContain("Capstan is in the specification stage. Market data and account connections are not live.");
  });
});
