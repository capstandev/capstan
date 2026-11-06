// R3 (todo 31): every tool description and field description passes the banned-word check (the 01 checker also lexes
// apps/mcp source); no description mentions VPNs, proxies or workarounds (spec 10 marketing rule).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { findBannedWords } from "../../../ops/ci/check-banned-words";
import { bannedIn, copyOf } from "./lint-helpers";
import { TOOLS_V1 } from "../src/tools";

describe("copy", () => {
  test("banned", () => {
    const texts = copyOf(TOOLS_V1);
    expect(texts.length).toBeGreaterThan(TOOLS_V1.length);
    expect(bannedIn(texts)).toEqual([]);
    expect(bannedIn(["Use a VPN to reach it"])).toHaveLength(1); // the check does catch one
    // the repo-wide checker finds nothing in apps/mcp
    expect(findBannedWords(join(import.meta.dir, "../../..")).filter((h) => h.file.startsWith("apps/mcp/"))).toEqual([]);
  });
});
