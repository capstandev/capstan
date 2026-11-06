-- capstan:no-transaction
-- Reverse of 0001_timescale: drop the continuous aggregate and the retention policies. The hypertables themselves go
-- with their tables in 0000_init's down file.
DROP MATERIALIZED VIEW IF EXISTS funding_hourly CASCADE;
--> statement-breakpoint
SELECT remove_retention_policy('mark_ticks', if_exists => true);
--> statement-breakpoint
SELECT remove_retention_policy('book_snapshots', if_exists => true);
