CREATE TABLE "chain_cursors" (
	"key" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipt_roots" ADD COLUMN "status" text DEFAULT 'posted' NOT NULL;--> statement-breakpoint
ALTER TABLE "receipt_roots" ADD COLUMN "onchain_root" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "idem_key" text;--> statement-breakpoint
ALTER TABLE "root_events" ADD COLUMN "block_hash" text;--> statement-breakpoint
ALTER TABLE "root_events" ADD COLUMN "final" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "root_events" ADD COLUMN "matches" boolean;--> statement-breakpoint
CREATE UNIQUE INDEX "rc_idem" ON "receipts" USING btree ("idem_key");