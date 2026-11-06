// R7: health uses GET /; /api/v1/status (403 on both hosts) is never called.
import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIGHTER_CONFIGS } from "../src";
import { fakeLighter, json, readerFor } from "./helpers";

const s = fakeLighter("lighter-466324", { "GET /api/v1/status": () => json({ message: "Forbidden" }, 403) });
afterAll(() => s.stop());

describe("health", () => {
  test("root-health", async () => {
    const h = await readerFor(LIGHTER_CONFIGS.rh, s.url).health();
    expect(h.ok).toBe(true);
    expect(h.networkId).toBe(1);
    expect(h.ts).toBeGreaterThan(1_700_000_000);
    expect(s.hits).toEqual(["GET /"]);
    const src = join(import.meta.dir, "../src");
    for (const f of readdirSync(src).filter((x) => x.endsWith(".ts"))) expect(readFileSync(join(src, f), "utf8").includes("/api/v1/status")).toBe(false);
  });
});
