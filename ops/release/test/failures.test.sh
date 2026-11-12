#!/bin/bash
# Injected failures: each one stays local to its update, retries what never switched, rolls back what did, and a
# crash at any stage is adopted by the next pass without a second public copy.
. "$(dirname "$0")/lib.sh"

t_gate_fail_holds_and_next_continues() {
  sandbox; echo 1 > "$T/fail-gate-1"; pass_at "$LAUNCH"
  assert_eq "$(st 1)" held; assert_contains "$(notes)" "HELD Update 1"; assert_no_file "$T/prod"
  pass_at $((LAUNCH + 3600)); assert_eq "$(st 2)" released "update 2 is not blocked"
  private_has u2.txt
  if private_has u1.txt; then fail "held update 1 reached private main"; fi
}

t_transient_gate_retried() {
  sandbox; echo 75 > "$T/fail-gate-1"; pass_at "$LAUNCH"
  assert_eq "$(st 1)" pending; assert_eq "$(lines "$T/notify.log")" 0 "a retry is log-only"
  rm -f "$T/fail-gate-1"; pass_at $((LAUNCH + 60)); assert_eq "$(st 1)" released
}

t_transient_cap_then_held() {
  sandbox; echo 75 > "$T/fail-gate-1"
  pass_at "$LAUNCH"; pass_at $((LAUNCH + 60)); pass_at $((LAUNCH + 120))
  assert_eq "$(st 1)" held "held after TRANSIENT_MAX attempts"; assert_contains "$(notes)" "HELD Update 1"
}

t_deploy_failure_rolls_back() {
  sandbox; echo 1 > "$T/fail-deploy"; pass_at "$LAUNCH"
  assert_eq "$(st 1)" held; assert_contains "$(notes)" "Update 1 ROLLED BACK"
  assert_contains "$(cat "$T/deploys.log")" "rollback $BASE"
  if private_has u1.txt; then fail "private main still carries the rolled-back update"; fi
}

t_nothing_switched_is_retried_once() {
  sandbox; echo once75 > "$T/fail-deploy"; pass_at "$LAUNCH"
  assert_eq "$(st 1)" pending "exit 75 keeps it pending"
  pass_at $((LAUNCH + 60)); assert_eq "$(st 1)" released
  assert_eq "$(g -C "$T/work" rev-list --count "$BASE..origin/main")" 1 "the update is on main once"
}

t_check_failure_rolls_back() {
  sandbox; : > "$T/fail-check-1"; pass_at "$LAUNCH"
  assert_eq "$(st 1)" held; assert_eq "$(cat "$T/prod")" "$BASE" "production back on the previous version"
  assert_eq "$(lines "$T/public.log")" 0 "nothing public"
}

t_failed_rollback_pauses_and_alerts() {
  sandbox; echo 1 > "$T/fail-deploy"; : > "$T/fail-rollback"; pass_at "$LAUNCH"
  assert_file "$T/home/PAUSE"; assert_contains "$(notes)" "ROLLBACK FAILED Update 1"
  assert_eq "$(st 1)" held "never left in_progress"
  pass_at $((LAUNCH + 3600)); assert_eq "$(st 2)" pending "paused: nothing more releases"
}

t_public_copy_failure_never_blocks() {
  sandbox; : > "$T/fail-publish"; pass_at "$LAUNCH"
  assert_eq "$(st 1)" publish_pending; assert_contains "$(notes)" "PUBLIC COPY FAILED Update 1"
  pass_at $((LAUNCH + 3600)); assert_eq "$(st 2)" publish_pending "update 2 still released on time"
  rm -f "$T/fail-publish"; pass_at $((LAUNCH + 3700)); pass_at $((LAUNCH + 3800))
  assert_eq "$(st 1)" released; assert_eq "$(st 2)" released; assert_eq "$(lines "$T/public.log")" 2
}

t_crash_before_checks_is_redone() {
  sandbox; : > "$T/crash-check"; pass_at "$LAUNCH" || true
  assert_eq "$(st 1)" in_progress "the crash left it mid-release"
  pass_at $((LAUNCH + 60)); assert_eq "$(st 1)" released "adopted and finished"
  assert_eq "$(lines "$T/public.log")" 1; assert_eq "$(g -C "$T/work" rev-list --count "$BASE..origin/main")" 1
}

