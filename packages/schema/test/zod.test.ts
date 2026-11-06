// No zod input schema has a field named like a key; the schemas accept spec-shaped input and refuse float amounts.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { API_INPUT_SCHEMAS, OrderIntentZ, QuoteRequestZ } from "../src/zod";

const KEYISH = /private_?key|secret|seed|mnemonic|api_?secret|passphrase/i;

function fieldNames(s: z.ZodType, out: string[] = [], depth = 0): string[] {
  if (depth > 10) return out;
  const def = (s as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  const t = def.type as string;
  if (t === "object") {
    for (const [k, v] of Object.entries(def.shape as Record<string, z.ZodType>)) {
      out.push(k);
      fieldNames(v, out, depth + 1);
    }
  } else if (t === "array") fieldNames(def.element as z.ZodType, out, depth + 1);
  else if (t === "optional" || t === "nullable" || t === "default" || t === "readonly" || t === "nonoptional" || t === "catch" || t === "prefault") fieldNames(def.innerType as z.ZodType, out, depth + 1);
  else if (t === "union") for (const o of def.options as z.ZodType[]) fieldNames(o, out, depth + 1);
  else if (t === "pipe") {
    fieldNames(def.in as z.ZodType, out, depth + 1);
    fieldNames(def.out as z.ZodType, out, depth + 1);
  }
  return out;
}

describe("zod input schemas", () => {
  test("no key-like field anywhere", () => {
    let total = 0;
    for (const [route, schema] of Object.entries(API_INPUT_SCHEMAS)) {
      const names = fieldNames(schema as z.ZodType);
      total += names.length;
      for (const n of names) expect(`${route}.${n}`).not.toMatch(KEYISH);
    }
    expect(total).toBeGreaterThan(80);
    expect(Object.keys(API_INPUT_SCHEMAS).length).toBeGreaterThanOrEqual(27);
  });

  test("quote and intent", () => {
    expect(QuoteRequestZ.safeParse({ canonicalAsset: "CR:BTC", side: "buy", sizeBase: "0.1", leverage: 2, holdHours: 8, orderType: "market" }).success).toBe(true);
    expect(QuoteRequestZ.safeParse({ canonicalAsset: "CR:BTC", side: "buy", sizeBase: 0.1, leverage: 2, holdHours: 8, orderType: "market" }).success).toBe(false); // float amount
    expect(QuoteRequestZ.safeParse({ side: "buy", sizeBase: "1", leverage: 2, holdHours: 8, orderType: "market" }).success).toBe(false);
    expect(QuoteRequestZ.safeParse({ canonicalAsset: "CR:BTC", side: "buy", sizeBase: "1", notionalUsd: "5", leverage: 2, holdHours: 8, orderType: "market" }).success).toBe(false);
    const intent = { marketId: "hyperliquid:xyz:TSLA", side: "sell", size: "2", type: "limit", limitPx: "250.5", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 };
    expect(OrderIntentZ.safeParse(intent).success).toBe(true);
    expect(OrderIntentZ.safeParse({ ...intent, limitPx: undefined }).success).toBe(false);
    expect(OrderIntentZ.safeParse({ ...intent, size: "0" }).success).toBe(false);
  });
});
