# ops

- `ci/`: invariant checks run by CI and the pre-commit hook (key identifiers in `apps/`, banned words).
- `alerts/`: `GLOSSARY.md`, every ops alert cause in plain words (the `ops-alerts` worker refuses unknown causes).
- `runbooks/`: what a person does when something breaks (`incident.md`, `relay-stop.md`) and who to contact, by role.
- `deploy/`: the contract deploy to Robinhood Chain (`deploy-rhc.sh`) and the read-only `post-deploy-check.sh`.
- `dashboards/`: Grafana dashboard and Prometheus scrape config for the `/metrics` endpoints.
- `server/`: VPS scripts (provision, service keys, systemd units, Caddy, backups, deploy and rollback) with their
  container tests (`bash ops/server/test/run-all.sh`).
- `usage/`: daily usage, the go/no-go thresholds report and the monthly fee split (`bun ops/usage/report.ts`,
  `bun ops/usage/fee-split.ts`).
