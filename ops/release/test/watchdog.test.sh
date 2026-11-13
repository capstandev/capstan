#!/bin/bash
# Dead-man switch: HEALTHCHECK_CMD was empty, so a runner that stopped passing went unnoticed. bin/watchdog.sh alerts
# the team group when the runner is armed and its last pass is older than 2 slots, and stays silent while unarmed.
# Fake clock: RR_NOW. CADENCE_MINUTES=60 in the sandbox, so the limit is 7200 s.
. "$(dirname "$0")/lib.sh"

wd_at() { RR_NOW="$1" "$BIN/watchdog.sh"; }
alerts() { notes | grep -c '^RUNNER STOPPED|' || true; }

t_every_armed_pass_writes_the_heartbeat() {
  sandbox; pass_at $((LAUNCH - 600))
  assert_eq "$(cat "$T/home/last-pass")" $((LAUNCH - 600)) "a pass before launch still beats"
  : > "$T/home/PAUSE"; pass_at $((LAUNCH + 60))
  assert_eq "$(cat "$T/home/last-pass")" $((LAUNCH + 60)) "a paused pass still beats"
  rm -f "$T/home/PAUSE" "$T/flag"; pass_at $((LAUNCH + 120))
  assert_eq "$(cat "$T/home/last-pass")" $((LAUNCH + 60)) "an unarmed pass does not"
}

t_silent_while_passes_are_fresh() {
  sandbox; pass_at "$LAUNCH"; before=$(lines "$T/notify.log")
  wd_at $((LAUNCH + 600)); wd_at $((LAUNCH + 7200))
  assert_eq "$(lines "$T/notify.log")" "$before" "no alert inside 2 slots"
}

t_alerts_when_armed_and_stale_for_two_slots() {
  sandbox; pass_at "$LAUNCH"; wd_at "$LAUNCH"
  wd_at $((LAUNCH + 7201))
  assert_eq "$(alerts)" 1 "one alert past 2 slots"
  assert_contains "$(notes)" "its last pass was at 2026-11-20T01:00:00Z"
  wd_at $((LAUNCH + 7800)); wd_at $((LAUNCH + 9000))
  assert_eq "$(alerts)" 1 "no repeat inside 6 hours"
  wd_at $((LAUNCH + 7201 + 21600))
  assert_eq "$(alerts)" 2 "repeats after 6 hours while still stale"
}

t_silent_while_unarmed_however_stale() {
  sandbox; pass_at "$LAUNCH"; rm -f "$T/flag"
  wd_at $((LAUNCH + 7201)); wd_at $((LAUNCH + 86400 * 30))
  assert_eq "$(alerts)" 0 "unarmed: silent"; assert_no_file "$T/home/watchdog/alerted"
}

t_a_new_arm_gets_its_own_grace() {
  sandbox; pass_at "$LAUNCH"; rm -f "$T/flag"
  wd_at $((LAUNCH + 86400))
  : > "$T/flag"; wd_at $((LAUNCH + 86400 + 600))
  assert_eq "$(alerts)" 0 "a pass from before the disarm does not count against the new arm"
  wd_at $((LAUNCH + 86400 + 600 + 7201))
  assert_eq "$(alerts)" 1 "but 2 slots with no pass after the arm alert"
  assert_contains "$(notes)" "its last pass was at"
}

t_armed_with_no_pass_ever() {
  sandbox; rm -f "$T/home/last-pass"
  wd_at 1000; wd_at 8000; assert_eq "$(alerts)" 0
  wd_at 8201; assert_eq "$(alerts)" 1; assert_contains "$(notes)" "no pass has run since it was armed"
}

t_says_once_when_passes_are_back() {
  sandbox; pass_at "$LAUNCH"; wd_at "$LAUNCH"; wd_at $((LAUNCH + 7201)); assert_eq "$(alerts)" 1
  pass_at $((LAUNCH + 7300)); wd_at $((LAUNCH + 7400)); wd_at $((LAUNCH + 8000))
  assert_eq "$(grep -c '^runner passes again|' "$T/notify.log")" 1 "one all-clear"
  assert_no_file "$T/home/watchdog/alerted"
}

t_failed_alert_is_retried_next_run() {
  sandbox; pass_at "$LAUNCH"; wd_at "$LAUNCH"; : > "$T/fail-notify"
  rc=0; wd_at $((LAUNCH + 7201)) || rc=$?
  assert_eq "$rc" 1 "systemd sees the failure"; assert_no_file "$T/home/watchdog/alerted"
  rm -f "$T/fail-notify"; wd_at $((LAUNCH + 7800)); assert_eq "$(alerts)" 1 "sent on the next run"
}

t_units_and_install() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/rr-test.XXXXXX"); trap 'rm -rf "$T"' EXIT
  u=$(cat "$T_ROOT/systemd/capstan-release-watchdog.service")
  assert_contains "$u" "User=capstan-release"; assert_contains "$u" "ExecStart=/opt/capstan-release/bin/watchdog.sh"
  assert_contains "$u" "Environment=RR_CONF=/etc/capstan-release/release.conf"
  assert_contains "$(cat "$T_ROOT/systemd/capstan-release-watchdog.timer")" "OnUnitActiveSec=10min"
  DESTDIR="$T/root" /bin/bash "$T_ROOT/install.sh" > /dev/null 2>&1
  assert_file "$T/root/etc/systemd/system/capstan-release-watchdog.timer"; assert_file "$T/root/opt/capstan-release/bin/watchdog.sh"
  assert_not_contains "$(cat "$T/root/install-actions.log")" "enable" "install never enables a timer"
}

t_arm_enables_the_watchdog() {
  sandbox; rm -f "$T/flag"
  printf 'Release stress test\nQueue tip: %s\nResult: PASS\n' "$(rr_sched_header tip)" > "$T/stress.md"
  printf 'PUBLIC_CI_CHECK_CMD=%s\n' /usr/bin/true >> "$T/release.conf"
  : > "$T/home/release-token.proof"; : > "$T/home/notify.proof"
  RR_NOW=$((LAUNCH - 7200)) "$BIN/arm.sh" LAUNCH_AT="$LAUNCH_ISO" > /dev/null 2>&1 || fail "arm failed"
  assert_contains "$(cat "$T/systemctl.log")" "enable --now capstan-release-watchdog.timer"
  assert_eq "$(cat "$T/home/watchdog/armed-since")" $((LAUNCH - 7200)) "arm starts the grace at arm time"
  wd_at $((LAUNCH - 7200 + 7201)); assert_eq "$(alerts)" 1 "armed, never passed for 2 slots: alert"
}

run_tests "$0"
