#!/bin/bash
# Preflight runs the gate on every pending and held update in release order, never takes the release lock, and stops
# with one clear line when the schedule is stale.
. "$(dirname "$0")/lib.sh"

t_all_pass() {
  sandbox; rm -f "$T/flag"; out=$("$BIN/preflight.sh"); assert_contains "$out" "preflight: 3 of 3 PASS"
}

t_failure_reported_log_only_when_unarmed() {
  sandbox; rm -f "$T/flag"; echo 1 > "$T/fail-gate-2"
  rc=0; out=$("$BIN/preflight.sh") || rc=$?
  assert_eq "$rc" 1; assert_contains "$out" "preflight: 2 of 3 PASS"
  assert_contains "$(cat "$T/home/preflight/results.tsv")" "$(printf '2\tFAIL')"
  assert_eq "$(lines "$T/notify.log")" 0 "unarmed: no alert"
}

t_never_takes_the_release_lock() {
  sandbox; mkdir "$T/home/run.lock"; echo "$$" > "$T/home/run.lock/pid"
  out=$("$BIN/preflight.sh"); assert_contains "$out" "3 of 3 PASS"
  assert_eq "$(cat "$T/home/run.lock/pid")" "$$" "the pass's lock is untouched"
}

t_held_updates_are_included() {
  sandbox; echo 1 > "$T/fail-gate-1"; pass_at "$LAUNCH"; rm -f "$T/fail-gate-1"
  out=$("$BIN/preflight.sh"); assert_contains "$out" "3 of 3 PASS"
}

t_stale_schedule_stops_with_one_line() {
  sandbox
  g clone -q "$T/private.git" "$T/other"; echo x > "$T/other/x.txt"; g -C "$T/other" add -A
  g -C "$T/other" commit -q -m "fix: moved main"; g -C "$T/other" push -q origin main
  rc=0; out=$("$BIN/preflight.sh") || rc=$?
  assert_eq "$rc" 2; assert_contains "$out" "schedule base"; assert_contains "$out" "the schedule does not match"
}

run_tests "$0"
