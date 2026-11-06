CREATE TABLE "agent_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"policy" jsonb NOT NULL,
	"owner_sig" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_events" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"owner_wallet" text,
	"tier" text NOT NULL,
	"credits" numeric DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "book_snapshots" (
	"ts" timestamp with time zone NOT NULL,
	"market_id" text NOT NULL,
	"bids" jsonb NOT NULL,
	"asks" jsonb NOT NULL,
	CONSTRAINT "book_snapshots_market_id_ts_pk" PRIMARY KEY("market_id","ts")
);
--> statement-breakpoint
CREATE TABLE "builder_fee_accruals" (
	"day" text NOT NULL,
	"venue" text NOT NULL,
	"builder" text NOT NULL,
	"fills" integer NOT NULL,
	"notional_usd" numeric NOT NULL,
	"fee_usd" numeric NOT NULL,
	"unmatched_fills" integer NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "builder_fee_accruals_day_venue_builder_pk" PRIMARY KEY("day","venue","builder")
);
--> statement-breakpoint
CREATE TABLE "canonical_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"class" text NOT NULL,
	"display_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"change" jsonb NOT NULL,
	"reviewer" text NOT NULL,
	"notes" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"delta" numeric NOT NULL,
	"reason" text NOT NULL,
	"ref" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "declarations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"typed_data" jsonb NOT NULL,
	"sig" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"venue" text NOT NULL,
	"owner" text NOT NULL,
	"account_index" integer,
	"agent_address" text,
	"api_key_index" integer,
	"builder_max_bps" real,
	"expires_at" timestamp with time zone,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dexes" (
	"venue" text NOT NULL,
	"dex" text NOT NULL,
	"dex_index" integer NOT NULL,
	"live_markets" integer NOT NULL,
	"status" text NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dexes_venue_dex_pk" PRIMARY KEY("venue","dex")
);
--> statement-breakpoint
CREATE TABLE "eligibility_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text,
	"agent_ref" text,
	"ip_country" text,
	"declaration_id" text,
	"venue" text,
	"rules_version" integer NOT NULL,
	"allowed" boolean NOT NULL,
	"code" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eligibility_rules" (
	"version" integer NOT NULL,
	"venue" text NOT NULL,
	"refused_countries" text[] NOT NULL,
	"kyc" text NOT NULL,
	"source" text NOT NULL,
	"source_date" text NOT NULL,
	CONSTRAINT "eligibility_rules_version_venue_pk" PRIMARY KEY("version","venue")
);
--> statement-breakpoint
CREATE TABLE "equivalences" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_asset" text NOT NULL,
	"market_ids" text[] NOT NULL,
	"status" text NOT NULL,
	"reviewer" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text,
	"venue" text NOT NULL,
	"venue_order_id" text NOT NULL,
	"px" numeric NOT NULL,
	"sz" numeric NOT NULL,
	"fee_usd" numeric NOT NULL,
	"builder_fee_usd" numeric NOT NULL,
	"ts" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funding_ticks" (
	"ts" timestamp with time zone NOT NULL,
	"market_id" text NOT NULL,
	"rate_per_interval" numeric NOT NULL,
	"interval_s" integer NOT NULL,
	"rate_per_hour" numeric NOT NULL,
	"predicted_next" numeric,
	"source" text NOT NULL,
	CONSTRAINT "funding_ticks_market_id_ts_pk" PRIMARY KEY("market_id","ts")
);
--> statement-breakpoint
CREATE TABLE "governance_polls" (
	"id" text PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"snapshot_ts" timestamp with time zone NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kill_events" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_ref" text NOT NULL,
	"owner" text NOT NULL,
	"by" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lock_snapshots" (
	"ts" timestamp with time zone NOT NULL,
	"owner" text NOT NULL,
	"amount" numeric NOT NULL,
	CONSTRAINT "lock_snapshots_owner_ts_pk" PRIMARY KEY("owner","ts")
);
--> statement-breakpoint
CREATE TABLE "mark_ticks" (
	"ts" timestamp with time zone NOT NULL,
	"market_id" text NOT NULL,
	"mark" numeric NOT NULL,
	"index" numeric,
	"oi_usd" numeric,
	CONSTRAINT "mark_ticks_market_id_ts_pk" PRIMARY KEY("market_id","ts")
);
--> statement-breakpoint
CREATE TABLE "market_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"canonical_asset" text NOT NULL,
	"status" text NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	"reviewer" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" text PRIMARY KEY NOT NULL,
	"venue" text NOT NULL,
	"dex" text,
	"venue_symbol" text NOT NULL,
	"market_type" text DEFAULT 'perp' NOT NULL,
	"canonical_asset" text,
	"collateral_asset" text NOT NULL,
	"tick_size" numeric NOT NULL,
	"lot_size" numeric NOT NULL,
	"min_notional" numeric,
	"max_leverage" real,
	"margin_modes" text[] NOT NULL,
	"funding_interval_s" integer NOT NULL,
	"funding_settle_interval_s" integer NOT NULL,
	"session_hours" jsonb,
	"oi_cap_usd" numeric,
	"builder_fee_unit" text,
	"hip3_builder_fee_supported" boolean,
	"deployer_fee_scale" numeric,
	"growth_mode" boolean,
	"venue_index" integer,
	"data_freshness" text DEFAULT 'live' NOT NULL,
	"status" text NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"venue" text NOT NULL,
	"owner" text NOT NULL,
	"bundle" jsonb NOT NULL,
	"template_hash" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_builds" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"agent_ref" text,
	"venue" text NOT NULL,
	"market_id" text NOT NULL,
	"intent" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text,
	"preview" jsonb NOT NULL,
	"eligibility_decision_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"venue" text NOT NULL,
	"market_id" text NOT NULL,
	"owner" text NOT NULL,
	"venue_order_id" text,
	"signed_payload_hash" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"builder_fee_bps" real NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"body" jsonb NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_snapshots_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "receipt_heads" (
	"owner" text PRIMARY KEY NOT NULL,
	"last_receipt_id" text NOT NULL,
	"last_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipt_roots" (
	"hour_epoch" bigint PRIMARY KEY NOT NULL,
	"root" text NOT NULL,
	"leaf_count" integer NOT NULL,
	"tx_hash" text,
	"posted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"hour_epoch" bigint NOT NULL,
	"owner" text,
	"action" text NOT NULL,
	"body" jsonb NOT NULL,
	"leaf" text NOT NULL,
	"prev_hash" text,
	"ts" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_snapshots" (
	"ts" timestamp with time zone NOT NULL,
	"owner" text NOT NULL,
	"view" jsonb NOT NULL,
	CONSTRAINT "risk_snapshots_owner_ts_pk" PRIMARY KEY("owner","ts")
);
--> statement-breakpoint
CREATE TABLE "root_events" (
	"hour_epoch" bigint PRIMARY KEY NOT NULL,
	"root" text NOT NULL,
	"leaf_count" integer NOT NULL,
	"prev_root" text,
	"tx_hash" text NOT NULL,
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_nonces" (
	"key" text NOT NULL,
	"chain_id" integer NOT NULL,
	"next_nonce" bigint NOT NULL,
	CONSTRAINT "service_nonces_key_chain_id_pk" PRIMARY KEY("key","chain_id")
);
--> statement-breakpoint
CREATE TABLE "spread_events" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"ts" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spread_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"equivalence_id" text NOT NULL,
	"plan" jsonb NOT NULL,
	"ack_sig" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"day" text NOT NULL,
	"metric" text NOT NULL,
	"value" numeric NOT NULL,
	CONSTRAINT "usage_daily_day_metric_pk" PRIMARY KEY("day","metric")
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" text PRIMARY KEY NOT NULL,
	"execution" boolean NOT NULL,
	"caps" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"url" text NOT NULL,
	"secret_hash" text NOT NULL,
	"kinds" text[] NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x402_detections" (
	"chain" text NOT NULL,
	"asset" text NOT NULL,
	"method" text NOT NULL,
	"supported" boolean NOT NULL,
	"details" jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "x402_detections_chain_asset_method_pk" PRIMARY KEY("chain","asset","method")
);
--> statement-breakpoint
CREATE TABLE "x402_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"chain" text NOT NULL,
	"asset" text NOT NULL,
	"method" text NOT NULL,
	"payer" text NOT NULL,
	"amount" numeric NOT NULL,
	"endpoint" text NOT NULL,
	"tx_hash" text,
	"status" text NOT NULL,
	"ts" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_account_id_api_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."api_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equivalences" ADD CONSTRAINT "equivalences_canonical_asset_canonical_assets_id_fk" FOREIGN KEY ("canonical_asset") REFERENCES "public"."canonical_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_aliases" ADD CONSTRAINT "market_aliases_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_venue_venues_id_fk" FOREIGN KEY ("venue") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_canonical_asset_canonical_assets_id_fk" FOREIGN KEY ("canonical_asset") REFERENCES "public"."canonical_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_build_id_order_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."order_builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spread_events" ADD CONSTRAINT "spread_events_plan_id_spread_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."spread_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ae_webhook" ON "alert_events" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "cl_account" ON "credit_ledger" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dg_agent_unique" ON "delegations" USING btree ("venue","agent_address");--> statement-breakpoint
CREATE INDEX "dg_owner" ON "delegations" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "ke_agent" ON "kill_events" USING btree ("agent_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "ma_market_asset" ON "market_aliases" USING btree ("market_id","canonical_asset");--> statement-breakpoint
CREATE UNIQUE INDEX "mk_venue_sym" ON "markets" USING btree ("venue","dex","venue_symbol");--> statement-breakpoint
CREATE INDEX "mk_canonical" ON "markets" USING btree ("canonical_asset");--> statement-breakpoint
CREATE UNIQUE INDEX "ord_payload_unique" ON "orders" USING btree ("signed_payload_hash");--> statement-breakpoint
CREATE INDEX "ord_owner" ON "orders" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "ord_venue_oid" ON "orders" USING btree ("venue","venue_order_id");--> statement-breakpoint
CREATE INDEX "rc_hour" ON "receipts" USING btree ("hour_epoch");--> statement-breakpoint
CREATE INDEX "rc_owner" ON "receipts" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "wh_owner" ON "webhooks" USING btree ("owner");