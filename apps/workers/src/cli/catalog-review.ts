// Catalog review CLI (DATABASE_URL):
//   bun apps/workers/src/cli/catalog-review.ts list
//   bun apps/workers/src/cli/catalog-review.ts show <equivalenceId>
//   bun apps/workers/src/cli/catalog-review.ts propose <asset> <marketId> <marketId>... --notes "..."
//   bun apps/workers/src/cli/catalog-review.ts approve <equivalenceId> --reviewer <name> --notes "..." [--override-reason "..."]
//   bun apps/workers/src/cli/catalog-review.ts reject <equivalenceId> --reviewer <name> --notes "..."
//   bun apps/workers/src/cli/catalog-review.ts executable <marketId> --reviewer <name> --notes "..." [--off]
//   bun apps/workers/src/cli/catalog-review.ts dex <venue> <dex> --reviewer <name> --notes "..." [--off]
// approve prints the contract-spec diff first and refuses on a blocking field unless --override-reason is given.
import {
  equivalenceDiffs,
  pendingReviews,
  proposeEquivalence,
  ReviewError,
  reviewEquivalence,
  rowToMarket,
  setDexExecutable,
  setExecutable,
} from "@capstan/catalog";
import { closeDb, createDb, type Db } from "@capstan/core";
import { db as schema, VenueIdSchema, type CanonicalAsset } from "@capstan/schema";
import { eq, inArray } from "drizzle-orm";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

function flags(args: string[]): { pos: string[]; opt: Record<string, string | true> } {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) opt[k] = true;
      else {
        opt[k] = v;
        i++;
      }
    } else pos.push(a);
  }
  return { pos, opt };
}

const need = (opt: Record<string, string | true>, k: string): string => {
  const v = opt[k];
  if (typeof v !== "string" || !v.trim()) throw new ReviewError(`--${k} is required`);
  return v;
};

async function printDiff(db: Db, id: string, io: CliIo): Promise<boolean> {
  const [e] = await db.select().from(schema.equivalences).where(eq(schema.equivalences.id, id));
  if (!e) throw new ReviewError(`unknown equivalence ${id}`);
  io.out(`equivalence ${e.id} ${e.canonicalAsset} status=${e.status}`);
  io.out(`markets: ${e.marketIds.join(", ")}`);
  const rows = await db.select().from(schema.markets).where(inArray(schema.markets.id, e.marketIds));
  let blocking = false;
  for (const p of equivalenceDiffs(rows.map(rowToMarket))) {
    if (!p.diffs.length) io.out(`  ${p.a} vs ${p.b}: no contract differences`);
    for (const d of p.diffs) {
      blocking ||= d.blocking;
      io.out(`  ${p.a} vs ${p.b}: ${d.field} ${JSON.stringify(d.a)} vs ${JSON.stringify(d.b)}${d.blocking ? "  BLOCKING" : ""}`);
    }
  }
  return blocking;
}

export async function runCli(args: string[], db: Db, io: CliIo = { out: console.log, err: console.error }): Promise<number> {
  const [cmd, ...rest] = args;
  const { pos, opt } = flags(rest);
  try {
    switch (cmd) {
      case "list": {
        const p = await pendingReviews(db);
        io.out(`proposed equivalences: ${p.equivalences.length}`);
        for (const e of p.equivalences) io.out(`  ${e.id} ${e.canonicalAsset} ${e.marketIds.join(", ")}`);
        io.out(`alias proposals: ${p.aliases.length}`);
        for (const a of p.aliases.slice(0, 200)) io.out(`  ${a.marketId} -> ${a.canonicalAsset} (${a.reason})`);
        if (p.aliases.length > 200) io.out(`  ... ${p.aliases.length - 200} more`);
        io.out(`dexes not reviewed: ${p.dexes.length}`);
        for (const d of p.dexes) io.out(`  ${d.venue}:${d.dex} index=${d.dexIndex} live=${d.liveMarkets} status=${d.status}`);
        return 0;
      }
      case "show":
        await printDiff(db, pos[0] ?? "", io);
        return 0;
      case "propose": {
        const [asset, ...ids] = pos;
        const id = await proposeEquivalence(db, asset as CanonicalAsset, ids, need(opt, "notes"));
        io.out(`proposed ${id}`);
        return 0;
      }
      case "approve": {
        const id = pos[0] ?? "";
        const blocking = await printDiff(db, id, io);
        const override = typeof opt["override-reason"] === "string" ? (opt["override-reason"] as string) : undefined;
        if (blocking && !override) {
          io.err("refused: a blocking contract difference needs --override-reason");
          return 1;
        }
        const r = await reviewEquivalence(db, id, "approved", need(opt, "reviewer"), need(opt, "notes"), { overrideReason: override });
        io.out(`approved ${id}; executable: ${r.executable.join(", ") || "none"}`);
        for (const n of r.notExecutable) io.out(`  not executable ${n.marketId}: ${n.why}`);
        return 0;
      }
      case "reject":
        await reviewEquivalence(db, pos[0] ?? "", "rejected", need(opt, "reviewer"), need(opt, "notes"));
        io.out(`rejected ${pos[0]}`);
        return 0;
      case "executable":
        await setExecutable(db, pos[0] ?? "", opt.off !== true, need(opt, "reviewer"), need(opt, "notes"));
        io.out(`${pos[0]} executable=${opt.off !== true}`);
        return 0;
      case "dex": {
        const venue = VenueIdSchema.parse(pos[0]);
        await setDexExecutable(db, venue, pos[1] ?? "", opt.off !== true, need(opt, "reviewer"), need(opt, "notes"));
        io.out(`${venue}:${pos[1]} executable=${opt.off !== true}`);
        return 0;
      }
      default:
        io.err("usage: catalog-review list | show <id> | propose <asset> <marketId>... --notes | approve <id> --reviewer --notes [--override-reason] | reject <id> --reviewer --notes | executable <marketId> --reviewer --notes [--off] | dex <venue> <dex> --reviewer --notes [--off]");
        return 2;
    }
  } catch (e) {
    io.err(`catalog-review: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("catalog-review: DATABASE_URL is not set");
    process.exit(2);
  }
  const db = createDb(url, { max: 2 });
  const code = await runCli(process.argv.slice(2), db);
  await closeDb(db);
  process.exit(code);
}
