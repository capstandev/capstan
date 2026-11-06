// Database schema (Drizzle, pg-core): every spec section 12 table, plus the tables later work needs. PUBLIC data only:
// no private key, seed or mnemonic column exists anywhere (a named test checks every column name), and no table pools
// collateral across venues (invariant 3).
// Timescale hypertables, retention and the funding_hourly continuous aggregate live in a custom SQL migration
// (packages/core/migrations), because drizzle-kit does not know them.
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const tsz = (name: string) => timestamp(name, { withTimezone: true });

export const venues = pgTable("venues", {
  id: text("id").primaryKey(), // VenueId
  execution: boolean("execution").notNull(),
  caps: jsonb("caps").notNull(), // VenueCapabilities
  status: text("status").notNull().default("active"),
  updatedAt: tsz("updated_at").notNull().defaultNow(),
});

export const canonicalAssets = pgTable("canonical_assets", {
  id: text("id").primaryKey(), // 'EQ:TSLA'
  class: text("class").notNull(),
  displayName: text("display_name").notNull(),
});

export const markets = pgTable(
  "markets",
  {
    id: text("id").primaryKey(),
    venue: text("venue").notNull().references(() => venues.id),
    dex: text("dex"),
    venueSymbol: text("venue_symbol").notNull(),
    marketType: text("market_type").notNull().default("perp"), // perp | spot | other
    canonicalAsset: text("canonical_asset").references(() => canonicalAssets.id),
    collateralAsset: text("collateral_asset").notNull(),
    tickSize: numeric("tick_size").notNull(),
    lotSize: numeric("lot_size").notNull(),
    minNotional: numeric("min_notional"),
    maxLeverage: real("max_leverage"),
    marginModes: text("margin_modes").array().notNull(),
    fundingIntervalS: integer("funding_interval_s").notNull(),
    fundingSettleIntervalS: integer("funding_settle_interval_s").notNull(),
    sessionHours: jsonb("session_hours"),
    oiCapUsd: numeric("oi_cap_usd"),
    builderFeeUnit: text("builder_fee_unit"),
    hip3BuilderFeeSupported: boolean("hip3_builder_fee_supported"),
    deployerFeeScale: numeric("deployer_fee_scale"),
    growthMode: boolean("growth_mode"),
    venueIndex: integer("venue_index"), // raw universe index (HIP-3 counts delisted entries)
    assetClassHint: text("asset_class_hint"), // venue-stated class (EQ for Aster stock perps); never maps by itself
    contractMultiplier: numeric("contract_multiplier").notNull().default("1"),
    oracleSource: text("oracle_source"),
    dataFreshness: text("data_freshness").notNull().default("live"), // live | delayed
    status: text("status").notNull(), // active | reduce_only | delisted | unknown
    executable: boolean("executable").notNull().default(false),
    lastSeenAt: tsz("last_seen_at"),
    updatedAt: tsz("updated_at").notNull(),
  },
  (t) => [uniqueIndex("mk_venue_sym").on(t.venue, t.dex, t.venueSymbol), index("mk_canonical").on(t.canonicalAsset)],
);

