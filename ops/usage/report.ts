// Usage report: `bun ops/usage/report.ts <from> <to> [--launch YYYY-MM-DD]` (UTC days, launch day also from
// LAUNCH_DAY). Prints a plain table and writes out/usage/<to>.md. Counts and amounts only: no address, account index
// or IP is ever printed (a scan refuses the output otherwise).
import { closeDb, createDb, type Db } from "@capstan/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, assertDay, daysBetween, killCriteria, readDays, runRate, type UsageDay, type Verdict } from "./usage";

const IDENTIFIER = /0x[0-9a-fA-F]{40}|\b(?:\d{1,3}\.){3}\d{1,3}\b|account[_ ]?index/i;

export function assertNoIdentifiers(text: string): void {
  const m = IDENTIFIER.exec(text);
  if (m) throw new Error(`usage report: refusing output with an identifier (${m[0].slice(0, 6)}...)`);
}

const cell = (s: string | number) => String(s);

export function renderReport(from: string, to: string, days: UsageDay[], launchDay: string | null): string {
  const by = new Map(days.map((d) => [d.day, d]));
  const head = ["day", "approvals hl", "aster", "union", "db", "flagged", "notional hl", "aster", "lighter 304", "lighter rh", "fee hl", "fee aster", "x402 n", "x402 usd", "mcp calls", "mcp clients", "api requests", "api clients", "visitors", "refusals"];
  const lines = [`# Capstan usage ${from} to ${to}`, "", `| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const day of daysBetween(from, to)) {
    const d = by.get(day);
    if (!d) {
      lines.push(`| ${day} | ${head.slice(1).map(() => "no data").join(" | ")} |`);
      continue;
    }
    const refusals = Object.values(d.refusals).reduce((a, b) => a + b, 0);
    lines.push(
      `| ${[day, d.approvals.hl, d.asterApprovalsRead === false ? "not read (VPS)" : d.approvals.aster, d.approvals.union, d.approvalsDb ?? "n/a", d.approvalsFlagged ?? "n/a", d.routedNotionalUsd.hl, d.routedNotionalUsd.aster, d.routedNotionalUsd.lighter304, d.routedNotionalUsd.lighterRh, d.builderFeeUsd.hl, d.builderFeeUsd.aster, d.x402.payments, d.x402.usd, d.mcp.calls, d.mcp.uniqueClients, d.api.requests, d.api.uniqueClients, d.visitors ?? "n/a", refusals].map(cell).join(" | ")} |`,
    );
  }
  const flagged = days.filter((d) => (d.approvalsFlagged ?? 0) > 0);
  if (flagged.length) lines.push("", `Flag: on ${flagged.length} day(s) our database lists delegations the venue does not confirm as approved; they are not counted.`);
  const rr = runRate(days, to);
  lines.push("", `Run-rate (7 days ending ${to}, x 30 / 7): total $${rr.total} a month; hl $${rr.perVenue.hl}, aster $${rr.perVenue.aster}, lighter 304 $${rr.perVenue.lighter304}, lighter rh $${rr.perVenue.lighterRh} (Lighter routes at 0 fee)${rr.daysFound < 7 ? `; ${7 - rr.daysFound} of the 7 days have no data` : ""}.`);
  lines.push("", "## Go/no-go thresholds", "");
  if (!launchDay) lines.push("Launch day not set (LAUNCH_DAY or --launch): checks not evaluated.");
  else {
    const v = killCriteria(days, launchDay);
    const row = (name: string, x: Verdict) => `- ${name}: ${x.pass === null ? "not reached" : x.pass ? "PASS" : "FAIL"} (${x.metric} ${x.value ?? "n/a"}, needs ${x.threshold}; ${x.note})`;
    lines.push(row(`Day 14 (${addDays(launchDay, 14)})`, v.day14), row(`Day 30 (${addDays(launchDay, 30)})`, v.day30), row(`Day 60 (${addDays(launchDay, 60)})`, v.day60));
  }
  const text = lines.join("\n") + "\n";
  assertNoIdentifiers(text);
  return text;
}

export async function writeReport(db: Db, from: string, to: string, launchDay: string | null, outDir = "out/usage"): Promise<{ text: string; file: string }> {
  assertDay(from);
  assertDay(to);
  if (from > to) throw new Error("usage report: from is after to");
  if (launchDay) assertDay(launchDay);
  // the run-rate needs the 6 days before `from` as well
  const days = await readDays(db, addDays(from, -6), to);
  const text = renderReport(from, to, days, launchDay);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${to}.md`);
  writeFileSync(file, text);
  return { text, file };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const li = args.indexOf("--launch");
  const launch = li >= 0 ? (args[li + 1] ?? null) : (process.env.LAUNCH_DAY ?? null);
  const [from, to] = args.filter((a, i) => a !== "--launch" && (li < 0 || i !== li + 1));
  if (!from || !to) {
    console.error("usage: bun ops/usage/report.ts <from YYYY-MM-DD> <to YYYY-MM-DD> [--launch YYYY-MM-DD]");
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("usage report: DATABASE_URL is not set");
    process.exit(1);
  }
  const db = createDb(url, { max: 2 });
  try {
    const r = await writeReport(db, from, to, launch);
    console.log(r.text);
    console.log(`wrote ${r.file}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    await closeDb(db);
  }
}
