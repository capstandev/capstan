// risk-refresh (spec 9 account-reader), on demand: re-read one owner's venue accounts (5 s cache, governor 'free'
// priority inside the adapters' HTTP) and publish each snapshot read from the venue on PUBSUB.account(owner) for the
// WebSocket account channel. Aster comes only from ingested signed reads (never a server-key read).
import { PUBSUB, type JobDef, type JobDeps } from "@capstan/core";
import { dbIdentities, envAccountDeps, readAccountsDetailed, type OwnerViewDeps, type ReadAccountsDeps } from "@capstan/risk";
import type { Hex } from "@capstan/schema";

export interface RiskRefreshDeps {
  identities: OwnerViewDeps["identities"];
  accounts: ReadAccountsDeps;
  publish?: (channel: string, payload: unknown) => Promise<void>;
}

export async function runRiskRefresh(owner: Hex, d: RiskRefreshDeps): Promise<{ refreshed: number; cached: number; pending: number }> {
  const key = owner.toLowerCase();
  let refreshed = 0;
  const ids = await d.identities(owner);
  const r = await readAccountsDetailed(ids, {
    ...d.accounts,
    onRefreshed: async (s) => {
      refreshed++;
      await d.publish?.(PUBSUB.account(key), { venue: s.venue, snapshot: s });
    },
  });
  return { refreshed, cached: r.snapshots.length - refreshed, pending: r.pending.length };
}

let accounts: Promise<ReadAccountsDeps> | null = null;
export function workerAccounts(deps: JobDeps): Promise<ReadAccountsDeps> {
  return (accounts ??= envAccountDeps(process.env, { redis: deps.redis, cache: deps.cache }));
}

export const job: JobDef = {
  name: "risk-refresh",
  queue: "riskRefresh",
  concurrency: 2,
  async handler(j, deps) {
    const owner = (j.data as { owner?: unknown })?.owner;
    if (typeof owner !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error("risk-refresh: data.owner must be an address");
    if (!deps.db) throw new Error("risk-refresh needs a database");
    return runRiskRefresh(owner as Hex, { identities: dbIdentities(deps.db), accounts: await workerAccounts(deps), publish: deps.publish });
  },
};
