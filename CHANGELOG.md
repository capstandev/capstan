# Changelog

All notable changes to this project are listed here. Dates are UTC.

## Unreleased

- Foundation: the shared schema package (spec types with the venue research amendments, zod input validators, error
  codes with HTTP statuses, a bigint fixed-point decimal, sourced chain and venue constants, the full database schema),
  and a new `packages/core` (per-role config with safe defaults, Drizzle over postgres.js, a migration runner with down
  files and a single-migrator lock, TimescaleDB hypertables, retention and the `funding_hourly` aggregate, BullMQ queue
  names and Job Schedulers, a Redis market-data cache that also publishes, monotonic ULIDs, a keystore service signer,
  one domain-separated signed-message format, and a redacting JSON logger).
- API routes and worker jobs are drop-in files found by a glob scan; a route without auth is refused at boot; tRPC on
  `/trpc`.
- CI: Postgres and Redis services with migrations, a coverage gate, 4,096 fuzz runs, a fork job that stays off without
  an RPC, slither (hash-locked), semgrep (local ruleset, image by digest), NatSpec, exact dependency pins, the
  deployment-file copy check and a key-name check for fixtures and vectors. `bunfig.toml` refuses packages younger
  than 3 days.

- Repository scaffold: Bun workspaces (apps/, packages/), Foundry contracts project, CI checks for the key-identifier
  rule and the banned-word list, local Postgres + TimescaleDB and Redis via docker compose.
