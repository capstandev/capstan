// Venue adapter composition for the api: every adapter package's createAdapter, wired with the governed venue HTTP
// client on this host's egress, the shared Redis market-data cache, the eligibility declaration step (todo 23), the
// policy step (todo 22), onboarding bundles from onboarding_sessions and catalog executability (todo 03).
// Route files take their adapters from here (getAdapters, killAdapters). Tests inject their own maps instead.
import { createAdapter as createHlAdapter, createHip3Gate, createHip3Hook, createHlReader, HL_MAINNET, HL_TESTNET, type LastKnownDex } from "@capstan/adapter-hyperliquid";
import { rowToMarket } from "@capstan/catalog";
import { createAdapter as createLighterAdapter, lighterConfigsFor } from "@capstan/adapter-lighter";
import { createMarketDataCache, createRedis, schema, type Db, type MarketDataCache, type Redis } from "@capstan/core";
import { declarationStep } from "@capstan/eligibility";
import { PolicyFormatError, policyTypedData, type KillAdapter } from "@capstan/policy";
import { CapstanError, venueNetwork, venueUrlOverride, type AgentPolicy, type BuildContext, type Hex, type OnboardingBundle, type OnboardingStep, type UnsignedVenuePayload, type VenueAdapter, type VenueId, type VenueIdentity } from "@capstan/schema";
import { egressIdOf, createGovernor, venueHttp, type Governor } from "@capstan/venue-client";
import { and, eq, inArray, sql } from "drizzle-orm";

/** An adapter the api builds with. Executable venues add close-all; read-only venues refuse every build. */
export type BuildAdapter = VenueAdapter & {
  buildCloseAll?(id: VenueIdentity, ctx: BuildContext & { snapshot?: null }): Promise<UnsignedVenuePayload[]>;
  /** Lighter: give back the nonce of a build refused after it was made (security r2 D2-ADP-01). */
  releaseBuild?(b: UnsignedVenuePayload): void;
};

export interface AdapterSet {
  adapters: Map<VenueId, BuildAdapter>;
  /** Onboarding bundles live in onboarding_sessions (todo 29); adapters read them back on submit. */
  bundles: { get(id: string): Promise<OnboardingBundle | null> };
}

const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

/** The stored form of a session: the bundle plus the public request facts the submit route needs. */
export const bundleOfRow = (raw: unknown): OnboardingBundle => {
  const x = raw as { bundle?: OnboardingBundle; request?: unknown } & OnboardingBundle;
  return x && typeof x === "object" && "bundle" in x && x.bundle ? x.bundle : x;
};

/** onboarding_sessions as a bundle lookup (bundles in status 'built' or being submitted). */
export function dbBundles(db: Db) {
  return {
    async get(id: string): Promise<OnboardingBundle | null> {
      const [r] = await db.select().from(schema.onboardingSessions).where(and(eq(schema.onboardingSessions.id, id), inArray(schema.onboardingSessions.status, ["built", "submitted"]))).limit(1);
      return r ? bundleOfRow(r.bundle) : null;
    },
    async put(b: OnboardingBundle): Promise<void> {
      await db.insert(schema.onboardingSessions).values({ id: b.bundleId, venue: b.venue, owner: b.owner.toLowerCase(), bundle: b, templateHash: b.templateHash, status: "built" }).onConflictDoNothing();
    },
  };
}

/** The agent_policy step for a request's policy (null without one). A policy the typed data cannot encode is INVALID_INPUT. */
export function policyStepOf(policy: unknown): OnboardingStep | null {
  if (!policy) return null;
  try {
    return { kind: "agent_policy", signer: "main_wallet", typedData: policyTypedData(policy as AgentPolicy) };
  } catch (e) {
    if (e instanceof PolicyFormatError) throw new CapstanError("INVALID_INPUT", `policy: ${e.message}`);
    throw e;
  }
}

/** Gone HIP-3 dexes from the catalog (dexes.status 'gone') with their stored markets rows. */
export async function lastKnownHlDexes(db: Db): Promise<LastKnownDex[]> {
  const gone = await db.select().from(schema.dexes).where(and(eq(schema.dexes.venue, "hyperliquid"), eq(schema.dexes.status, "gone")));
  if (!gone.length) return [];
  const rows = await db.select().from(schema.markets).where(and(eq(schema.markets.venue, "hyperliquid"), inArray(schema.markets.dex, gone.map((g) => g.dex))));
  return gone.map((g) => ({ dex: g.dex, dexIndex: g.dexIndex, markets: rows.filter((r) => r.dex === g.dex).map(rowToMarket) }));
}

/** The Hyperliquid config for this environment: the profile's hosts, or a local stand-in venue (CAPSTAN_VENUE_URL_HYPERLIQUID). */
export function hlConfigFor(env: Record<string, string | undefined>, mainnet: boolean) {
  const base = { ...(mainnet ? HL_MAINNET : HL_TESTNET), builderAddress: (env.HL_BUILDER_ADDRESS as Hex | undefined) ?? ZERO };
  const o = venueUrlOverride("hyperliquid", env);
  return o ? { ...base, infoUrl: `${o}/info`, exchangeUrl: `${o}/exchange`, wsUrl: `${o.replace(/^http/, "ws")}/ws` } : base;
}

