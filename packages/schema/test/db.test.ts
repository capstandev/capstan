// R4: no table or column name looks like key material (the only exception is webhooks.secret_hash).
import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { ALL_TABLES } from "../src/db";

const KEYISH = /private|secret|seed|mnemonic/i;
const ALLOWED = new Set(["webhooks.secret_hash"]);

describe("db schema", () => {
  test("no-key-columns", () => {
    const bad: string[] = [];
    let columns = 0;
    for (const t of Object.values(ALL_TABLES)) {
      const cfg = getTableConfig(t);
      if (KEYISH.test(cfg.name)) bad.push(cfg.name);
      for (const c of cfg.columns) {
        columns++;
        const full = `${cfg.name}.${c.name}`;
        if (KEYISH.test(c.name) && !ALLOWED.has(full)) bad.push(full);
      }
    }
    expect(columns).toBeGreaterThan(200);
    expect(bad).toEqual([]);
    // the exception really exists, so the allowlist cannot silently grow stale
    expect(getTableConfig(ALL_TABLES.webhooks).columns.map((c) => c.name)).toContain("secret_hash");
  });

  test("every spec 12 table and every added table exists", () => {
    const names = Object.values(ALL_TABLES).map((t) => getTableConfig(t).name);
    for (const n of [
      "venues", "canonical_assets", "markets", "equivalences", "funding_ticks", "mark_ticks", "book_snapshots", "delegations",
      "onboarding_sessions", "agent_policies", "order_builds", "orders", "fills", "builder_fee_accruals", "spread_plans",
      "spread_events", "risk_snapshots", "eligibility_rules", "eligibility_decisions", "declarations", "receipts",
      "receipt_roots", "api_accounts", "x402_payments", "quote_snapshots", "root_events", "service_nonces", "x402_detections",
      "credit_ledger", "lock_snapshots", "webhooks", "alert_events", "usage_daily", "kill_events", "receipt_heads", "governance_polls",
    ]) expect(names, n).toContain(n);
  });

  test("delegations never reuse an agent address; orders dedupe by payload hash", () => {
    const dg = getTableConfig(ALL_TABLES.delegations).indexes.map((i) => i.config.name);
    expect(dg).toContain("dg_agent_unique");
    const od = getTableConfig(ALL_TABLES.orders).indexes.find((i) => i.config.name === "ord_payload_unique");
    expect(od?.config.unique).toBe(true);
  });
});
