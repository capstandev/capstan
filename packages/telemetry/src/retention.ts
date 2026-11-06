// IP retention (spec 14): no IP address beyond the country code after 7 days. Run daily by the log-retention job.
//   logs:   every JSON-lines file under the log directory (service logs, Caddy access logs, rotated copies) is
//           rewritten so records older than 7 days keep `ip_country` and lose every IP field and IP literal
//   tables: request_logs.ip is set to null after 7 days (ip_country stays); eligibility_decisions only ever stores
//           the country
import type { Db } from "@capstan/core";
import { db as schema } from "@capstan/schema";
import { and, isNotNull, lt, sql } from "drizzle-orm";
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containsIp, stripIps } from "./redact";

export const IP_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;

export type CountryLookup = (ip: string) => string | null;

function recordTimeMs(r: Record<string, unknown>): number | null {
  const t = r.ts ?? r.time ?? r.timestamp;
  if (typeof t === "string") {
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof t === "number" && Number.isFinite(t)) return t > 1e12 ? t : t * 1000; // Caddy writes unix seconds
  return null;
}

function logFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...logFiles(p));
    else if (/\.(jsonl|log)(\.\d+|-\d{8})?$/.test(n)) out.push(p);
  }
  return out.sort();
}

export interface LogRetentionResult {
  files: number;
  filesRewritten: number;
  recordsStripped: number;
}

/** Rewrite log files so records older than the cutoff hold no IP. Lines that are not JSON are scrubbed when the file is older than the cutoff. */
export function retainLogs(o: { dir: string; now: Date; days?: number; country?: CountryLookup }): LogRetentionResult {
  const cutoff = o.now.getTime() - (o.days ?? IP_RETENTION_DAYS) * DAY_MS;
  const res: LogRetentionResult = { files: 0, filesRewritten: 0, recordsStripped: 0 };
  for (const f of logFiles(o.dir)) {
    res.files++;
    const fileOld = statSync(f).mtimeMs < cutoff;
    const text = readFileSync(f, "utf8");
    let changed = false;
    const lines = text.split("\n").map((line) => {
      if (!line.trim()) return line;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        rec = undefined;
      }
      if (rec && typeof rec === "object" && !Array.isArray(rec)) {
        const t = recordTimeMs(rec as Record<string, unknown>);
        const old = t === null ? fileOld : t < cutoff;
        if (!old || !containsIp(line)) return line;
        const out = JSON.stringify(stripIps(rec as Record<string, unknown>, o.country));
        if (out !== line) {
          changed = true;
          res.recordsStripped++;
        }
        return out;
      }
      if (fileOld && containsIp(line)) {
        changed = true;
        res.recordsStripped++;
        return JSON.stringify({ msg: "[line reduced by ip retention]", ip_country: "ZZ" });
      }
      return line;
    });
    if (changed) {
      const tmp = `${f}.retention-tmp`;
      writeFileSync(tmp, lines.join("\n"), { mode: statSync(f).mode & 0o777 });
      renameSync(tmp, f);
      res.filesRewritten++;
    }
  }
  return res;
}

/** Null raw IPs older than the cutoff in every table that stores one (request_logs). */
export async function retainTables(db: Db, now: Date, days = IP_RETENTION_DAYS, country?: CountryLookup): Promise<{ requestLogs: number }> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const t = schema.requestLogs;
  let n = 0;
  if (country) {
    // fill missing countries first, row by row (the geo lookup is local and fast)
    const rows = await db.select({ id: t.id, ip: t.ip }).from(t).where(and(lt(t.ts, cutoff), isNotNull(t.ip), sql`${t.ipCountry} is null`));
    for (const r of rows) await db.update(t).set({ ipCountry: country(r.ip!) ?? "ZZ" }).where(sql`${t.id} = ${r.id}`);
  }
  const updated = await db
    .update(t)
    .set({ ip: null, ipCountry: sql`coalesce(${t.ipCountry}, 'ZZ')` })
    .where(and(lt(t.ts, cutoff), isNotNull(t.ip)))
    .returning({ id: t.id });
  n = updated.length;
  return { requestLogs: n };
}