export async function composeAdapters(env: Record<string, string | undefined>, o: { db: Db | null; redis: Redis | null; governor?: Governor; cache?: MarketDataCache }): Promise<AdapterSet> {
  // every host comes from the network profile (packages/schema networks.ts), so one profile never mixes networks
  const mainnet = venueNetwork("hyperliquid", env) === "mainnet";
  const egress = egressIdOf(env); // one label per host (D2-ADP-06)
  const gov = o.governor ?? (o.redis ? createGovernor(o.redis, egress) : (await import("@capstan/venue-client")).createMemoryGovernor(egress));
  const { memoryMarketDataCache } = await import("@capstan/core");
  const cache = o.cache ?? (o.redis ? createMarketDataCache(o.redis) : memoryMarketDataCache());
  const bundles = o.db ? dbBundles(o.db) : { get: async () => null, put: async () => undefined };
  const isExecutable = async (marketId: string) => {
    if (!o.db) return false;
    const [m] = await o.db.select({ executable: schema.markets.executable }).from(schema.markets).where(eq(schema.markets.id, marketId)).limit(1);
    return m?.executable === true;
  };
  const adapters = new Map<VenueId, BuildAdapter>();

  const hlCfg = hlConfigFor(env, mainnet);
  const hlKey = mainnet ? "hyperliquid" : "hyperliquid-testnet";
  const hlHttp = venueHttp(hlKey, hlCfg.infoUrl.replace(/\/info$/, ""), gov, { userAgent: "capstan-api" });
  // a HIP-3 dex that left perpDexs keeps its last-known markets from the catalog, so close-all still covers it (08 R12)
  const lastKnownDexes = o.db ? () => lastKnownHlDexes(o.db!) : undefined;
  const reader = createHlReader(hlCfg, hlHttp, cache, lastKnownDexes ? { lastKnownDexes } : {});
  const hip3 = createHip3Hook({ reader, gate: createHip3Gate(env), isExecutable, eqExecutionAllowed: () => env.EQ_EXECUTION_ALLOWED === "1", network: mainnet ? "Mainnet" : "Testnet" });
  adapters.set(
    "hyperliquid",
    createHlAdapter(hlCfg, {
      http: hlHttp,
      cache,
      reader,
      enabled: () => env.HL_EXECUTION !== "0",
      isExecutable,
      hip3,
      onboarding: {
        declarationStep: (req) => declarationStep(req.owner, ["hyperliquid"], Date.now()),
        policyStep: (req) => policyStepOf(req.policy),
        agentSeenBefore: async (owner, agent) => {
          if (!o.db) return false;
          const r = await o.db.select({ id: schema.delegations.id }).from(schema.delegations).where(and(eq(schema.delegations.venue, "hyperliquid"), sql`lower(${schema.delegations.agentAddress}) = ${agent.toLowerCase()}`)).limit(1);
          void owner;
          return r.length > 0;
        },
      },
      bundles,
      agentState: () => "active",
    }) as BuildAdapter,
  );
  for (const cfg of lighterConfigsFor(env)) {
    const rest = venueUrlOverride(cfg.venue, env);
    adapters.set(cfg.venue, createLighterAdapter({ config: cfg.name, gov, cache, execution: env.LIGHTER_EXECUTION === "1", ...(rest ? { rest } : {}) }) as BuildAdapter);
  }
  const aster = await import("@capstan/adapter-aster");
  const asterMainnet = venueNetwork("aster", env) === "mainnet";
  const asterCfg = aster.asterConfig(asterMainnet ? "Mainnet" : "Testnet");
  const asterHttp = venueHttp(asterMainnet ? "aster" : "aster-testnet", asterCfg.rest, gov, { userAgent: "capstan-api" });
  adapters.set(
    "aster",
    aster.createAdapter(
      { ...asterCfg, builder: (env.ASTER_BUILDER_ADDRESS as Hex | undefined) ?? ZERO, execution: aster.asterExecutionEnabled(env) },
      { http: asterHttp, cache, reader: aster.createAsterReader(asterCfg, asterHttp, cache), bundles, ...(o.redis ? { accounts: aster.redisAccountStore(o.redis) } : {}), eligibilityStep: (owner) => declarationStep(owner, ["aster"], Date.now()), ...(env.RELAY_EGRESS_IP ? { relayEgressIp: env.RELAY_EGRESS_IP } : {}) },
    ) as unknown as BuildAdapter,
  );
  const { defaultVariationalAdapter } = await import("@capstan/adapter-variational");
  const { defaultArcusAdapter } = await import("@capstan/adapter-arcus");
  adapters.set("variational", defaultVariationalAdapter({ redis: o.redis, cache, env }) as unknown as BuildAdapter);
  adapters.set("arcus", defaultArcusAdapter({ redis: o.redis, cache, env }) as unknown as BuildAdapter);
  return { adapters, bundles };
}

let shared: Promise<AdapterSet> | null = null;
let sharedDb: Db | null = null;

/** The api process's one composition, from the environment. */
export function getAdapters(): Promise<AdapterSet> {
  return (shared ??= (async () => {
    const env = process.env;
    const redis = env.REDIS_URL ? createRedis(env.REDIS_URL) : null;
    if (env.DATABASE_URL && !sharedDb) sharedDb = (await import("@capstan/core")).createDb(env.DATABASE_URL, { max: 4 });
    return composeAdapters(env, { db: sharedDb, redis });
  })());
}

/** The kill route's view of the adapters (revocations and close-alls). */
export async function killAdapters(): Promise<Map<VenueId, KillAdapter>> {
  const { adapters } = await getAdapters();
  const out = new Map<VenueId, KillAdapter>();
  for (const [v, a] of adapters) if (a.caps.execution) out.set(v, a as KillAdapter);
  return out;
}
