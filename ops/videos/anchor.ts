// Off camera, between two shots: close the current hour on the FORK clock and post the receipts root to the fork's
// anchor contract, so the verify page can show the root check. The chain is snapshotted first; undo() reverts it and
// drops the poster's history (as ops/fork/every-tx.ts S3 does), so the next clip's receipts anchor again.
import { closeDb, createDb, createMarketDataCache, createRedis, logger } from "../../packages/core/src/index";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorBacklog, buildAnchorContext } from "../../apps/workers/src/anchor";
import { DATABASE_URL, PORTS, REDIS_URL, revert, rhc, snapshot, STATE, warp } from "../fork/lib";

let envLoaded = false;
function loadStackEnv(): void {
  if (envLoaded) return;
  for (const f of ["stack.env", "deploy.env"]) {
    const p = join(STATE, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) process.env[m[1]!] = m[2]!;
    }
  }
  envLoaded = true;
}

export async function anchorCurrentHour(): Promise<{ status: string; undo(): Promise<void> }> {
  if (!DATABASE_URL.includes(`:${PORTS.pg}/`) || !/127\.0\.0\.1/.test(DATABASE_URL)) throw new Error("refuse: not the fork database");
  loadStackEnv();
  const hourEpoch = Math.floor(Date.now() / 3_600_000);
  const snap = await snapshot();
  const now = await rhc.getBlock();
  const need = (hourEpoch + 1) * 3600 + 5 - Number(now.timestamp);
  if (need > 0) await warp(need);
  const later = () => new Date(Math.max(Date.now(), (hourEpoch + 1) * 3_600_000 + 5_000));
  const db = createDb(DATABASE_URL);
  const redis = createRedis(REDIS_URL);
  const deps = { db, redis, cache: createMarketDataCache(redis), log: logger("videos"), now: later };
  const actx = await buildAnchorContext(deps as never);
  const posted = await anchorBacklog({ ...actx, now: later, log: deps.log, publish: (deps as { publish?: never }).publish } as never);
  const mine = (posted as { hourEpoch: number; status: string }[]).find((p) => p.hourEpoch === hourEpoch);
  return {
    status: mine?.status ?? "nothing posted",
    async undo() {
      await revert(snap);
      await db.$client`delete from receipt_roots`;
      await db.$client`delete from root_events`;
      await db.$client`delete from chain_cursors`;
      await redis.quit().catch(() => undefined);
      await closeDb(db).catch(() => undefined);
    },
  };
}