/** Venue symbol to canonical asset proposals (spec 3 `catalog.market_aliases`). Only a review approves one. */
export const marketAliases = pgTable(
  "market_aliases",
  {
    id: text("id").primaryKey(),
    marketId: text("market_id").notNull().references(() => markets.id),
    canonicalAsset: text("canonical_asset").notNull(),
    status: text("status").notNull(), // proposed | approved | rejected
    auto: boolean("auto").notNull().default(false), // crypto-major exact-symbol rule
    reason: text("reason").notNull(),
    reviewer: text("reviewer"),
    notes: text("notes"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    reviewedAt: tsz("reviewed_at"),
  },
  (t) => [uniqueIndex("ma_market_asset").on(t.marketId, t.canonicalAsset)],
);

/** HIP-3 dexes seen in perpDexs (and their state): new dexes enter non-executable. */
export const dexes = pgTable(
  "dexes",
  {
    venue: text("venue").notNull(),
    dex: text("dex").notNull(),
    dexIndex: integer("dex_index").notNull(),
    liveMarkets: integer("live_markets").notNull(),
    status: text("status").notNull(), // active | gone
    executable: boolean("executable").notNull().default(false),
    firstSeenAt: tsz("first_seen_at").notNull(),
    lastSeenAt: tsz("last_seen_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.venue, t.dex] })],
);

/** Every reviewed change of a market's or dex's `executable` flag (who, why). Sync never writes here. */
export const catalogReviews = pgTable("catalog_reviews", {
  id: text("id").primaryKey(),
  subject: text("subject").notNull(), // market id, 'dex:<venue>:<dex>' or 'equivalence:<id>'
  change: jsonb("change").notNull(),
  reviewer: text("reviewer").notNull(),
  notes: text("notes").notNull(),
  ts: tsz("ts").notNull().defaultNow(),
});

export const equivalences = pgTable("equivalences", {
  id: text("id").primaryKey(),
  canonicalAsset: text("canonical_asset")
    .notNull()
    .references(() => canonicalAssets.id),
  marketIds: text("market_ids").array().notNull(),
  status: text("status").notNull(), // proposed | approved | rejected
  reviewer: text("reviewer"),
  notes: text("notes"),
  createdAt: tsz("created_at").notNull().defaultNow(),
  reviewedAt: tsz("reviewed_at"),
});

// Timescale hypertables (see the custom migration)
export const fundingTicks = pgTable(
  "funding_ticks",
  {
    ts: tsz("ts").notNull(),
    marketId: text("market_id").notNull(),
    ratePerInterval: numeric("rate_per_interval").notNull(),
    intervalS: integer("interval_s").notNull(),
    ratePerHour: numeric("rate_per_hour").notNull(),
    predictedNext: numeric("predicted_next"),
    source: text("source").notNull(),
  },
  (t) => [primaryKey({ columns: [t.marketId, t.ts] })],
);

export const markTicks = pgTable(
  "mark_ticks",
  {
    ts: tsz("ts").notNull(),
    marketId: text("market_id").notNull(),
    mark: numeric("mark").notNull(),
    index: numeric("index"),
    oiUsd: numeric("oi_usd"),
  },
  (t) => [primaryKey({ columns: [t.marketId, t.ts] })],
);

export const bookSnapshots = pgTable(
  "book_snapshots",
  {
    ts: tsz("ts").notNull(),
    marketId: text("market_id").notNull(),
    bids: jsonb("bids").notNull(), // top 20 levels
    asks: jsonb("asks").notNull(),
  },
  (t) => [primaryKey({ columns: [t.marketId, t.ts] })],
);

// Delegations: PUBLIC data only. No private keys exist anywhere in this schema.
export const delegations = pgTable(
  "delegations",
  {
    id: text("id").primaryKey(), // agentRef
    venue: text("venue").notNull(),
    owner: text("owner").notNull(),
    accountIndex: integer("account_index"),
    agentAddress: text("agent_address"),
    apiKeyIndex: integer("api_key_index"),
    builderMaxBps: real("builder_max_bps"),
    expiresAt: tsz("expires_at"),
    state: text("state").notNull(), // active | retired | killed
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("dg_agent_unique").on(t.venue, t.agentAddress), index("dg_owner").on(t.owner)], // never reuse
);

export const onboardingSessions = pgTable("onboarding_sessions", {
  id: text("id").primaryKey(),
  venue: text("venue").notNull(),
  owner: text("owner").notNull(),
  bundle: jsonb("bundle").notNull(),
  templateHash: text("template_hash").notNull(),
  status: text("status").notNull(),
  createdAt: tsz("created_at").notNull().defaultNow(),
});

export const agentPolicies = pgTable(
  "agent_policies",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(), // lowercased main wallet
    policy: jsonb("policy").notNull(),
    ownerSig: text("owner_sig").notNull(),
    expiresAt: tsz("expires_at").notNull(),
    revoked: boolean("revoked").notNull().default(false),
    // todo 22: a nonce is used once per owner; the latest stored policy for an agent wins (issuedAt = store time)
    nonce: text("nonce").notNull(),
    agentRefs: text("agent_refs").array().notNull(),
    issuedAt: tsz("issued_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ap_owner_nonce").on(t.owner, t.nonce), index("ap_owner").on(t.owner)],
);

export const orderBuilds = pgTable("order_builds", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  agentRef: text("agent_ref"),
  venue: text("venue").notNull(),
  marketId: text("market_id").notNull(),
  intent: jsonb("intent").notNull(),
  payload: jsonb("payload").notNull(),
  digest: text("digest"),
  preview: jsonb("preview").notNull(),
  eligibilityDecisionId: text("eligibility_decision_id").notNull(),
  expiresAt: tsz("expires_at").notNull(),
});

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    buildId: text("build_id")
      .notNull()
      .references(() => orderBuilds.id),
    venue: text("venue").notNull(),
    marketId: text("market_id").notNull(),
    owner: text("owner").notNull(),
    venueOrderId: text("venue_order_id"), // string: venue ids can exceed 2^53 - 1
    signedPayloadHash: text("signed_payload_hash").notNull(),
    mode: text("mode").notNull(), // relay | direct
    status: text("status").notNull(),
    builderFeeBps: real("builder_fee_bps").notNull(),
    submittedAt: tsz("submitted_at").notNull(),
  },
  (t) => [uniqueIndex("ord_payload_unique").on(t.signedPayloadHash), index("ord_owner").on(t.owner), index("ord_venue_oid").on(t.venue, t.venueOrderId)],
);

