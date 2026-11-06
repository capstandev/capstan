// R9: /docs renders the generated OpenAPI file (byte for byte the apps/api/openapi.json copy) and the MCP tool table.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATED, MCP_README, OPENAPI_SOURCE, parseMcpTools, sha256, syncGenerated } from "../scripts/sync-openapi";
import openapi from "../src/generated/openapi.json";
import mcpTools from "../src/generated/mcp-tools.json";
import { ApiDocs, operations, type McpToolRow, type OpenApiDoc } from "../src/pages/ApiDocs";
import { mount, waitFor } from "./helpers";

describe("docs", () => {
  test("openapi-synced", async () => {
    const r = syncGenerated();
    const source = readFileSync(OPENAPI_SOURCE);
    const copy = readFileSync(join(GENERATED, "openapi.json"));
    expect(sha256(copy)).toBe(sha256(source));
    expect(r.openapiSha256).toBe(sha256(source));
    expect(JSON.parse(readFileSync(join(GENERATED, "openapi.sha256.json"), "utf8")).sha256).toBe(sha256(source));
    // the module the page imports is that file
    expect(openapi).toEqual(JSON.parse(source.toString("utf8")));
    expect(readFileSync(join(import.meta.dir, "../src/pages/ApiDocs.tsx"), "utf8")).toContain('import("../generated/openapi.json")');

    // the page lists every operation of the file, with its auth and price
    const doc = openapi as unknown as OpenApiDoc;
    const ops = operations(doc);
    const total = Object.values(doc.paths).reduce((n, o) => n + Object.keys(o).length, 0);
    expect(ops.length).toBe(total);
    const m = await mount(<ApiDocs />, { path: "/docs" });
    await waitFor(() => m.host.querySelector("[data-openapi-version]"), "the OpenAPI section");
    const text = m.text();
    for (const o of ops) expect(text).toContain(o.path);
    expect(text).toContain("/v1/history/funding");
    expect(text).toContain("$0.05");
    // the MCP tool table is the README's
    const tools = parseMcpTools(readFileSync(MCP_README, "utf8"));
    expect(tools.length).toBe(17);
    expect(mcpTools as McpToolRow[]).toEqual(tools);
    for (const t of tools) expect(text).toContain(t.tool);
    await m.unmount();
  });
});
