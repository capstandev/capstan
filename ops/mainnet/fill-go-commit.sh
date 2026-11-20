#!/bin/bash
# Fills the one mainnet go change from the deployment record (offline: files only; never signs, sends or commits).
#   /bin/bash ops/mainnet/fill-go-commit.sh contracts/deployments/4663.json
# The owner's deploy (ops/deploy/deploy-rhc.sh mainnet) writes contracts/deployments/4663.json in his checkout; pass
# that file (or a copy of it). Run it AFTER `live-check: PASS` (ops/mainnet/live-check.sh), on the go branch.
# It writes: the record, its generated copies (schema TS, web/public/contracts.json, README and SECURITY tables) and
# the SDK mainnet anchor pin (packages/sdk/src/pins.json networks.mainnet.anchor.address). Then it runs the offline
# checks of those files. It refuses a record that is not chain 4663, lacks a contract, is not Sourcify verified
# (--allow-unverified overrides), or whose anchor poster is not POSTER_ADDRESS of ops/mainnet/inputs.conf.
# A second argument is another repo root (the tests use it); the checkout checks then do not run.
# macOS bash 3.2 safe.
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
root="$(cd "$here/../.." && pwd -P)"
BUN="$HOME/.bun/bin/bun"; [ -x "$BUN" ] || BUN="/opt/homebrew/bin/bun"
"$BUN" "$here/fill-go-commit.ts" "$@"
other=""
for a in "$@"; do case "$a" in --*) ;; *) other="$a" ;; esac; done
if [ "$#" -ge 2 ] && [ "$other" != "$1" ] && [ "$(cd "$other" && pwd -P)" != "$root" ]; then
  echo "fill-go-commit: other root, checkout checks skipped"; exit 0
fi
cd "$root"
"$BUN" ops/ci/check-deployments.ts
"$BUN" packages/sdk/scripts/gen-pins.ts --check
"$BUN" ops/mainnet/env-review.ts --strict | tail -1
echo "fill-go-commit: done. Next: git status, bun run check, web tests, one signed commit, then the queue rebuild (r10)."
