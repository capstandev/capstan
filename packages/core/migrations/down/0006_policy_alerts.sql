-- Reverse of 0006_policy_alerts.
DROP INDEX IF EXISTS "ae_dedupe";
--> statement-breakpoint
DROP INDEX IF EXISTS "ap_owner";
--> statement-breakpoint
DROP INDEX IF EXISTS "ap_owner_nonce";
--> statement-breakpoint
ALTER TABLE "webhooks" DROP COLUMN IF EXISTS "last_failure_at";
--> statement-breakpoint
ALTER TABLE "webhooks" DROP COLUMN IF EXISTS "disabled_reason";
--> statement-breakpoint
ALTER TABLE "webhooks" DROP COLUMN IF EXISTS "consecutive_failures";
--> statement-breakpoint
ALTER TABLE "alert_events" DROP COLUMN IF EXISTS "dedupe_key";
--> statement-breakpoint
ALTER TABLE "agent_policies" DROP COLUMN IF EXISTS "issued_at";
--> statement-breakpoint
ALTER TABLE "agent_policies" DROP COLUMN IF EXISTS "agent_refs";
--> statement-breakpoint
ALTER TABLE "agent_policies" DROP COLUMN IF EXISTS "nonce";
