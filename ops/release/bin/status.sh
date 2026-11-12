#!/bin/bash
# What the runner is doing: armed or not, paused or not, counts, held updates, the next slots in UTC and OWNER_TZ.
# Usage: status.sh [how many next slots, default 6]
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
want="${1:-6}"; tz=$(rr_conf_get OWNER_TZ UTC)
if [ -f "$RR_FLAG" ]; then echo "armed: yes"; else echo "armed: no"; fi
if rr_exists "$RR_PAUSE"; then echo "paused: yes ($(rr_read "$RR_PAUSE"))"; else echo "paused: no"; fi
if [ -d "$RR_LOCK" ]; then echo "running: yes (pid $(rr_read "$RR_LOCK/pid" 2>/dev/null))"; else echo "running: no"; fi
if ! rr_exists "$RR_SCHEDULE"; then echo "schedule: none"; exit 0; fi
la=$(rr_sched_header launch_at); echo "launch_at: ${la:-not set}"
total=$(rr_sched_rows | wc -l | tr -d ' ')
echo "updates: $total; released $(rr_count_status released); publish owed $(rr_count_status publish_pending); held $(rr_count_status held); pending $(rr_count_status pending)"
if [ -s "$RR_HOME/announce.tsv" ]; then
  echo "team posts: $(awk -F '\t' '{ c[$2]++ } END { printf "announced %d; owed %d; dry run %d; given up %d", c["announced"], c["owed"], c["dry_run"], c["gave_up"] }' "$RR_HOME/announce.tsv")"
fi
for n in $(rr_sched_rows | cut -f1); do
  [ "$(rr_state_get "$n" 2)" = "held" ] && echo "  HELD Update $n: $(rr_title_of "$n") ($(rr_state_get "$n" 5))"
done
echo "next:"
shown=0
for n in $(rr_sched_rows | cut -f1); do
  [ "$(rr_state_get "$n" 2)" = "pending" ] || continue
  slot=$(rr_sched_field "$n" 2)
  if [ -n "$la" ]; then echo "  $(rr_epoch_to_iso "$slot") ($(rr_local_time "$slot" "$tz")): Update $n, $(rr_title_of "$n")"
  else echo "  slot $n (not dated): Update $n, $(rr_title_of "$n")"; fi
  shown=$((shown + 1)); [ "$shown" -ge "$want" ] && break
done
