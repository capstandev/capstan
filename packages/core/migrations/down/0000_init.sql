-- Reverse of 0000_init: drop every table it created (CASCADE drops their indexes, foreign keys and hypertable chunks).
DROP TABLE IF EXISTS "x402_payments" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "x402_detections" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "webhooks" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "venues" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "usage_daily" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "spread_plans" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "spread_events" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "service_nonces" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "root_events" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "risk_snapshots" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "receipts" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "receipt_roots" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "receipt_heads" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "quote_snapshots" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "orders" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "order_builds" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "onboarding_sessions" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "markets" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "market_aliases" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "mark_ticks" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "lock_snapshots" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "kill_events" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "governance_polls" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "funding_ticks" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "fills" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "equivalences" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "eligibility_rules" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "eligibility_decisions" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "dexes" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "delegations" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "declarations" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "credit_ledger" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "catalog_reviews" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "canonical_assets" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "builder_fee_accruals" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "book_snapshots" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "api_accounts" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "alert_events" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_policies" CASCADE;
