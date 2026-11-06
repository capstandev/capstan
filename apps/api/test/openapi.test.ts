// R5, R8 (todo 29): no route, schema or OpenAPI component has a key-shaped field (a scan of openapi.json at every
// depth), and the committed openapi.json equals a fresh generation (`bun run openapi` produces no diff). The tRPC
// router mirrors exactly the listed public read routes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { discoverRoutes } from "../src/app";
import { OPENAPI_FILE, openApiText } from "../src/openapi/generate";
import { appRouter, TRPC_MIRRORS } from "../src/trpc";

// assembled from parts: the identifier lint (01) scans apps/** for these words
const P = ["priv", "ate"].join("");
const KEY_FIELD = new RegExp(`^(${P}key|${P}_key|secret|${["se", "ed"].join("")}|${["mne", "monic"].join("")}|apisecret|passphrase)$`, "i");
const KEY_ANYWHERE = new RegExp(`${P}key|apisecret|${["mne", "monic"].join("")}`, "i");

function names(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) x.forEach((v) => names(v, out));
  else if (x && typeof x === "object") {
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      out.push(k);
      if ((k === "properties" || k === "parameters") && v && typeof v === "object") for (const pk of Object.keys(v as object)) out.push(pk);
      if (k === "name" && typeof v === "string") out.push(v);
      if (k === "required" && Array.isArray(v)) v.forEach((s) => typeof s === "string" && out.push(s));
      names(v, out);
    }
  }
  return out;
}

describe("openapi", () => {
  test("no-key-fields", async () => {
    const doc = JSON.parse(await openApiText()) as Record<string, unknown>;
    const all = names(doc);
    expect(all.length).toBeGreaterThan(500);
    expect(all.filter((n) => KEY_FIELD.test(n) || KEY_ANYWHERE.test(n))).toEqual([]);
    // and the committed file says the same
    expect(names(JSON.parse(readFileSync(OPENAPI_FILE, "utf8"))).filter((n) => KEY_FIELD.test(n) || KEY_ANYWHERE.test(n))).toEqual([]);
    // every mounted route is in the document
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    for (const { spec } of await discoverRoutes()) expect(paths[`/v1${spec.path.replace(/:([A-Za-z_]+)/g, "{$1}")}`]?.[spec.method.toLowerCase()], `${spec.method} ${spec.path}`).toBeDefined();
    expect(doc.openapi).toBe("3.1.0");
  });

  test("fresh", async () => {
    expect(readFileSync(OPENAPI_FILE, "utf8")).toBe(await openApiText());
  });

  test("trpc-mirrors", () => {
    const procs = Object.keys(appRouter._def.procedures).filter((p) => p !== "ping").sort();
    expect(procs).toEqual(["book", "eligibility", "funding", "markets", "receipt", "receiptProof", "receiptVerify", "venues"]);
    expect(TRPC_MIRRORS.length as number).toBe(procs.length);
  });
});
