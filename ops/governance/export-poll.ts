// Export the lock snapshot at one timestamp as a CSV (owner,amount) for an advisory poll. Read-only: no on-chain
// voting, nothing is sent anywhere. Usage:
//   DATABASE_URL=postgres://... bun ops/governance/export-poll.ts --ts 2026-12-01T00:00:00.000Z --out ./poll.csv
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { closeDb, createDb } from "../../packages/core/src/index";
import { pollCsv, snapshotAt } from "../../packages/tiers/src/index";

export function parseArgs(argv: string[]): { ts: Date; out: string } {
  const get = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const ts = get("--ts");
  const out = get("--out");
  if (!ts || !out) throw new Error("usage: export-poll.ts --ts <ISO time of a lock snapshot> --out <file.csv>");
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) throw new Error("--ts must be an ISO time");
  return { ts: d, out };
}

export async function exportPoll(databaseUrl: string, ts: Date, out: string): Promise<number> {
  const db = createDb(databaseUrl, { max: 1 });
  try {
    const snaps = await snapshotAt(db, ts);
    const file = resolve(out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, pollCsv(snaps));
    return snaps.length;
  } finally {
    await closeDb(db);
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("export-poll: DATABASE_URL is required");
    process.exit(2);
  }
  const { ts, out } = parseArgs(process.argv.slice(2));
  const n = await exportPoll(url, ts, out);
  console.log(`export-poll: ${n} owners at ${ts.toISOString()} written to ${out}`);
  if (n === 0) console.log("export-poll: no snapshot rows at that time (check the --ts value against lock_snapshots.ts)");
}
