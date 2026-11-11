#!/bin/bash
# The happy path: nothing early, one update per pass at its slot, in order, catch-up gap, re-runs change nothing.
. "$(dirname "$0")/lib.sh"

t_nothing_before_launch() {
  sandbox; pass_at $((LAUNCH - 60))
  assert_no_file "$T/prod"; assert_eq "$(lines "$T/notify.log")" 0 "no post before launch"
}

t_releases_in_order_one_per_pass() {
  sandbox; pass_at "$LAUNCH"
  assert_eq "$(st 1)" released; assert_eq "$(st 2)" pending "update 2 is not due yet"
  pass_at $((LAUNCH + 30)); assert_eq "$(st 2)" pending "same slot, nothing more"
  pass_at $((LAUNCH + 3600)); assert_eq "$(st 2)" released
  assert_eq "$(cat "$T/prod")" "$(rr_sched_field 2 3)" "production runs update 2"
  private_has u2.txt; assert_eq "$(lines "$T/public.log")" 2 "two public copies"
  assert_contains "$(notes)" "Update 1 is live: update number 1"
  assert_contains "$(cat "$T/ghrel.log")" "create update-02"
}

t_catch_up_gap() {
  sandbox; now=$((LAUNCH + 3 * 3600))
  pass_at "$now"; assert_eq "$(st 1)" released
  pass_at $((now + 60)); assert_eq "$(st 2)" pending "inside the 2-minute catch-up gap"
  pass_at $((now + 121)); assert_eq "$(st 2)" released
}

t_second_run_skips() {
  sandbox 2; pass_at "$LAUNCH"; pass_at $((LAUNCH + 3600))
  before=$(lines "$T/notify.log"); deploys=$(lines "$T/deploys.log")
  pass_at $((LAUNCH + 7200)); pass_at $((LAUNCH + 7300))
  assert_eq "$(lines "$T/notify.log")" "$before" "no new post"; assert_eq "$(lines "$T/deploys.log")" "$deploys" "no new deploy"
  assert_eq "$(lines "$T/public.log")" 2
}

t_not_armed_does_nothing() {
  sandbox; rm -f "$T/flag"; pass_at "$LAUNCH"
  assert_no_file "$T/prod"
  : > "$T/flag"; CAPSTAN_RELEASE_RUNNER=0 pass_at "$LAUNCH"
  assert_no_file "$T/prod"; assert_eq "$(lines "$T/notify.log")" 0 "unarmed passes post nothing"
}

t_paused_does_nothing() {
  sandbox; echo maintenance > "$T/home/PAUSE"; pass_at "$LAUNCH"
  assert_no_file "$T/prod"
  "$BIN/unpause.sh" > /dev/null; pass_at "$LAUNCH"; assert_eq "$(st 1)" released
}

t_status_shows_counts_and_zones() {
  sandbox; pass_at "$LAUNCH"
  out=$(RR_NOW=$LAUNCH "$BIN/status.sh" 2)
  assert_contains "$out" "armed: yes"; assert_contains "$out" "released 1"
  assert_contains "$out" "2026-11-20T02:00:00Z (2026-11-19 21:00 EST): Update 2"
}

# Owner commands run through sudo wrappers, and sudo drops the unit's CAPSTAN_RELEASE_RUNNER: the flag file alone
# decides whether pause, resume and preflight post (found by the container sandbox: none of them ever posted).
t_owner_commands_post_without_the_unit_env() {
  sandbox
  ( unset CAPSTAN_RELEASE_RUNNER; "$BIN/pause.sh" "shipping a fix" > /dev/null; "$BIN/unpause.sh" > /dev/null
    echo 1 > "$T/fail-gate-1"; "$BIN/preflight.sh" > /dev/null || true )
  assert_contains "$(notes)" "paused|Short planned pause: shipping a fix"
  assert_contains "$(notes)" "resumed|Resumed. Next: Update 1"
  assert_contains "$(notes)" "PREFLIGHT FAIL"
  rm -f "$T/flag"; : > "$T/notify.log"
  ( unset CAPSTAN_RELEASE_RUNNER; "$BIN/pause.sh" "x" > /dev/null; "$BIN/unpause.sh" > /dev/null )
  assert_eq "$(notes)" "" "unarmed: nothing posted"
}

run_tests "$0"
