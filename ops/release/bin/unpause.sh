#!/bin/bash
# Unpause (resume): remove PAUSE (and a stale ABORT when no pass runs), then post the next slot.
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
rr_home_op "$RR_PAUSE" rm -f "$RR_PAUSE"
rr_journal 0 - resumed # the crash count of an adopted update starts again
if rr_lock; then rr_home_op "$RR_HOME/ABORT" rm -f "$RR_HOME/ABORT"; rr_unlock; fi
next=""; for n in $(rr_sched_rows | cut -f1); do [ "$(rr_state_get "$n" 2)" = "pending" ] && { next="$n"; break; }; done
msg="Resumed."
[ -n "$next" ] && msg="Resumed. Next: Update $next at $(rr_epoch_to_iso "$(rr_sched_field "$next" 2)")."
rr_log "resume: $msg"
rr_fix_owner
[ -f "$RR_FLAG" ] && rr_notify "" 0 "resumed" "$msg"
echo "resume: $msg"
