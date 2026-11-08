// Production wiring of RelayDeps from the relay role's config. Venue adapters here only verify and submit; their HTTP
// clients skip the governor because the pipeline itself acquires the budget with the right priority (one acquire per
// submit, never two). Aster submits are signed calls: they are wired only on the VPS (CAPSTAN_RUNNER=vps).
import { createAdapter as createHlAdapter, createHlReader, HL_MAINNET, HL_TESTNET } from "@capstan/adapter-hyperliquid";
import { createLighterAdapter, lighterConfigsFor } from "@capstan/adapter-lighter";
import { createDb, createRedis, enqueuePolicyBreach, loadConfig, memoryMarketDataCache, QUEUES, ulid, type ConfigFor, type Db, type Redis } from "@capstan/core";
import { decide } from "@capstan/eligibility";
import { activePolicyFor } from "@capstan/policy";
import { createReceiptService, pgReceiptStore, validateDraft, type ReceiptDraft } from "@capstan/receipts";
import { venueNetwork, venueUrlOverride, type Hex, type Receipt, type VenueId } from "@capstan/schema";
import { dbWalletActivity, limitsFor, tierOf, viemLockReader, type LockReader, type Tier } from "@capstan/plans";
import { tracedFetch } from "@capstan/telemetry";
import { createGovernor, egressIdOf, venueHttp, type Governor } from "@capstan/venue-client";
import { Queue, QueueEvents, Worker } from "bullmq";
import { priorityDispatcher, RELAY_MAX_OPEN_JOBS } from "./dispatch";
import { relayFlags, type SwitchableFlags } from "./flags";
import { redisKillView, type RedisKillView } from "./kill";
import { redisLaneLimiter } from "./lanes";
import { dbExposure, pgRelayStore, redisVenueSignals } from "./stores";
import type { RelayDeps, RelayVenue } from "./types";
import { asterRelayVenue, hlLookup, hlRelayVenue, lighterLookup, lighterRelayVenue, sha256Jcs } from "./venues";

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
  // hosts from the network profile (packages/schema networks.ts), the same choice the api makes
  const mainnet = venueNetwork("hyperliquid", env) === "mainnet";
  const pass = passThroughGovernor(gov);
  const out = new Map<VenueId, RelayVenue>();
  const hlBase = { ...(mainnet ? HL_MAINNET : HL_TESTNET), builderAddress: (env.HL_BUILDER_ADDRESS as Hex | undefined) ?? ZERO };
  // a local stand-in venue (fork stack) replaces the hosts; venueUrlOverride accepts loopback URLs only
  const hlUrl = venueUrlOverride("hyperliquid", env);
  const hlCfg = hlUrl ? { ...hlBase, infoUrl: `${hlUrl}/info`, exchangeUrl: `${hlUrl}/exchange`, wsUrl: `${hlUrl.replace(/^http/, "ws")}/ws` } : hlBase;
  const hlKey = mainnet ? "hyperliquid" : "hyperliquid-testnet";
  const hlHttp = venueHttp(hlKey, hlCfg.exchangeUrl.replace(/\/exchange$/, ""), pass, { userAgent: "capstan-relay", fetchImpl: tracedFetch("hyperliquid") });
  const cache = memoryMarketDataCache();
  // the pipeline checks delegation state itself; the adapter's own check would also block direct-mode claims
  const hl = createHlAdapter(hlCfg, { http: hlHttp, cache, reader: createHlReader(hlCfg, hlHttp, cache), agentState: () => "active" });
  out.set("hyperliquid", hlRelayVenue(hl, { governorKey: hlKey, lookup: hlLookup(hlHttp) }));
  for (const cfg of lighterConfigsFor(env)) {
    const venue = cfg.venue;
    const http = venueHttp(cfg.governorKey, venueUrlOverride(venue, env) ?? cfg.rest, pass, { userAgent: "capstan-relay", fetchImpl: tracedFetch(venue) });
    const a = createLighterAdapter(cfg, { http, cache: null, execution: env.LIGHTER_EXECUTION === "1" });
    out.set(venue, lighterRelayVenue(venue, a, { governorKey: cfg.governorKey, l1Of: (b) => b.owner, lookup: lighterLookup(http) }));
  }
  if (env.CAPSTAN_RUNNER === "vps") {
    const aster = await import("@capstan/adapter-aster");
    const asterMainnet = venueNetwork("aster", env) === "mainnet";
    const cfg = aster.asterConfig(asterMainnet ? "Mainnet" : "Testnet");
    const key = asterMainnet ? "aster" : "aster-testnet";
    const http = venueHttp(key, cfg.rest, pass, { userAgent: "capstan-relay", fetchImpl: tracedFetch("aster") });
    const a = aster.createAdapter({ ...cfg, builder: (env.ASTER_BUILDER_ADDRESS as Hex | undefined) ?? ZERO, execution: aster.asterExecutionEnabled(env) }, { http, cache: null, reader: aster.createAsterReader(cfg, http, null) });
    out.set("aster", asterRelayVenue(a, { governorKey: key }));
  }
  return out;
}

