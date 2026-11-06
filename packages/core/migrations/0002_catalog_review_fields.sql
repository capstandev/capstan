ALTER TABLE "markets" ADD COLUMN "asset_class_hint" text;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "contract_multiplier" numeric DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "oracle_source" text;