#!/bin/bash
# Shared runner for the go-live kits (macOS bash 3.2). The per-venue commands in ops/golive/<venue>/ call this with
# --kit and --network; every other argument passes through (--send, --mode, --market, --verify).
# Dry run unless --send is given AND every arming switch is set (kit.ts refuses otherwise, exit 2).
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
PATH="$HOME/.foundry/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
export PATH
BUN="${GOLIVE_BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="/opt/homebrew/bin/bun"
[ -x "$BUN" ] || { echo "refused: bun not found (set GOLIVE_BUN)"; exit 2; }
CAST="$HOME/.foundry/bin/cast"
if [ -n "${GOLIVE_OWNER:-}" ]; then
  [ -x "$CAST" ] || { echo "refused: $CAST not found (install Foundry)"; exit 2; }
  owner="$("$CAST" to-check-sum-address "$GOLIVE_OWNER" 2>/dev/null)" || { echo "refused: GOLIVE_OWNER is not an address"; exit 2; }
  GOLIVE_OWNER="$owner"
  export GOLIVE_OWNER
fi
if [ -n "${GOLIVE_PASSPHRASE_FILE:-}" ] && [ -f "$GOLIVE_PASSPHRASE_FILE" ]; then
  # GNU form first: on Linux `stat -f` is file system status and prints a block instead of failing (ops/server/lib.sh)
  mode="$(stat -c %a "$GOLIVE_PASSPHRASE_FILE" 2>/dev/null || stat -f %Lp "$GOLIVE_PASSPHRASE_FILE")"
  case "$mode" in 600|400) ;; *) echo "refused: GOLIVE_PASSPHRASE_FILE must be mode 600 or 400 (it is $mode)"; exit 2 ;; esac
fi
cd "$here/../.."
exec "$BUN" "$here/kit.ts" "$@"