/** One job id per receipt draft: requestHash + buildId is the receipt service's idempotency key. */
export const receiptJobId = (d: ReceiptDraft): string => `rc-${sha256Jcs([d.requestHash, d.buildId]).slice(2, 34)}`;

/**
 * In-process receipts with a retry that outlives the request (security r1 R1-07). The first try runs inline. When it
 * fails, the draft goes on the relay-receipt-retry queue (durable in Redis, consumed by this relay with its own key,
 * retried with backoff) and the error carries the job id, so the submit answer says the receipt is pending. When
 * Redis cannot take it either, the relay retries inline in the background with backoff.
 */
export function retryingReceipts(primary: RelayDeps["receipts"], o: { enqueue?: (d: ReceiptDraft) => Promise<string>; log?: (msg: string, fields: Record<string, unknown>) => void; sleep?: (ms: number) => Promise<void>; inlineTries?: number } = {}): RelayDeps["receipts"] & { retrying(): number } {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tries = o.inlineTries ?? 10;
  let retrying = 0;
  const inline = async (d: ReceiptDraft) => {
    retrying++;
    try {
      for (let i = 0; i < tries; i++) {
        await sleep(Math.min(2_000 * 2 ** i, 60_000));
        try {
          await primary.issue(d);
          return;
        } catch {
          // try again
        }
      }
      o.log?.("receipt retry gave up", { buildId: d.buildId, requestHash: d.requestHash, action: d.action });
    } finally {
      retrying--;
    }
  };
  return {
    retrying: () => retrying,
    async issue(d) {
      try {
        return await primary.issue(d);
      } catch (e) {
        let receiptJob: string | undefined;
        if (o.enqueue) receiptJob = await o.enqueue(d).catch(() => undefined);
        if (!receiptJob) void inline(d);
        throw Object.assign(new Error(`receipt not issued yet: ${(e as Error).message}`), receiptJob ? { receiptJob } : {});
      }
    },
  };
}

/** The relay-receipt-retry queue: `enqueue` for retryingReceipts, and the worker this relay runs with its key. */
export function receiptRetryQueue(connection: Redis, o: { prefix?: string; delayMs?: number } = {}) {
  const prefix = o.prefix ?? "capstan";
  const q = new Queue(QUEUES.relayReceiptRetry, { connection, prefix });
  return {
    async enqueue(d: ReceiptDraft): Promise<string> {
      const jobId = receiptJobId(d);
      const job = await q.add("receipt-retry", { draft: d }, { jobId, delay: o.delayMs ?? 2_000, removeOnComplete: 1000, removeOnFail: 5000, attempts: 12, backoff: { type: "exponential", delay: 2_000 } });
      if (await job.isFailed().catch(() => false)) await job.retry().catch(() => undefined);
      return jobId;
    },
    worker(primary: RelayDeps["receipts"], w: { concurrency?: number } = {}) {
      return new Worker(QUEUES.relayReceiptRetry, async (job) => ({ receiptId: (await primary.issue(validateDraft((job.data as { draft?: unknown }).draft))).receiptId }), { connection: connection.duplicate(), prefix, concurrency: w.concurrency ?? 4 });
    },
    close: () => q.close(),
  };
}

