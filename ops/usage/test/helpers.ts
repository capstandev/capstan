// Test helpers: a migrated throwaway database per file (skips without DATABASE_URL) and UsageDay fixtures.
import { closeDb, createDb, createTempDatabase, type Db } from "@capstan/core";
import { describe } from "bun:test";
import type { UsageDay } from "../usage";

export const dbDescribe = process.env.DATABASE_URL ? describe : describe.skip;
export const HOOK_TIMEOUT_MS = 30_000;

export async function freshDb(): Promise<{ db: Db; drop(): Promise<void> }> {
  const t = await createTempDatabase(process.env.DATABASE_URL!, { migrated: true, prefix: "capstan_usage" });
  const db = createDb(t.url, { max: 4 });
  return {
    db,
    async drop() {
      await closeDb(db);
      await t.drop();
    },
  };
}

/** A UsageDay with zeros, overridden by `o`. */
export function usageDay(day: string, o: Partial<UsageDay> & { notional?: Partial<UsageDay["routedNotionalUsd"]> } = {}): UsageDay {
  return {
    day,
    approvals: o.approvals ?? { hl: 0, aster: 0, union: 0 },
    routedNotionalUsd: { hl: "0", aster: "0", lighter304: "0", lighterRh: "0", ...(o.routedNotionalUsd ?? {}), ...(o.notional ?? {}) },
    builderFeeUsd: o.builderFeeUsd ?? { hl: "0", aster: "0" },
    x402: o.x402 ?? { payments: 0, usd: "0", byRail: {} },
    mcp: o.mcp ?? { calls: 0, uniqueClients: 0 },
    visitors: o.visitors ?? null,
    refusals: o.refusals ?? {},
    ...(o.approvalsDb !== undefined ? { approvalsDb: o.approvalsDb } : {}),
    ...(o.approvalsFlagged !== undefined ? { approvalsFlagged: o.approvalsFlagged } : {}),
  };
}

/** Deterministic address-shaped test values (public, not keys). */
export const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as `0x${string}`;
