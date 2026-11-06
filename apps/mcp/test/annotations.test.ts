// R6 (todo 31): markets, quote, positions and risk are read-only; build is read-only too (it signs nothing);
// submit is not read-only and not destructive.
import { describe, expect, test } from "bun:test";
import { localApi, mcp, rpc } from "./helpers";

describe("annotations", () => {
  test("hints", async () => {
    const { api } = await localApi();
    const tools = (await rpc(mcp(api), "tools/list")).body.result.tools as { name: string; annotations: Record<string, boolean> }[];
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const n of ["capstan_markets", "capstan_quote", "capstan_positions", "capstan_risk", "capstan_build_order"]) expect(by[n]!.readOnlyHint, n).toBe(true);
    expect(by.capstan_submit).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    for (const t of tools) expect(t.annotations.openWorldHint).toBe(true);
  });
});
