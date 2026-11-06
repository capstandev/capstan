// Production wiring of RelayDeps from the relay role's config. Venue adapters here only verify and submit; their HTTP
// clients skip the governor because the pipeline itself acquires the budget with the right priority (one acquire per
// submit, never two). Aster submits are signed calls: they are wired only on the VPS (CAPSTAN_RUNNER=vps).
import { createAdapter as createHlAdapter, createHlReader, HL_MAINNET, HL_TESTNET } from "@capstan/adapter-hyperliquid";
import { createLighterAdapter, lighterConfig, type LighterConfigName } from "@capstan/adapter-lighter";
import { createDb, createRedis, loadConfig, memoryMarketDataCache, QUEUES, ulid, type ConfigFor, type Db, type Redis } from "@capstan/core";
import { decide } from "@capstan/eligibility";
import { activePolicyFor } from "@capstan/policy";
import { createReceiptService, pgReceiptStore, type ReceiptDraft } from "@capstan/receipts";
import type { Hex, Receipt, VenueId } from "@capstan/schema";
import { dbWalletActivity, limitsFor, tierOf, viemLockReader, type LockReader, type Tier } from "@capstan/plans";
import { createGovernor, venueHttp, type Governor } from "@capstan/venue-client";
import { Queue, QueueEvents } from "bullmq";
import { priorityDispatcher } from "./dispatch";
import { relayFlags, type SwitchableFlags } from "./flags";
import { redisKillView, type RedisKillView } from "./kill";
import { redisLaneLimiter } from "./lanes";
import { pgRelayStore, redisVenueSignals } from "./stores";
import type { RelayDeps, RelayVenue } from "./types";
import { asterRelayVenue, hlRelayVenue, lighterRelayVenue, sha256Jcs } from "./venues";

/** A governor that grants at once but forwards venue feedback (429, 418, used-weight) to the real one. */
export function passThroughGovernor(real: Governor): Governor {
  return {
    egress: real.egress,
    acquire: async (venue, cost, o) => ({ venue, cost, at: Date.now(), priority: o?.priority ?? "free" }),
    observe: (v, r) => real.observe(v, r),
    usage: (v) => real.usage(v),
    flush: () => real.flush(),
  };
}

const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

export async function relayVenues(env: Record<string, string | undefined>, gov: Governor): Promise<Map<VenueId, RelayVenue>> {
  const mainnet = env.CAPSTAN_NETWORK === "mainnet";
  const pass = passThroughGovernor(gov);
  const out = new Map<VenueId, RelayVenue>();
  const hlCfg = { ...(mainnet ? HL_MAINNET : HL_TESTNET), builderAddress: (env.HL_BUILDER_ADDRESS as Hex | undefined) ?? ZERO };
  const hlKey = mainnet ? "hyperliquid" : "hyperliquid-testnet";
  const hlHttp = venueHttp(hlKey, hlCfg.exchangeUrl.replace(/\/exchange$/, ""), pass, { userAgent: "capstan-relay" });
  const cache = memoryMarketDataCache();
  // the pipeline checks delegation state itself; the adapter's own check would also block direct-mode claims
  const hl = createHlAdapter(hlCfg, { http: hlHttp, cache, reader: createHlReader(hlCfg, hlHttp, cache), agentState: () => "active" });
  out.set("hyperliquid", hlRelayVenue(hl, { governorKey: hlKey }));
  for (const [venue, name] of [["lighter-mainnet", mainnet ? "mainnet" : "mainnetTestnet"], ["lighter-rh", mainnet ? "rh" : "rhTestnet"]] as const) {
    const cfg = lighterConfig(name as LighterConfigName);
    const http = venueHttp(cfg.governorKey, cfg.rest, pass, { userAgent: "capstan-relay" });
    const a = createLighterAdapter(cfg, { http, cache: null, execution: env.LIGHTER_EXECUTION === "1" });
    out.set(venue, lighterRelayVenue(venue, a, { governorKey: cfg.governorKey, l1Of: (b) => b.owner }));
  }
  if (env.CAPSTAN_RUNNER === "vps") {
    const aster = await import("@capstan/adapter-aster");
    const net = mainnet ? "Mainnet" : "Testnet";
    const cfg = aster.asterConfig(net);
    const key = mainnet ? "aster" : "aster-testnet";
    const http = venueHttp(key, cfg.rest, pass, { userAgent: "capstan-relay" });
    const a = aster.createAdapter({ ...cfg, builder: (env.ASTER_BUILDER_ADDRESS as Hex | undefined) ?? ZERO, execution: aster.asterExecutionEnabled(env) }, { http, cache: null, reader: aster.createAsterReader(cfg, http, null) });
    out.set("aster", asterRelayVenue(a, { governorKey: key }));
  }
  return out;
}

