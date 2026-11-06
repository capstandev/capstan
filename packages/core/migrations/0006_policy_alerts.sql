-- nonce and agent_refs are NOT NULL with no default, so on a table that already has rows they are added nullable,
-- backfilled from the stored policy, then set NOT NULL. A nonce repeated by one owner keeps it on the oldest row only
-- (the others get legacy:<id>), so the ap_owner_nonce unique index below can be built.
ALTER TABLE "agent_policies" ADD COLUMN "nonce" text;--> statement-breakpoint
ALTER TABLE "agent_policies" ADD COLUMN "agent_refs" text[];--> statement-breakpoint
UPDATE "agent_policies" AS ap SET
  "nonce" = CASE
    WHEN nullif(ap."policy"->>'nonce', '') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "agent_policies" AS o
      WHERE o."owner" = ap."owner" AND o."policy"->>'nonce' = ap."policy"->>'nonce' AND o."id" < ap."id"
    ) THEN ap."policy"->>'nonce'
    ELSE 'legacy:' || ap."id"
  END,
  "agent_refs" = coalesce((
    SELECT array_agg(DISTINCT a->>'agentRef' ORDER BY a->>'agentRef')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ap."policy"->'agents') = 'array' THEN ap."policy"->'agents' ELSE '[]'::jsonb END) AS a
    WHERE a->>'agentRef' IS NOT NULL
  ), '{}'::text[]);--> statement-breakpoint
ALTER TABLE "agent_policies" ALTER COLUMN "nonce" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_policies" ALTER COLUMN "agent_refs" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_policies" ADD COLUMN "issued_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_events" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "last_failure_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "ap_owner_nonce" ON "agent_policies" USING btree ("owner","nonce");--> statement-breakpoint
CREATE INDEX "ap_owner" ON "agent_policies" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "ae_dedupe" ON "alert_events" USING btree ("dedupe_key","ts");