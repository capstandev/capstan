// Tracker line 84: the GitHub owner is capstandev and the domain is get-capstan.com. The old owner and domain must
// not appear in any tracked file, and the shipped defaults (web apiBase, OpenAPI server, MCP bridge, npm and MCP
// registry metadata) must name the new ones. The old names are built from parts so this file does not hold them.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const OLD = [["capstan", "xyz"].join("-"), ["capstan", "finance"].join(".")];
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const json = (rel: string) => JSON.parse(read(rel));

describe("brand names", () => {
  test("no tracked file names the old owner or domain", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean)
      .filter((f) => !f.startsWith("contracts/lib/") && f !== "bun.lock");
    const hits: string[] = [];
    for (const f of files) {
      let body: string;
      try { body = read(f); } catch { continue; }
      const low = body.toLowerCase();
      for (const o of OLD) if (low.includes(o)) hits.push(`${f}: ${o}`);
    }
    expect(hits).toEqual([]);
  });

  test("shipped defaults name get-capstan.com", () => {
    expect(read("web/src/config.ts")).toContain('"https://api.get-capstan.com/v1"');
    expect(json("apps/api/openapi.json").servers[0].url).toBe("https://api.get-capstan.com");
    expect(read("ops/release/npm/capstan-mcp/capstan-mcp.mjs")).toContain('|| "https://api.get-capstan.com/mcp"');
  });

  test("npm and MCP registry metadata name capstandev", () => {
    const server = json("ops/release/npm/capstan-mcp/server.json");
    expect(server.name).toBe("io.github.capstandev/capstan");
    expect(server.repository.url).toBe("https://github.com/capstandev/capstan");
    expect(server.websiteUrl).toBe("https://get-capstan.com/docs");
    expect(server.remotes[0].url).toBe("https://api.get-capstan.com/mcp");
    for (const p of ["capstan-mcp", "capstan-sdk"]) {
      const pkg = json(`ops/release/npm/${p}/package.json`);
      expect(pkg.repository.url).toBe("git+https://github.com/capstandev/capstan.git");
      expect(pkg.homepage).toBe("https://get-capstan.com/docs");
    }
    expect(json("ops/release/npm/capstan-mcp/package.json").mcpName).toBe(server.name);
    expect(json("ops/release/npm/capstan-sdk/package.json").bugs.url).toBe("https://github.com/capstandev/capstan/security/advisories/new");
  });
});
