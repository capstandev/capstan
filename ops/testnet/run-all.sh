#!/bin/bash
# Runs every testnet-gated suite in dependency order (todo 41), skipping suites whose wallets are unfunded, and appends
# a "Run N" section to docs/reports/testnet-run-<date>.md. Testnets only. Safe to run twice: the second run skips
# contracts already deployed and reuses the wallets. Exit 1 when any suite fails (waiting suites do not fail the run).
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
BUN="${TESTNET_BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="/opt/homebrew/bin/bun"
cd "$here/../.."
exec "$BUN" "$here/run-all.ts" "$@"
