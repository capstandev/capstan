// R10 (todo 32): apps/mcp/README.md lists every tool with its input and output in a table, carries the risk disclaimer
// (DECISIONS #13) and says how to sign locally; it passes the banned-word check.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findBannedWords } from "../../../ops/ci/check-banned-words";
import { allTools } from "../src/tools";

const README = readFileSync(join(import.meta.dir, "../README.md"), "utf8");

describe("README", () => {
  test("readme-table", () => {
    const rows = README.split("\n").filter((l) => l.startsWith("| `capstan_"));
    const names = rows.map((l) => /^\| `([a-z_]+)`/.exec(l)![1]);
    expect(names).toEqual(allTools().map((t) => t.name));
    for (const r of rows) expect(r.split("|").filter((c) => c.trim()).length).toBe(3); // tool, input, output
    for (const line of ["Each venue liquidates independently. Legging risk is yours.", "A trade-only key can still trade and liquidate its account.", "Not available in refused regions.", "Receipts prove what Capstan did, not venue fill quality."]) expect(README).toContain(line);
    expect(README).toContain("## Sign locally");
    expect(README).toContain("No tool accepts a key.");
    expect(findBannedWords(join(import.meta.dir, "../../..")).filter((h) => h.file === "apps/mcp/README.md")).toEqual([]);
  });
});
