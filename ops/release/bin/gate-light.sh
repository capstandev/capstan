#!/bin/bash
# Light server gate for one update, run in the work checkout with the update applied at HEAD:
# frozen install, typecheck, the tests of every package the update touched, the public guard.
# The full suites already passed before launch (queue proof); this catches a change to main since then.
# Exit 0 pass, 75 tool or network trouble (retried), anything else = the update is held.
set -u
BUN=${BUN:-$HOME/.bun/bin/bun}
[ -x "$BUN" ] || { echo "gate: bun not installed at $BUN (install it, never skip the gate)"; exit 75; }
"$BUN" install --frozen-lockfile > /dev/null 2>&1 || { echo "gate: bun install failed"; exit 75; }
"$BUN" x tsc --noEmit || exit 1
dirs=$(git diff --name-only HEAD^ HEAD | awk -F/ '
  $1=="apps" || $1=="packages" { if ($2=="adapters" || $2=="signers") print $1"/"$2"/"$3; else print $1"/"$2; next }
  $1=="ops" { print $1"/"$2 } ' | sort -u)
for d in $dirs; do
  [ -d "$d" ] || continue
  if find "$d" -name '*.test.ts' -not -path '*/node_modules/*' | grep -q .; then
    echo "gate: tests in $d"
    "$BUN" test --timeout 30000 "$d" || exit 1
  fi
  if [ -f "$d/test/run-all.sh" ]; then /bin/bash "$d/test/run-all.sh" || exit 1; fi
done
bash .githooks/public-guard.sh || exit 1
echo "gate: PASS"
