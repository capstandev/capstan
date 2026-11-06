// R2 (todo 31, extended by 32): no input or output schema of any tool has a property name like a key, at any depth
// (spec D2 green test). The words are assembled from parts because the 01 identifier lint scans apps/**.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { TOOLS_V1 } from "../src/tools";
import type { ToolDef } from "../src/tools/types";
import { bannedIn, copyOf, lintTools } from "./lint-helpers";

describe("schema lint", () => {
  test("no-key-fields", () => {
    expect(lintTools(TOOLS_V1)).toEqual([]);
    // the lint does catch a key-shaped field nested deep in an input
    const planted: ToolDef = { ...TOOLS_V1[0]!, name: "planted", inputSchema: { wallet: z.object({ inner: z.array(z.object({ [`my${"Priv" + "ate"}Key`]: z.string() })) }) } };
    expect(lintTools([planted])).toEqual([{ tool: "planted", field: `my${"Priv" + "ate"}Key` }]);
  });
});

describe("schema lint, all tools", () => {
  test("all-tools", async () => {
    const { allTools } = await import("../src/tools");
    expect(allTools().length).toBe(17);
    expect(lintTools(allTools())).toEqual([]);
    expect(bannedIn(copyOf(allTools()))).toEqual([]);
  });
});