export const fills = pgTable("fills", {
  id: text("id").primaryKey(),
  orderId: text("order_id").references(() => orders.id),
  venue: text("venue").notNull(),
  venueOrderId: text("venue_order_id").notNull(),
  px: numeric("px").notNull(),
  sz: numeric("sz").notNull(),
  feeUsd: numeric("fee_usd").notNull(),
  builderFeeUsd: numeric("builder_fee_usd").notNull(),
  ts: tsz("ts").notNull(),
});

export const builderFeeAccruals = pgTable(
  "builder_fee_accruals",
  {
    day: text("day").notNull(),
    venue: text("venue").notNull(),
    builder: text("builder").notNull(),
    fills: integer("fills").notNull(),
    notionalUsd: numeric("notional_usd").notNull(),
    feeUsd: numeric("fee_usd").notNull(),
    unmatchedFills: integer("unmatched_fills").notNull(),
    source: text("source").notNull(), // hl_user_fills | hl_csv | aster_ledger
  },
  (t) => [primaryKey({ columns: [t.day, t.venue, t.builder] })],
);

export const spreadPlans = pgTable("spread_plans", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  equivalenceId: text("equivalence_id").notNull(),
  plan: jsonb("plan").notNull(),
  ackSig: text("ack_sig"),
  status: text("status").notNull(),
  createdAt: tsz("created_at").notNull().defaultNow(),
});

export const spreadEvents = pgTable("spread_events", {
  id: text("id").primaryKey(),
  planId: text("plan_id")
    .notNull()
    .references(() => spreadPlans.id),
  kind: text("kind").notNull(),
  data: jsonb("data").notNull(),
  ts: tsz("ts").notNull(),
});

export const riskSnapshots = pgTable(
  "risk_snapshots",
  {
    ts: tsz("ts").notNull(),
    owner: text("owner").notNull(),
    view: jsonb("view").notNull(), // RiskView: per-venue snapshots, never merged
  },
  (t) => [primaryKey({ columns: [t.owner, t.ts] })],
);

export const eligibilityRules = pgTable(
  "eligibility_rules",
  {
    version: integer("version").notNull(),
    venue: text("venue").notNull(),
    refusedCountries: text("refused_countries").array().notNull(),
    kyc: text("kyc").notNull(),
    source: text("source").notNull(),
    sourceDate: text("source_date").notNull(),
    // { refusedRegions?: ISO 3166-2[], refuseForEquity?: ISO 3166-1[], dataOnly?: boolean } (todo 23)
    extra: jsonb("extra").notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.version, t.venue] })],
);

export const eligibilityDecisions = pgTable("eligibility_decisions", {
  id: text("id").primaryKey(),
  owner: text("owner"),
  agentRef: text("agent_ref"),
  ipCountry: text("ip_country"),
  declarationId: text("declaration_id"),
  venue: text("venue"),
  rulesVersion: integer("rules_version").notNull(),
  allowed: boolean("allowed").notNull(),
  code: text("code"),
  ts: tsz("ts").notNull().defaultNow(),
});

export const declarations = pgTable("declarations", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  typedData: jsonb("typed_data").notNull(),
  sig: text("sig").notNull(),
  expiresAt: tsz("expires_at").notNull(),
});

