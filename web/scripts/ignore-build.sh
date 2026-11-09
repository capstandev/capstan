#!/bin/sh
# Vercel ignoreCommand (vercel.json). Exit 0 skips the build, exit 1 builds. Vercel runs it from web/ (the project's
# Root Directory) in a shallow clone, before install, so it uses only sh and git and never fails on a missing base:
# no previous deployment, a previous sha the clone does not hold, or any git error all mean "build".
# WATCH is every path the web build reads: web/ itself plus scripts/build-inputs.ts's list (test/vercel.test.ts keeps
# the two equal). Paths are relative to the repository root.
WATCH="web apps/api apps/relay apps/api/openapi.json apps/mcp/README.md packages/adapters/aster packages/adapters/hyperliquid packages/adapters/lighter packages/core packages/eligibility packages/policy packages/receipts packages/schema packages/sdk packages/signers/aster packages/signers/hl packages/signers/lighter-wasm packages/spreads packages/telemetry packages/tiers packages/venue-client .githooks/public-guard.denylist tsconfig.base.json package.json bun.lock"

base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$base" ]; then
  echo "ignore-build: no previous deployment sha, building"
  exit 1
fi
top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "ignore-build: not a git checkout, building"; exit 1; }
if ! git -C "$top" cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "ignore-build: ${base} is not in this clone (shallow), building"
  exit 1
fi
# shellcheck disable=SC2086 # WATCH is a list of paths
git -C "$top" diff --quiet "$base" HEAD -- $WATCH
rc=$?
if [ "$rc" -eq 0 ]; then
  echo "ignore-build: nothing the site reads changed since ${base}, skipping"
  exit 0
fi
[ "$rc" -eq 1 ] && echo "ignore-build: site inputs changed since ${base}, building" || echo "ignore-build: git diff failed (${rc}), building"
exit 1
