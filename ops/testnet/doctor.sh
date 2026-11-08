#!/bin/bash
# Testnet doctor: one line per wallet need (address, network, balance, what is missing, which BACKLOG item).
# Read-only, public data only; never opens a keystore or a password file. Writes ~/.capstan-testnet/doctor.json.
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
BUN="${TESTNET_BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="/opt/homebrew/bin/bun"
exec "$BUN" "$here/doctor.ts" "$@"
