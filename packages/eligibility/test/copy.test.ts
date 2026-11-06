// R7: GEO_REFUSED says exactly "Not available in your region." and no string in the package (errors, descriptions,
// receipts, comments) mentions VPNs, proxies or direct-API workarounds.
import { describe, expect, test } from "bun:test";
import { errorBody } from "@capstan/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REFUSAL_TEXT, refusalBody } from "../src";

const FORBIDDEN = /\bvpns?\b|\bproxy\b|\bproxies\b|\btor\b|direct[- ]?api|\bworkarounds?\b|\bbypass(es|ing)?\b|\bcircumvent/i;
const FILES = async () => {
  const out: string[] = [];
  for (const dir of ["src"]) for await (const f of new Bun.Glob("**/*.ts").scan({ cwd: join(import.meta.dir, "..", dir) })) out.push(join(import.meta.dir, "..", dir, f));
  out.push(join(import.meta.dir, "../../../apps/api/src/routes/eligibility.routes.ts"));
  out.push(join(import.meta.dir, "../../../apps/workers/src/jobs/geo-db-refresh.job.ts"));
  out.push(join(import.meta.dir, "../../../ops/geo/README.md"));
  return out;
};

describe("copy", () => {
  test("marketing-rule", async () => {
    expect(REFUSAL_TEXT.GEO_REFUSED).toBe("Not available in your region.");
    expect(refusalBody("GEO_REFUSED")).toEqual({ error: { code: "GEO_REFUSED", message: "Not available in your region." } });
    expect(refusalBody("GEO_REFUSED", "r_1").error).toEqual({ code: "GEO_REFUSED", message: "Not available in your region.", receiptId: "r_1" });
    expect(errorBody("GEO_REFUSED").error.message).toBe("Not available in your region.");
    for (const t of Object.values(REFUSAL_TEXT)) expect(t, t).not.toMatch(FORBIDDEN);
    const files = await FILES();
    expect(files.length).toBeGreaterThanOrEqual(9);
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (FORBIDDEN.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
    // the scanner itself catches the words
    for (const w of ["use a VPN", "via proxy", "proxies", "the direct API", "a workaround", "bypass it"]) expect(FORBIDDEN.test(w), w).toBe(true);
  });
});
