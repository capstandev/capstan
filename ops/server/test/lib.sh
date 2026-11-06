#!/bin/bash
# Test helpers (sourced). Each test prints "PASS <file>::<name>" or "FAIL <file>::<name>: <why>" and exits 1 on failure.
T_FILE="$(basename "$0")"
T_NAME="${T_NAME:-}"
fail() { echo "FAIL $T_FILE::$T_NAME: $*"; exit 1; }
pass() { echo "PASS $T_FILE::$T_NAME"; }
assert_eq() { [ "$1" = "$2" ] || fail "${3:-values differ}: got [$1] want [$2]"; }
assert_contains() { printf '%s' "$1" | grep -qF -- "$2" || fail "${3:-missing text}: [$2] not in output: $(printf '%s' "$1" | head -c 600)"; }
assert_not_contains() { if printf '%s' "$1" | grep -qF -- "$2"; then fail "${3:-unexpected text}: [$2] found"; fi; }
SRC="${SRC:-/src/server}"
# The scripts run from a copy, like the Mac step leaves them on the server.
stage_copy() { rm -rf /tmp/capstan-provision && mkdir -p /tmp/capstan-provision && cp -R "$SRC" /tmp/capstan-provision/server; echo /tmp/capstan-provision/server; }
