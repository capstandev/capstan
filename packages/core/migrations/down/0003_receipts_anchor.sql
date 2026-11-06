-- Reverse of 0003_receipts_anchor.
DROP INDEX IF EXISTS "rc_idem";
--> statement-breakpoint
ALTER TABLE "root_events" DROP COLUMN IF EXISTS "matches";
--> statement-breakpoint
ALTER TABLE "root_events" DROP COLUMN IF EXISTS "final";
--> statement-breakpoint
ALTER TABLE "root_events" DROP COLUMN IF EXISTS "block_hash";
--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN IF EXISTS "idem_key";
--> statement-breakpoint
ALTER TABLE "receipt_roots" DROP COLUMN IF EXISTS "onchain_root";
--> statement-breakpoint
ALTER TABLE "receipt_roots" DROP COLUMN IF EXISTS "status";
--> statement-breakpoint
DROP TABLE IF EXISTS "chain_cursors";
