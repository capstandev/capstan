#!/bin/bash
# Every file the stand-in and these tests need is in git: a clean checkout must run them. A broad ignore rule
# (Dockerfile*) once left ops/server/test/standin/Dockerfile untracked, so run.sh failed at its first step. Runs on the Mac.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
. "$here/lib.sh"
T_NAME=tracked
srv="$(cd "$here/.." && pwd -P)"
git -C "$srv" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "note: not a git checkout; skipped"; pass; exit 0; }
for f in "$srv"/*.sh "$srv"/test/* "$srv"/test/standin/*; do
  [ -f "$f" ] || continue
  if git -C "$srv" check-ignore -q --no-index "$f"; then fail "ignored by .gitignore: ${f#$srv/}"; fi
  git -C "$srv" ls-files --error-unmatch "$f" >/dev/null 2>&1 || fail "not tracked by git: ${f#$srv/}"
done
# the files run.sh builds and copies from must exist
for f in Dockerfile run.sh init.sh make-key.exp; do [ -f "$here/standin/$f" ] || fail "missing standin/$f"; done
pass
