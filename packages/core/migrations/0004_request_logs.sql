CREATE TABLE "request_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"service" text NOT NULL,
	"route" text NOT NULL,
	"client_hash" text,
	"ip" text,
	"ip_country" text,
	"status" integer NOT NULL,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE INDEX "rl_ts" ON "request_logs" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "rl_service_ts" ON "request_logs" USING btree ("service","ts");