#!/bin/bash
# UTC maths without date flags, launch moves, and the owner's zone across the US DST change.
. "$(dirname "$0")/lib.sh"

t_iso_to_epoch_known_values() {
  assert_eq "$(rr_iso_to_epoch 1970-01-01T00:00:00Z)" 0
  assert_eq "$(rr_iso_to_epoch 2026-11-04T01:30:00Z)" 1793755800
  assert_eq "$(rr_iso_to_epoch 2028-02-29T23:59:59Z)" 1835481599
  assert_eq "$(rr_iso_to_epoch 2000-03-01T00:00:00Z)" 951868800
}

t_round_trip() {
  for s in 2026-11-20T01:00:00Z 2027-01-01T00:00:00Z 2028-02-29T12:34:56Z 2099-12-31T23:59:59Z; do
    assert_eq "$(rr_epoch_to_iso "$(rr_iso_to_epoch "$s")")" "$s"
  done
}

t_refuses_non_utc() {
  for s in 2026-11-20T01:00:00 2026-11-20T01:00:00+03:00 2026-13-01T00:00:00Z 2026-11-20 tomorrow; do
    if rr_iso_to_epoch "$s" >/dev/null; then fail "accepted $s"; fi
  done
}

t_owner_zone_across_dst() {
  assert_contains "$(rr_local_time "$(rr_iso_to_epoch 2026-11-01T05:30:00Z)" America/New_York)" "01:30 EDT"
  assert_contains "$(rr_local_time "$(rr_iso_to_epoch 2026-11-01T06:30:00Z)" America/New_York)" "01:30 EST"
  assert_contains "$(rr_local_time "$(rr_iso_to_epoch 2026-11-20T01:30:00Z)" Europe/Moscow)" "04:30 MSK"
}

t_set_times_moves_every_slot() {
  sandbox; "$BIN/set-times.sh" 2026-11-21T10:00:00Z > /dev/null
  e=$(rr_iso_to_epoch 2026-11-21T10:00:00Z)
  assert_eq "$(rr_sched_field 1 2)" "$e"; assert_eq "$(rr_sched_field 3 2)" $((e + 7200))
  assert_eq "$(rr_sched_header launch_at)" 2026-11-21T10:00:00Z
  assert_eq "$(grep -c '^# launch_at' "$RR_SCHEDULE")" 1 "one launch_at line"
  ls "$T/home/" | grep -q '^schedule.tsv.pre-' || fail "no backup copy"
  assert_eq "$(rr_sched_field 2 3)" "$(g -C "$T/work" rev-list --reverse "$BASE..queue/tu-queue" | sed -n 2p)" "order kept"
}

t_set_times_waits_for_a_running_pass() {
  sandbox; mkdir "$T/home/run.lock"; echo "$$" > "$T/home/run.lock/pid"
  rc=0; RR_LOCK_WAIT_S=1 "$BIN/set-times.sh" 2026-11-21T10:00:00Z > /dev/null 2>&1 || rc=$?
  assert_eq "$rc" 1 "refuses while a pass runs"; assert_eq "$(rr_sched_header launch_at)" "$LAUNCH_ISO"
}

t_schedule_refuses_a_wrong_count() {
  sandbox; echo EXPECTED_COUNT=72 >> "$T/release.conf"
  rc=0; out=$("$BIN/build-schedule.sh" "$BASE" queue/tu-queue 2>&1) || rc=$?
  assert_eq "$rc" 2; assert_contains "$out" "3 updates, expected 72"
}

run_tests "$0"
