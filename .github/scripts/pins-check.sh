#!/usr/bin/env bash
# Fails when a workflow step is not pinned: every `uses:` must be a full 40-hex commit sha (local ./ paths excepted),
# every container image (`image:`, `docker://`, `container:`) must carry @sha256:<64 hex>, and every pip install in
# the workflows must be hash-locked (--require-hashes).
set -euo pipefail
cd "$(dirname "$0")/../.."
fail=0
while IFS= read -r line; do
  f="${line%%:*}"; rest="${line#*:}"
  ref="$(sed -E 's/^[[:space:]-]*uses:[[:space:]]*//; s/[[:space:]]+#.*$//' <<<"$rest")"
  case "$ref" in ./*) continue ;; esac
  if ! grep -Eq '@[0-9a-f]{40}$' <<<"$ref"; then echo "pins-check: $f: action not pinned by full sha: $ref"; fail=1; fi
done < <(grep -nH -E '^[[:space:]-]*uses:' .github/workflows/*.yml | sed -E 's/^([^:]+):[0-9]+:/\1:/')
while IFS= read -r line; do
  if ! grep -Eq '@sha256:[0-9a-f]{64}' <<<"$line"; then echo "pins-check: container image not pinned by digest: $line"; fail=1; fi
done < <(grep -n -E '^[[:space:]-]*(image|container):|docker://' .github/workflows/*.yml || true)
if grep -n -E 'pip3?"? install' .github/workflows/*.yml | grep -v -- '--require-hashes' | grep -q .; then
  echo "pins-check: a workflow runs pip install without --require-hashes"; fail=1
fi
if [ "$fail" = 0 ]; then echo "pins-check: all actions pinned by sha, no unpinned images, pip hash-locked"; fi
exit "$fail"
