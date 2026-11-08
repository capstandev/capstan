#!/bin/bash
# Read-only live check of a deployment (todo 47 R5, R9). Never signs, never sends. Run after the owner's go:
#   BRAND_SAFE=0x... /bin/bash ops/mainnet/live-check.sh contracts/deployments/4663.json
# RPC_URL defaults to the public Robinhood Chain mainnet RPC (reads only). Builds the contracts first so the runtime
# code is compared with this checkout's build (immutables masked), then writes .audit-grade/live-check-<UTC date>.md
# (LIVE_CHECK_OUT overrides) and exits 1 when any check fails. Next step: the audit grader in verify mode.
# macOS bash 3.2 safe.
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
root="$(cd "$here/../.." && pwd -P)"
file="${1:-}"
if [ -z "$file" ] || [ ! -f "$file" ]; then echo "usage: BRAND_SAFE=0x... live-check.sh <deployment-file>"; exit 2; fi
if [ -z "${BRAND_SAFE:-}" ]; then echo "refuse: BRAND_SAFE is not set"; exit 2; fi
FORGE="$HOME/.foundry/bin/forge"
BUN="$HOME/.bun/bin/bun"; [ -x "$BUN" ] || BUN="/opt/homebrew/bin/bun"
rpc="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
contracts="${LIVE_CHECK_CONTRACTS:-$root/contracts}"
(cd "$contracts" && "$FORGE" build >/dev/null) || { echo "fail: forge build in $contracts"; exit 1; }
set -- --file "$file" --rpc "$rpc" --safe "$BRAND_SAFE" --contracts "$contracts"
if [ -n "${LIVE_CHECK_OUT:-}" ]; then set -- "$@" --out "$LIVE_CHECK_OUT"; fi
exec "$BUN" "$here/live-check.ts" "$@"