t_crash_after_public_copy_is_adopted() {
  sandbox; : > "$T/crash-publish"; pass_at "$LAUNCH" || true
  assert_eq "$(st 1)" in_progress
  pass_at $((LAUNCH + 60)); assert_eq "$(st 1)" released
  assert_eq "$(lines "$T/public.log")" 1 "the public copy was not made twice"
  assert_eq "$(grep -c 'deploy ' "$T/deploys.log")" 1 "not redeployed"
}

t_main_moved_conflict_holds_with_one_alert() {
  sandbox
  g clone -q "$T/private.git" "$T/other"; echo other > "$T/other/u1.txt"; g -C "$T/other" add -A
  g -C "$T/other" commit -q -m "fix: owner fix"; g -C "$T/other" push -q origin main
  pass_at "$LAUNCH"; assert_eq "$(st 1)" held; assert_contains "$(notes)" "queue needs a rebase"
  pass_at $((LAUNCH + 3600)); assert_eq "$(grep -c 'queue needs a rebase' "$T/notify.log")" 1 "keyed: one alert"
}

t_release_token_problem_alerts_once() {
  sandbox; echo 3 > "$T/ghrel-code"; pass_at "$LAUNCH"; pass_at $((LAUNCH + 3600))
  assert_eq "$(st 2)" released "releases go on"
  assert_eq "$(grep -c 'GITHUB RELEASES BLOCKED' "$T/notify.log")" 1 "one alert per cause"
}

# A held update retried after its rollback must go live again. The update was a fast-forward, so after the revert its
# sha is still an ancestor of main: the runner used to treat it as "already applied" and marked a release that
# shipped nothing (found by the container sandbox, ops/release/test/sandbox).
t_retry_after_rollback_ships_the_update() {
  sandbox; echo 1 > "$T/fail-deploy"; pass_at "$LAUNCH"
  assert_eq "$(st 1)" held
  rm -f "$T/fail-deploy"; "$BIN/retry.sh" 1 > /dev/null
  pass_at $((LAUNCH + 60))
  assert_eq "$(st 1)" released
  private_has u1.txt || fail "the retried update is not on private main"
  g -C "$T/work" show "$(cat "$T/prod"):u1.txt" > /dev/null 2>&1 || fail "production runs a tree without the retried update"
}

# An update whose check kills the pass every time (found by the container sandbox: it was adopted and redeployed on
# every pass forever, with no alert) pauses the runner after CRASH_MAX adoptions, with one alert.
t_crash_loop_pauses_with_one_alert() {
  sandbox
  printf '#!/bin/bash\nkill -9 $PPID; sleep 2\n' > "$T/fake/check"
  for i in 0 1 2 3 4 5; do pass_at $((LAUNCH + i * 60)) || true; done
  assert_file "$T/home/PAUSE"; assert_contains "$(cat "$T/home/PAUSE")" "update 1 crashed its pass 4 times"
  assert_eq "$(grep -c 'deploy ' "$T/deploys.log")" 4 "first try plus 3 adoptions, then no more deploys"
  assert_eq "$(notes | grep -c 'keeps crashing')" 1 "one alert"
  assert_eq "$(st 1)" in_progress
  printf '#!/bin/bash\nexit 0\n' > "$T/fake/check"; "$BIN/unpause.sh" > /dev/null
  pass_at $((LAUNCH + 600)); assert_eq "$(st 1)" released "after the owner resumes, the update is adopted again"
}

# GitHub down at the slot: the update is live, its Release page is owed and made by a later pass, once (stress
# 2026-11-11 on the real queue: the page used to be lost, nothing retried it).
t_github_outage_release_page_made_later() {
  sandbox; echo 1 > "$T/ghrel-code"; pass_at "$LAUNCH"
  assert_eq "$(st 1)" released "the update is live during a GitHub outage"
  assert_eq "$(lines "$T/ghrel.log")" 0 "no Release made while GitHub is down"
  pass_at $((LAUNCH + 600)); assert_eq "$(lines "$T/ghrel.log")" 0 "still down: still owed"
  rm -f "$T/ghrel-code"; pass_at $((LAUNCH + 1200))
  assert_eq "$(grep -c '^create update-01 ' "$T/ghrel.log")" 1 "owed Release made once GitHub is back"
  pass_at $((LAUNCH + 1800)); assert_eq "$(grep -c '^create update-01 ' "$T/ghrel.log")" 1 "never made twice"
  pass_at $((LAUNCH + 3600)); assert_eq "$(st 2)" released "later updates not blocked"
  assert_eq "$(grep -c '^create update-0[12] ' "$T/ghrel.log")" 2 "one Release each"
}

run_tests "$0"
