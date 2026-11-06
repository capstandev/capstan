-- capstan:no-transaction
-- Timescale objects (spec 12). Runs statement by statement outside a shared transaction, one migrator at a time
-- (advisory lock 7419 in packages/core/src/migrate.ts), to avoid the known Timescale migration deadlocks.
-- Needs the non-OSS timescale/timescaledb image (continuous aggregates are not in the OSS build).
CREATE EXTENSION IF NOT EXISTS timescaledb;
--> statement-breakpoint
SELECT create_hypertable('funding_ticks', 'ts', chunk_time_interval => interval '1 day', if_not_exists => true);
--> statement-breakpoint
SELECT create_hypertable('mark_ticks', 'ts', chunk_time_interval => interval '6 hours', if_not_exists => true);
--> statement-breakpoint
SELECT create_hypertable('book_snapshots', 'ts', chunk_time_interval => interval '1 hour', if_not_exists => true);
--> statement-breakpoint
SELECT create_hypertable('risk_snapshots', 'ts', chunk_time_interval => interval '1 day', if_not_exists => true);
--> statement-breakpoint
SELECT add_retention_policy('book_snapshots', interval '14 days', if_not_exists => true);
--> statement-breakpoint
SELECT add_retention_policy('mark_ticks', interval '180 days', if_not_exists => true);
--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS funding_hourly WITH (timescaledb.continuous) AS
  SELECT market_id, time_bucket('1 hour', ts) AS bucket, avg(rate_per_hour) AS rate_per_hour
  FROM funding_ticks GROUP BY market_id, bucket
  WITH NO DATA;
--> statement-breakpoint
SELECT add_continuous_aggregate_policy('funding_hourly', start_offset => interval '3 days', end_offset => interval '1 hour', schedule_interval => interval '1 hour', if_not_exists => true);
