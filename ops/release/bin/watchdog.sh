#!/bin/bash
# Dead-man switch for the release runner. capstan-release-watchdog.timer runs this every 10 minutes as the runner
# user. While the runner is armed (the flag file exists) and its last pass ($RR_HOME/last-pass, written by every armed
# pass) is older than WATCHDOG_STALE_SLOTS (2) release slots of CADENCE_MINUTES, it alerts the team group through
# NOTIFY_CMD (capstan-release-notify), again every WATCHDOG_REPEAT_S (6 h) while it stays stale, and once more when
# passes are back. Unarmed: silent, and its state is cleared. It cannot see a dead server: it runs on the same box.
# Exit 0, or 1 when an alert could not be sent (systemd shows the failure; the next run tries again).
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
W="$RR_HOME/watchdog"
rr_mkdir "$W"
now=$(rr_now)
if [ ! -f "$RR_FLAG" ]; then
  rr_rm "$W/armed-since"; rr_rm "$W/alerted"
  exit 0
fi
cadence=$(rr_conf_get CADENCE_MINUTES 60); slots=$(rr_conf_get WATCHDOG_STALE_SLOTS 2)
repeat=$(rr_conf_get WATCHDOG_REPEAT_S 21600)
limit=$((cadence * 60 * slots))
# armed-since: the first run that saw the flag. A pass from before an earlier disarm never counts against a new arm.
since=$(rr_read "$W/armed-since" 2>/dev/null || true)
case "$since" in ''|*[!0-9]*) since=$now; printf '%s\n' "$now" | rr_write "$W/armed-since" ;; esac
last=$(rr_read "$RR_HOME/last-pass" 2>/dev/null | tr -d '[:space:]' || true)
case "$last" in ''|*[!0-9]*) last=0 ;; esac
base=$last; [ "$since" -gt "$base" ] && base=$since
age=$((now - base))
alerted=$(rr_read "$W/alerted" 2>/dev/null || true)
send() { # send title body; 0 when sent
  local rc=0
  printf '%s' "$2" | rr_run NOTIFY_CMD "$1" || rc=$?
  if [ "$rc" -eq 0 ]; then rr_log "watchdog: sent '$1'"; else rr_log "watchdog: FAILED '$1' (rc $rc)"; fi
  return "$rc"
}
if [ "$age" -gt "$limit" ]; then
  case "$alerted" in ''|*[!0-9]*) alerted="" ;; esac
  if [ -n "$alerted" ] && [ $((now - alerted)) -lt "$repeat" ]; then exit 0; fi
  if [ "$last" -gt 0 ]; then seen="its last pass was at $(rr_epoch_to_iso "$last")"; else seen="no pass has run since it was armed"; fi
  send "RUNNER STOPPED" "The release runner is armed but $seen, $((age / 60)) minutes ago (limit $((limit / 60))). No update releases until it runs again. Users are not affected. The owner checks: systemctl status capstan-release.timer capstan-release.service, then the runner log $RR_LOG." || exit 1
  printf '%s\n' "$now" | rr_write "$W/alerted"
  rr_log "watchdog: runner stale for $age s (limit $limit s)"
  exit 0
fi
if [ -n "$alerted" ]; then
  send "runner passes again" "The release runner is running its passes again (last pass $(rr_epoch_to_iso "$last")). Updates continue at their slots." || exit 1
  rr_rm "$W/alerted"
fi
exit 0
