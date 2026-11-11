#!/bin/bash
# R7: owner-run scripts pass macOS /bin/bash 3.2 in syntax-check mode and shellcheck (when installed), and use no
# mapfile, readarray, associative arrays, negative indexes or empty-array expansion under set -u. Runs on the Mac.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
. "$here/lib.sh"
T_NAME=compatible
srv="$(cd "$here/.." && pwd -P)"
BASH32=/bin/bash
"$BASH32" --version | head -n 1 | grep -q 'version 3\.2' || echo "note: $BASH32 is not bash 3.2 here; syntax check still runs"
for f in "$srv"/*.sh "$srv"/test/*.sh "$srv"/test/standin/*.sh; do
  "$BASH32" -n "$f" || fail "$BASH32 -n $f"
  [ "$(basename "$f")" = "bash32.test.sh" ] && continue # this file holds the patterns themselves
  # constructs bash 3.2 lacks; arrays are not used at all, so no empty-array expansion can hit set -u
  if grep -nE '\bmapfile\b|\breadarray\b|declare -A|local -n|\$\{[A-Za-z_]+\[-1\]\}|\$\{[A-Za-z_]+(,,|\^\^)\}|&>>|\[\[ .* =~ ' "$f" >/dev/null; then fail "bash 3.2 incompatible construct in $f"; fi
  if grep -nE '^[[:space:]]*(local |export |readonly |declare )?[A-Za-z_]+=\(|[;&][[:space:]]*[A-Za-z_]+=\(' "$f" >/dev/null; then fail "array assignment in $f (keep scripts array-free)"; fi
done
# the owner-run entry points run (not only parse) under 3.2: usage errors exit 1 with a message
out="$("$BASH32" "$srv/provision.sh" 2>&1)"; [ $? -eq 1 ] || fail "provision.sh without args should exit 1"
assert_contains "$out" "usage: provision.sh"
out="$("$BASH32" "$srv/make-service-key.sh" nope testnet 2>&1)"; [ $? -eq 1 ] || fail "make-service-key.sh bad service should exit 1"
assert_contains "$out" "usage: make-service-key.sh"
SC="${SHELLCHECK:-$(command -v shellcheck || true)}"
if [ -n "$SC" ]; then
  "$SC" --version | grep -q '^version:' || fail "shellcheck did not run"
  "$SC" -s bash -S warning -x -P "$srv" "$srv"/*.sh || fail "shellcheck warnings"
else
  echo "note: shellcheck not installed; syntax check only"
fi
pass
