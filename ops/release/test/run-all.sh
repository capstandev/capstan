#!/bin/bash
# Run every release-runner test file under /bin/bash (3.2 on macOS) and print the totals. Exit 1 on any failure.
set -u
dir="$(cd "$(dirname "$0")" && pwd -P)"
pass=0; fail=0; files=0
for f in "$dir"/*.test.sh; do
  files=$((files + 1))
  out=$(/bin/bash "$f" 2>&1); rc=$?
  printf '%s\n' "$out"
  p=$(printf '%s\n' "$out" | grep -c '^ok - ' || true); x=$(printf '%s\n' "$out" | grep -c '^not ok - ' || true)
  pass=$((pass + p)); fail=$((fail + x))
  [ "$rc" -ne 0 ] && [ "$x" -eq 0 ] && { echo "not ok - $(basename "$f") exited $rc"; fail=$((fail + 1)); }
done
echo "release runner tests: $pass pass, $fail fail ($files files, $(/bin/bash -c 'echo $BASH_VERSION'))"
[ "$fail" -eq 0 ]