export const receipts = pgTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    hourEpoch: bigint("hour_epoch", { mode: "number" }).notNull(),
    owner: text("owner"),
    action: text("action").notNull(),
    body: jsonb("body").notNull(),
    leaf: text("leaf").notNull(),
    prevHash: text("prev_hash"),
    ts: tsz("ts").notNull(),
    // idempotency: requestHash + ":" + (buildId ?? "-"); one receipt per request and build (todo 28)
    idemKey: text("idem_key"),
  },
  (t) => [index("rc_hour").on(t.hourEpoch), index("rc_owner").on(t.owner), uniqueIndex("rc_idem").on(t.idemKey)],
);

export const receiptRoots = pgTable("receipt_roots", {
  hourEpoch: bigint("hour_epoch", { mode: "number" }).primaryKey(),
  root: text("root").notNull(),
  leafCount: integer("leaf_count").notNull(),
  txHash: text("tx_hash"),
  postedAt: tsz("posted_at"),
  // posted | mismatch (an on-chain root differs from ours: the hour is frozen and never posted again)
  status: text("status").notNull().default("posted"),
  onchainRoot: text("onchain_root"),
});

/** Per-owner receipt hash-chain head; the receipt service row-locks it (SELECT ... FOR UPDATE). */
export const receiptHeads = pgTable("receipt_heads", {
  owner: text("owner").primaryKey(),
  lastReceiptId: text("last_receipt_id").notNull(),
  lastHash: text("last_hash").notNull(),
  updatedAt: tsz("updated_at").notNull().defaultNow(),
});

/** RootPosted events read back from the anchor contract (chunked getLogs). */
export const rootEvents = pgTable("root_events", {
  hourEpoch: bigint("hour_epoch", { mode: "number" }).primaryKey(),
  root: text("root").notNull(),
  leafCount: integer("leaf_count").notNull(),
  prevRoot: text("prev_root"),
  txHash: text("tx_hash").notNull(),
  blockNumber: bigint("block_number", { mode: "number" }).notNull(),
  logIndex: integer("log_index").notNull(),
  blockHash: text("block_hash"),
  // final once the block is at least the reorg depth deep; matches = equals receipt_roots for the hour
  final: boolean("final").notNull().default(false),
  matches: boolean("matches"),
});

/** Last block a chain reader has scanned (the RootPosted indexer). */
export const chainCursors = pgTable("chain_cursors", {
  key: text("key").primaryKey(), // e.g. 'root-indexer:46630:<anchor>'
  block: bigint("block", { mode: "number" }).notNull(),
  updatedAt: tsz("updated_at").notNull().defaultNow(),
});

export const quoteSnapshots = pgTable("quote_snapshots", {
  id: text("id").primaryKey(),
  hash: text("hash").notNull().unique(),
  body: jsonb("body").notNull(),
  ts: tsz("ts").notNull().defaultNow(),
});

/** Next nonce per service key per chain (anchor poster, facilitator hot key). */
export const serviceNonces = pgTable(
  "service_nonces",
  {
    key: text("key").notNull(), // service name, e.g. 'anchor-poster' (never key material)
    chainId: integer("chain_id").notNull(),
    nextNonce: bigint("next_nonce", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.chainId] })],
);

export const apiAccounts = pgTable("api_accounts", {
  id: text("id").primaryKey(),
  keyHash: text("key_hash").notNull(), // Capstan API key (argon2id); NOT a wallet key
  ownerWallet: text("owner_wallet"),
  tier: text("tier").notNull(), // free | payg | pro | lock
  credits: numeric("credits").notNull().default("0"),
});

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => apiAccounts.id),
    delta: numeric("delta").notNull(),
    reason: text("reason").notNull(),
    ref: text("ref"),
    ts: tsz("ts").notNull().defaultNow(),
  },
  (t) => [index("cl_account").on(t.accountId)],
);

export const x402Payments = pgTable("x402_payments", {
  id: text("id").primaryKey(),
  chain: text("chain").notNull(),
  asset: text("asset").notNull(),
  method: text("method").notNull(), // permit2 | eip3009 | spl
  payer: text("payer").notNull(),
  amount: numeric("amount").notNull(),
  endpoint: text("endpoint").notNull(),
  txHash: text("tx_hash"),
  status: text("status").notNull(),
  ts: tsz("ts").notNull(),
});

