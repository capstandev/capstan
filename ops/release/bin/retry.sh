#!/bin/bash
# Put a held update back to pending (read its log and fix the cause first). Run it BEFORE a queue rebase, which
# replays only pending updates.
# Usage: retry.sh <update number>
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
n="${1:?usage: retry.sh <n>}"
[ -n "$(rr_sched_field "$n" 3)" ] || { echo "retry: no update $n in the schedule" >&2; exit 2; }
st=$(rr_state_get "$n" 2)
[ "$st" = "held" ] || { echo "retry: update $n is $st, not held" >&2; exit 1; }
rr_state_set "$n" pending 0 "retry requested"
rr_log "retry: update $n back to pending"
rr_fix_owner; echo "retry: update $n is pending again"
