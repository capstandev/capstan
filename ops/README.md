# ops

- `ci/`: invariant checks run by CI and the pre-commit hook (key identifiers in `apps/`, banned words).
- `alerts/`: `GLOSSARY.md`, every ops alert cause in plain words (the `ops-alerts` worker refuses unknown causes), and
  the stand-in Telegram Bot API the alert, announce and team bot tests use.
- `teambot/`: the free team Telegram bot (commands, owner-only pause and resume, requests), Python stdlib, systemd.
- `runbooks/`: what a person does when something breaks (`incident.md`, `relay-stop.md`) and who to contact, by role.
- `deploy/`: the contract deploy to Robinhood Chain (`deploy-rhc.sh`) and the read-only `post-deploy-check.sh`.
- `dashboards/`: Grafana dashboard and Prometheus scrape config for the `/metrics` endpoints.
- `server/`: VPS scripts (provision, service keys, systemd units, Caddy, backups, deploy and rollback) with their
  container tests (`bash ops/server/test/run-all.sh`).
- `usage/`: daily usage, the go/no-go thresholds report and the monthly fee split (`bun ops/usage/report.ts`,
  `bun ops/usage/fee-split.ts`).
- `release/`: the release runner for the hourly update queue (gate, deploy with auto-rollback, public copy, GitHub
  Release, team post; arming guards, preflight), npm package metadata for `capstan-sdk` and `capstan-mcp`, and their
  sandboxed tests (`bash ops/release/test/run-all.sh`).
- `testnet/`: testnet wallets (`make-wallets.sh`, `make-wallets-vps.sh` for Aster on the VPS), the read-only
  `doctor.sh`, the testnet brand Safe (`make-safe.sh`) and `run-all.sh`, which runs every testnet-gated suite whose
  wallets are funded. Testnets only; every sender asserts its network first (`bun test ops/testnet`).
- `uptime/`: the outside uptime monitors (`monitors.json`, the free-account click-path in `README.md`) and
  `check.sh`, which probes the same URLs and prints PASS or FAIL (`bun test ops/uptime` runs it on a local stack).