/** Runtime EIP-3009 / Permit2 detection results per chain and asset (facilitator, re-checked every 24 h). */
export const x402Detections = pgTable(
  "x402_detections",
  {
    chain: text("chain").notNull(),
    asset: text("asset").notNull(),
    method: text("method").notNull(),
    supported: boolean("supported").notNull(),
    details: jsonb("details").notNull(),
    checkedAt: tsz("checked_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chain, t.asset, t.method] })],
);

/** CPSTLock `lockedOf` snapshots (tiers and the off-chain governance poll weights). */
export const lockSnapshots = pgTable(
  "lock_snapshots",
  {
    ts: tsz("ts").notNull(),
    owner: text("owner").notNull(),
    amount: numeric("amount").notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.ts] })],
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    url: text("url").notNull(),
    secretHash: text("secret_hash").notNull(), // hash of the signing value shown once to the owner; never the value
    kinds: text("kinds").array().notNull(),
    disabled: boolean("disabled").notNull().default(false),
    createdAt: tsz("created_at").notNull().defaultNow(),
    // todo 36: disabled after 20 consecutive failed deliveries; the owner sees the reason
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    disabledReason: text("disabled_reason"),
    lastFailureAt: tsz("last_failure_at"),
  },
  (t) => [index("wh_owner").on(t.owner)],
);

export const alertEvents = pgTable(
  "alert_events",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id),
    kind: text("kind").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    ts: tsz("ts").notNull().defaultNow(),
    dedupeKey: text("dedupe_key"), // todo 36: one alert per key per window (no user data in the key beyond ids)
  },
  (t) => [index("ae_webhook").on(t.webhookId), index("ae_dedupe").on(t.dedupeKey, t.ts)],
);

export const usageDaily = pgTable(
  "usage_daily",
  {
    day: text("day").notNull(),
    metric: text("metric").notNull(),
    value: numeric("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.metric] })],
);

export const killEvents = pgTable(
  "kill_events",
  {
    id: text("id").primaryKey(),
    agentRef: text("agent_ref").notNull(),
    owner: text("owner").notNull(),
    by: text("by").notNull(), // owner | agent
    ts: tsz("ts").notNull().defaultNow(),
  },
  (t) => [index("ke_agent").on(t.agentRef)],
);

export const governancePolls = pgTable("governance_polls", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  options: jsonb("options").notNull(),
  snapshotTs: tsz("snapshot_ts").notNull(),
  status: text("status").notNull(),
});

/** Request log for api and mcp calls (rate-limit and usage reads). `ip` is kept 7 days at most, then nulled by the
 * log-retention job so only `ip_country` remains (spec 14). `client_hash` is a salted hash, never a raw key or address. */
export const requestLogs = pgTable(
  "request_logs",
  {
    id: text("id").primaryKey(),
    ts: tsz("ts").notNull().defaultNow(),
    service: text("service").notNull(), // api | mcp
    route: text("route").notNull(),
    clientHash: text("client_hash"),
    ip: text("ip"),
    ipCountry: text("ip_country"),
    status: integer("status").notNull(),
    durationMs: integer("duration_ms"),
  },
  (t) => [index("rl_ts").on(t.ts), index("rl_service_ts").on(t.service, t.ts)],
);

/** Every table, for tests and tooling. */
export const ALL_TABLES = {
  venues,
  canonicalAssets,
  markets,
  marketAliases,
  dexes,
  catalogReviews,
  equivalences,
  fundingTicks,
  markTicks,
  bookSnapshots,
  delegations,
  onboardingSessions,
  agentPolicies,
  orderBuilds,
  orders,
  fills,
  builderFeeAccruals,
  spreadPlans,
  spreadEvents,
  riskSnapshots,
  eligibilityRules,
  eligibilityDecisions,
  declarations,
  receipts,
  receiptRoots,
  receiptHeads,
  rootEvents,
  chainCursors,
  quoteSnapshots,
  serviceNonces,
  apiAccounts,
  creditLedger,
  x402Payments,
  x402Detections,
  lockSnapshots,
  webhooks,
  alertEvents,
  usageDaily,
  killEvents,
  governancePolls,
  requestLogs,
} as const;
