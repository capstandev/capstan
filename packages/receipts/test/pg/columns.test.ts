// R13: receipts store no IP, no country and no API key (column check on the table and on the stored body).
import { describe, expect, test } from "bun:test";
import { schema } from "@capstan/core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { draft } from "./draft";

const PRIVATE = /\b(ip|ip_?addr(ess)?|country|geo|api_?key|key_hash|user_?agent|email)\b/i;

describe("receipt columns", () => {
  test("no-private-columns", () => {
    for (const table of [schema.receipts, schema.receiptHeads, schema.receiptRoots, schema.rootEvents, schema.chainCursors]) {
      const cfg = getTableConfig(table);
      for (const c of cfg.columns) expect(PRIVATE.test(c.name), `${cfg.name}.${c.name}`).toBe(false);
    }
    // the stored body is the receipt: none of its fields is private either
    for (const k of Object.keys(draft(null, 1))) expect(PRIVATE.test(k.replace(/([A-Z])/g, "_$1").toLowerCase()), k).toBe(false);
    expect(PRIVATE.test("api_key")).toBe(true); // the pattern itself works
    expect(PRIVATE.test("country")).toBe(true);
  });
});
