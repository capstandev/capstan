// Copies the generated API description (apps/api/openapi.json, written by `bun run openapi` at the repo root) and the
// MCP tool table (apps/mcp/README.md, section "Tools") into src/generated/, so /docs renders exactly what ships.
// Runs before every dev server, build and test run. Usage: bun scripts/sync-openapi.ts
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WEB_ROOT = join(import.meta.dir, "..");
export const REPO_ROOT = join(WEB_ROOT, "..");
export const OPENAPI_SOURCE = join(REPO_ROOT, "apps/api/openapi.json");
export const MCP_README = join(REPO_ROOT, "apps/mcp/README.md");
export const GENERATED = join(WEB_ROOT, "src/generated");

export interface McpTool {
  tool: string;
  input: string;
  output: string;
}

export const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The rows of the "## Tools" table in apps/mcp/README.md (backticks removed, cells trimmed). */
export function parseMcpTools(readme: string): McpTool[] {
  const lines = readme.split("\n");
  const start = lines.findIndex((l) => /^##\s+Tools\s*$/.test(l));
  if (start < 0) throw new Error("apps/mcp/README.md has no '## Tools' section");
  const rows: McpTool[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    if (!l.startsWith("|") || /^\|\s*-/.test(l) || /^\|\s*Tool\s*\|/.test(l)) continue;
    // split on pipes that are not inside backticks
    const cells: string[] = [];
    let cur = "";
    let tick = false;
    for (const ch of l.slice(1)) {
      if (ch === "`") tick = !tick;
      if (ch === "|" && !tick) {
        cells.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    const [tool, input, output] = cells.map((c) => c.replace(/`/g, ""));
    if (tool && input !== undefined && output !== undefined) rows.push({ tool, input, output });
  }
  if (!rows.length) throw new Error("the MCP tool table is empty");
  return rows;
}

export function syncGenerated(): { openapiSha256: string; tools: number } {
  mkdirSync(GENERATED, { recursive: true });
  const spec = readFileSync(OPENAPI_SOURCE);
  JSON.parse(spec.toString("utf8")); // refuse a broken file
  writeFileSync(join(GENERATED, "openapi.json"), spec);
  const tools = parseMcpTools(readFileSync(MCP_README, "utf8"));
  writeFileSync(join(GENERATED, "mcp-tools.json"), `${JSON.stringify(tools, null, 2)}\n`);
  const openapiSha256 = sha256(spec);
  writeFileSync(join(GENERATED, "openapi.sha256.json"), `${JSON.stringify({ source: "apps/api/openapi.json", sha256: openapiSha256 })}\n`);
  return { openapiSha256, tools: tools.length };
}

if (import.meta.main) {
  const r = syncGenerated();
  console.log(`sync-openapi: openapi.json sha256 ${r.openapiSha256.slice(0, 12)}, ${r.tools} MCP tools`);
}
