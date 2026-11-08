#!/bin/bash
# Re-date every slot from a new launch time (moving the launch). Waits for a running pass (takes the run lock), keeps a
# .pre-<HHMM> copy of the schedule, keeps the order and the cadence. Prints the first slots after.
# Usage: set-times.sh <launch-at ISO UTC>
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
iso="${1:?usage: set-times.sh 2026-11-20T01:30:00Z}"
launch=$(rr_iso_to_epoch "$iso") || { echo "set-times: launch time must look like 2026-11-20T01:30:00Z (UTC, with Z)" >&2; exit 2; }
[ -f "$RR_SCHEDULE" ] || { echo "set-times: no schedule at $RR_SCHEDULE" >&2; exit 2; }
waited=0
until rr_lock; do
  waited=$((waited + 1)); [ "$waited" -gt "${RR_LOCK_WAIT_S:-600}" ] && { echo "set-times: a pass is still running" >&2; exit 1; }
  sleep 1
done
trap 'rr_unlock' EXIT
cadence=$(rr_sched_header cadence_minutes); cadence="${cadence:-$(rr_conf_get CADENCE_MINUTES 60)}"
cp "$RR_SCHEDULE" "$RR_SCHEDULE.pre-$(date -u +%H%M)"
tmp="$RR_SCHEDULE.tmp.$$"
awk -v L="$launch" -v iso="$iso" -v c="$cadence" 'BEGIN { FS = OFS = "\t" }
  /^# launch_at / { next }
  /^#/ { print; if ($0 ~ /^# tip /) print "# launch_at " iso; next }
  NF >= 4 { $2 = L + ($1 - 1) * c * 60; print }' "$RR_SCHEDULE" > "$tmp" && mv "$tmp" "$RR_SCHEDULE"
rr_log "set-times: launch_at $iso"
rr_fix_owner
echo "set-times: launch_at $iso; first slots:"
rr_sched_rows | head -n 3 | while IFS="$(printf '\t')" read -r n slot _s title; do echo "  $(rr_epoch_to_iso "$slot") Update $n, $title"; done