/** Receipts when the relay holds no key (RECEIPT_SIGNER=none): queue for receipt-sign, wait, read the stored row. */
export function queuedReceipts(connection: Redis, db: Db, o: { waitMs?: number; prefix?: string } = {}): RelayDeps["receipts"] {
  const prefix = o.prefix ?? "capstan";
  const q = new Queue(QUEUES.receiptSign, { connection, prefix });
  const events = new QueueEvents(QUEUES.receiptSign, { connection: connection.duplicate(), prefix });
  const store = pgReceiptStore(db);
  return {
    async issue(d: ReceiptDraft): Promise<Receipt> {
      await events.waitUntilReady();
      const job = await q.add("receipt-sign", { draft: d }, { jobId: `rc-${sha256Jcs([d.requestHash, d.buildId]).slice(2, 34)}`, removeOnComplete: 1000, removeOnFail: 5000 });
      const out = (await job.waitUntilFinished(events, o.waitMs ?? 10_000)) as { receiptId: string };
      const r = await store.get(out.receiptId);
      if (!r) throw new Error("receipt-sign returned an unknown receipt");
      return r;
    },
  };
}

/** Active policy lookup (todo 22 store): the newest unrevoked, unexpired policy naming the agent. */
export function dbPolicySource(db: Db): RelayDeps["policy"] {
  return {
    async active(agentRef, owner) {
      // the newest policy naming the agent wins; an expired one stays in force so checkPolicy refuses (fail closed)
      const p = await activePolicyFor(db, agentRef, owner);
      return p && !p.revoked ? { policyId: p.policyId, policy: p.policy } : null;
    },
  };
}

export interface RelayRuntime {
  deps: RelayDeps;
  flags: SwitchableFlags;
  db: Db;
  redis: Redis;
  kill: RedisKillView;
}

export async function relayRuntime(cfg: ConfigFor<"relay">, env: Record<string, string | undefined> = process.env, log?: RelayDeps["log"]): Promise<RelayRuntime> {
  const db = createDb(cfg.DATABASE_URL, { max: 8 });
  const redis = createRedis(cfg.REDIS_URL);
  const bull = createRedis(cfg.REDIS_URL, { forBullmq: true });
  const governor = createGovernor(redis, cfg.RELAY_EGRESS_ID);
  const kill = redisKillView(redis);
  const flags = relayFlags(env, { log: (c) => log?.("relay flag changed", { ...c }) });
  let receipts: RelayDeps["receipts"];
  if (cfg.RECEIPT_SIGNER === "none") receipts = queuedReceipts(bull, db);
  else {
    const { loadServiceSignerForRole } = await import("./signer");
    const svc = createReceiptService({ db, signer: await loadServiceSignerForRole(cfg), now: () => new Date(), publish: async (ch, p) => void (await redis.publish(ch, JSON.stringify(p))) });
    receipts = { issue: (d) => svc.issue(d) };
  }
  const alertsQ = new Queue(QUEUES.alertsDispatch, { connection: bull, prefix: "capstan" });
  const { getGeoLookup } = await import("./geo");
  const geo = await getGeoLookup(env);
  const activity = dbWalletActivity(db);
  const lock: LockReader = await lockReaderFromEnv(env);
  const deps: RelayDeps = {
    store: pgRelayStore(db),
    kill,
    policy: dbPolicySource(db),
    eligibility: (i) => decide(i, { geo, db, now: () => new Date() }),
    venueSignals: redisVenueSignals(redis),
    lanes: redisLaneLimiter(redis),
    async laneOf(owner, apiKeyId) {
      let tier: Tier = "free";
      let newWallet = false;
      try {
        const t = await tierOf(apiKeyId ? { apiKeyId, owner } : { owner }, { db, lock, cacheTtlMs: 60_000, activity });
        tier = t.tier;
        newWallet = t.newWallet;
      } catch {
        tier = "free";
      }
      const l = limitsFor(tier, { newWallet });
      // RELAY_FREE_ORDERS_PER_MIN sets the free base (2); lock tiers scale it the same way the tier table does
      const perMin = l.relayLane === "free" ? Math.max(1, Math.floor((l.relayOrdersPerMinPerWallet * cfg.RELAY_FREE_ORDERS_PER_MIN) / 2)) : l.relayOrdersPerMinPerWallet;
      return { lane: l.relayLane, perMin };
    },
    governor,
    venues: await relayVenues(env, governor),
    receipts,
    flags,
    alerts: {
      async policyBreach(e) {
        // same work shape as the alerts-dispatch producers (apps/workers/src/alerts/producers.ts)
        await alertsQ.add("alerts-dispatch", { source: "policy_breach", owner: e.owner.toLowerCase(), agentRef: e.agentRef, field: e.field }, { removeOnComplete: 1000, removeOnFail: 5000 });
      },
    },
    dispatch: priorityDispatcher(8),
    now: () => Date.now(),
    id: () => ulid(),
    ...(log ? { log } : {}),
  };
  return { deps, flags, db, redis, kill };
}

/** CPSTLock reader for lock tiers: the RHC RPC and the deployed lock, or none (every wallet reads as unlocked). */
async function lockReaderFromEnv(env: Record<string, string | undefined>): Promise<LockReader> {
  const none: LockReader = { lockedOf: async () => ({ amount: 0n, unlockAt: 0n }) };
  const rpc = env.RHC_RPC_URL;
  const lockAddr = env.CPST_LOCK_ADDRESS as Hex | undefined;
  if (!rpc || !lockAddr) return none;
  const { createPublicClient, http } = await import("viem");
  return viemLockReader(createPublicClient({ transport: http(rpc) }), lockAddr);
}

export function relayConfig(): ConfigFor<"relay"> {
  return loadConfig("relay");
}
