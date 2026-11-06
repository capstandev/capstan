-- Reverse of 0002_catalog_review_fields.
ALTER TABLE "markets" DROP COLUMN IF EXISTS "asset_class_hint";
--> statement-breakpoint
ALTER TABLE "markets" DROP COLUMN IF EXISTS "contract_multiplier";
--> statement-breakpoint
ALTER TABLE "markets" DROP COLUMN IF EXISTS "oracle_source";
