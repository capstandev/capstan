#!/bin/bash
# R5: the runner refuses to arm without the stress-test report and a set LAUNCH_AT (UTC plus the owner's zone), and
# without every other precondition. Each refusal names its guard and changes nothing.
. "$(dirname "$0")/lib.sh"

good_setup() { # every guard satisfied
  rm -f "$T/flag"
  printf 'Release stress test\nQueue tip: %s\nResult: PASS\n' "$(rr_sched_header tip)" > "$T/stress.md"
  printf 'PUBLIC_CI_CHECK_CMD=%s\n' /usr/bin/true >> "$T/release.conf"
  : > "$T/home/release-token.proof"; : > "$T/home/notify.proof"
}
arm() { rc=0; out=$(RR_NOW=$((LAUNCH - 7200)) "$BIN/arm.sh" "$@" 2>&1) || rc=$?; }
refused_only() { # the guard is named, the exit is 1, no flag, no timer
  assert_eq "$rc" 1 "arm must refuse"; assert_contains "$out" "REFUSED $1"
  assert_no_file "$T/flag"; assert_no_file "$T/systemctl.log"
}

t_guards() {
  sandbox; rm -f "$T/flag"; sed -i.bak '/^OWNER_TZ=/d' "$T/release.conf"
  arm
  for gname in launch-at owner-tz stress-report public-ci release-token notify; do refused_only "$gname"; done
}

t_guards_each_one_alone() {
  for gname in launch-at owner-tz stress-report public-ci release-token notify schedule origins; do
    sandbox; good_setup
    case "$gname" in
      launch-at) arm ;;
      owner-tz) sed -i.bak '/^OWNER_TZ=/d' "$T/release.conf"; arm LAUNCH_AT="$LAUNCH_ISO" ;;
      stress-report) rm "$T/stress.md"; arm LAUNCH_AT="$LAUNCH_ISO" ;;
      public-ci) sed -i.bak 's#^PUBLIC_CI_CHECK_CMD=.*#PUBLIC_CI_CHECK_CMD=/usr/bin/false#' "$T/release.conf"; arm LAUNCH_AT="$LAUNCH_ISO" ;;
      release-token) rm "$T/home/release-token.proof"; arm LAUNCH_AT="$LAUNCH_ISO" ;;
      notify) rm "$T/home/notify.proof"; arm LAUNCH_AT="$LAUNCH_ISO" ;;
      schedule) echo more > "$T/seed/m.txt"; g -C "$T/seed" add -A; g -C "$T/seed" commit -q -m "feat: late"; g -C "$T/seed" push -q "$T/queue.git" tu-queue; arm LAUNCH_AT="$LAUNCH_ISO" ;;
      origins) sed -i.bak '/^ALLOW_LOCAL_REMOTES=/d' "$T/release.conf"; arm LAUNCH_AT="$LAUNCH_ISO" ;;
    esac
    refused_only "$gname"
    other=$(printf '%s\n' "$out" | grep 'REFUSED' | grep -v "REFUSED $gname:" || true)
    assert_eq "$other" "" "only $gname refused"
    rm -rf "$T"
  done
}

t_report_for_another_queue_refused() {
  sandbox; good_setup; printf 'Queue tip: 0000000\nResult: PASS\n' > "$T/stress.md"
  arm LAUNCH_AT="$LAUNCH_ISO"; refused_only stress-report
}

t_launch_time_must_be_utc_and_ahead() {
  sandbox; good_setup
  arm LAUNCH_AT=2026-11-20T01:00:00; refused_only launch-at
  arm LAUNCH_AT=2026-11-20T01:00:00+03:00; refused_only launch-at
  rc=0; out=$(RR_NOW=$((LAUNCH - 60)) "$BIN/arm.sh" LAUNCH_AT="$LAUNCH_ISO" 2>&1) || rc=$?; refused_only launch-at
}

t_check_mode_changes_nothing() {
  sandbox; good_setup; arm --check LAUNCH_AT="$LAUNCH_ISO"
  assert_eq "$rc" 0; assert_contains "$out" "every guard passed"; assert_no_file "$T/flag"; assert_no_file "$T/systemctl.log"
}

t_arms_when_every_guard_passes() {
  sandbox; good_setup; arm LAUNCH_AT=2026-11-20T03:30:00Z
  assert_eq "$rc" 0; assert_file "$T/flag"
  assert_eq "$(cat "$T/systemctl.log")" "enable --now capstan-release.timer"
  assert_eq "$(rr_sched_header launch_at)" 2026-11-20T03:30:00Z
  assert_eq "$(rr_sched_field 1 2)" "$(rr_iso_to_epoch 2026-11-20T03:30:00Z)" "slots re-dated"
  assert_contains "$out" "2026-11-19 22:30 EST"
}

run_tests "$0"
