#!/bin/bash
# Assert the schedule matches the checkouts before preflight or arming (a stale schedule once reported 30 false
# "does not apply" failures). Before the first release: base == private main. After: base is an ancestor of it.
# Always: tip == the queue tip, every row is in base..tip in order, the count matches EXPECTED_COUNT.
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
fail() { echo "verify-schedule: FAIL $*"; exit 1; }
[ -f "$RR_SCHEDULE" ] || fail "no schedule at $RR_SCHEDULE"
git -C "$RR_WORK" fetch -q origin main 2>/dev/null || true
git -C "$RR_WORK" fetch -q queue 2>/dev/null || true
base=$(rr_sched_header base); tip=$(rr_sched_header tip)
main=$(git -C "$RR_WORK" rev-parse origin/main 2>/dev/null) || fail "no origin/main in $RR_WORK"
qtip=$(git -C "$RR_WORK" rev-parse "$(rr_conf_get QUEUE_REF queue/tu-queue)" 2>/dev/null) || fail "no queue ref"
released=$(rr_count_status released)
if [ "$released" -eq 0 ]; then [ "$base" = "$main" ] || fail "schedule base ${base:0:12} != private main ${main:0:12} (rebuild the schedule)"
else git -C "$RR_WORK" merge-base --is-ancestor "$base" "$main" || fail "schedule base is not under private main"; fi
[ "$tip" = "$qtip" ] || fail "schedule tip ${tip:0:12} != queue tip ${qtip:0:12} (push the queue, then rebuild)"
want=$(git -C "$RR_WORK" rev-list --reverse "$base..$tip" | tr '\n' ' ')
have=$(rr_sched_rows | cut -f3 | tr '\n' ' ')
[ "$want" = "$have" ] || fail "schedule rows differ from base..tip"
expected=$(rr_conf_get EXPECTED_COUNT "")
count=$(rr_sched_rows | wc -l | tr -d ' ')
[ -z "$expected" ] || [ "$count" -eq "$expected" ] || fail "$count updates, expected $expected"
echo "verify-schedule: OK ($count updates, base ${base:0:12}, tip ${tip:0:12})"