/** Receipts when the relay holds no key (RECEIPT_SIGNER=none): queue for receipt-sign (refusals on receipt-sign-refusal), wait, read the stored row. */
export function queuedReceipts(connection: Redis, db: Db, o: { waitMs?: number; prefix?: string } = {}): RelayDeps["receipts"] {
  const prefix = o.prefix ?? "capstan";
  // two queues (security r1 F4): refusals, which strangers can trigger, never share worker slots with order receipts
  const lanes = {
    main: { q: new Queue(QUEUES.receiptSign, { connection, prefix }), events: new QueueEvents(QUEUES.receiptSign, { connection: connection.duplicate(), prefix }) },
    refusal: { q: new Queue(QUEUES.receiptSignRefusal, { connection, prefix }), events: new QueueEvents(QUEUES.receiptSignRefusal, { connection: connection.duplicate(), prefix }) },
  };
  const store = pgReceiptStore(db);
  return {
    async issue(d: ReceiptDraft): Promise<Receipt> {
      const { q, events } = d.action === "refusal" ? lanes.refusal : lanes.main;
      await events.waitUntilReady();
      const jobId = receiptJobId(d);
      // retried with backoff (security r1 R1-07): a slow or briefly down receipt-sign never loses the receipt
      const job = await q.add("receipt-sign", { draft: d }, { jobId, removeOnComplete: 1000, removeOnFail: 5000, attempts: 8, backoff: { type: "exponential", delay: 2000 } });
      // the same id was used before and that job gave up: run it again rather than failing for good
      if (await job.isFailed().catch(() => false)) await job.retry().catch(() => undefined);
      let out: { receiptId: string };
      try {
        out = (await job.waitUntilFinished(events, o.waitMs ?? 10_000)) as { receiptId: string };
      } catch (e) {
        throw Object.assign(new Error(`receipt-sign did not answer: ${(e as Error).message}`), { receiptJob: jobId });
      }
      const r = await store.get(out.receiptId);
      if (!r) throw Object.assign(new Error("receipt-sign returned an unknown receipt"), { receiptJob: jobId });
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
      return p && !p.revoked ? { policyId: p.policyId, policy: p.policy, ...(p.issuedAt ? { issuedAtMs: new Date(p.issuedAt).getTime() } : {}) } : null;
    },
  };
}

export interface RelayRuntime {
  deps: RelayDeps;
  flags: SwitchableFlags;
  db: Db;
  redis: Redis;
  kill: RedisKillView;
  /** Stops what the runtime started besides the submit worker (the receipt retry worker). */
  close(): Promise<void>;
}

export async function relayRuntime(cfg: ConfigFor<"relay">, env: Record<string, string | undefined> = process.env, log?: RelayDeps["log"]): Promise<RelayRuntime> {
  const db = createDb(cfg.DATABASE_URL, { max: 8 });
  const redis = createRedis(cfg.REDIS_URL);
  const bull = createRedis(cfg.REDIS_URL, { forBullmq: true });
  const governor = createGovernor(redis, egressIdOf(env)); // one label per host (D2-ADP-06)
  const kill = redisKillView(redis);
  const flags = relayFlags(env, { log: (c) => log?.("relay flag changed", { ...c }) });
  let receipts: RelayDeps["receipts"];
  let receiptRetry: ReturnType<typeof receiptRetryQueue> | undefined;
  let receiptRetryWorker: Worker | undefined;
  if (cfg.RECEIPT_SIGNER === "none") receipts = queuedReceipts(bull, db);
  else {
    const { loadServiceSignerForRole } = await import("./signer");
    const svc = createReceiptService({ db, signer: await loadServiceSignerForRole(cfg), now: () => new Date(), publish: async (ch, p) => void (await redis.publish(ch, JSON.stringify(p))) });
    const direct: RelayDeps["receipts"] = { issue: (d) => svc.issue(d) };
    // a receipt the inline try cannot issue is retried from Redis by this relay (security r1 R1-07)
    receiptRetry = receiptRetryQueue(bull);
    receiptRetryWorker = receiptRetry.worker(direct);
    receipts = retryingReceipts(direct, { enqueue: (d) => receiptRetry!.enqueue(d), ...(log ? { log } : {}) });
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
    exposure: dbExposure(db),
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
        // the shared producer: same work shape and BullMQ priority as every other alert producer (R1-8-03)
        await enqueuePolicyBreach(alertsQ, { owner: e.owner, agentRef: e.agentRef, field: e.field });
      },
    },
    // per venue budget: 8 opening jobs running (plus 8 more slots only safety jobs use) and at most 16 waiting; at most
    // RELAY_MAX_OPEN_JOBS opening jobs across all venues, so opening traffic never fills the worker (R1-02)
    dispatch: priorityDispatcher(8, { maxQueuedPerKey: 16, safetyReserve: 8, maxOpenJobs: RELAY_MAX_OPEN_JOBS }),
    now: () => Date.now(),
    id: () => ulid(),
    ...(log ? { log } : {}),
  };
  const close = async () => {
    await receiptRetryWorker?.close();
    await receiptRetry?.close();
  };
  return { deps, flags, db, redis, kill, close };
}

/** CPSTLock reader for lock tiers: the shared reader (packages/tiers lockReaderFromEnv), the same one the api uses. */
async function lockReaderFromEnv(env: Record<string, string | undefined>): Promise<LockReader> {
  const { lockReaderFromEnv: shared } = await import("@capstan/plans");
  return shared(env);
}

export function relayConfig(): ConfigFor<"relay"> {
  return loadConfig("relay");
}
