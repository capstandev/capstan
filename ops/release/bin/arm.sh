#!/bin/bash
# Arm the runner for launch. The last step before launch and a single command. Refuses, naming the guard, unless:
#   launch-at       LAUNCH_AT is an ISO UTC time with Z, at least ARM_MIN_LEAD_MINUTES (10) ahead
#   owner-tz        OWNER_TZ is set (every post shows UTC plus the owner's zone)
#   stress-report   STRESS_REPORT exists, says "Result: PASS" and names this queue ("Queue tip: <tip sha>")
#   schedule        verify-schedule.sh passes (base == private main, tip == queue tip, count)
#   public-ci       PUBLIC_CI_CHECK_CMD is set and exits 0 (green on the public launch commit)
#   release-token   RELEASE_TOKEN_PROOF exists (ghrelease.sh draft-test passed through the server's token)
#   notify          NOTIFY_PROOF exists (notify-telegram.sh --test reached the team group)
#   origins         the work checkout has no url.* rewrites and no local-path remotes, and the Telegram and GitHub
#                   API bases are the real ones (stand-in origins and endpoints removed)
# Then: dates every slot (set-times), creates the real-deploy flag, enables the timer. --check runs the guards only.
# Usage: arm.sh [--check] LAUNCH_AT=2026-11-20T01:30:00Z
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
check_only=0; launch_iso=""
for a in "$@"; do
  case "$a" in
    --check) check_only=1 ;;
    LAUNCH_AT=*) launch_iso="${a#LAUNCH_AT=}" ;;
    *) echo "arm: unknown argument (use LAUNCH_AT=<ISO UTC>)" >&2; exit 2 ;;
  esac
done
refused=0
refuse() { echo "arm: REFUSED $1: $2"; refused=$((refused + 1)); }

lead=$(rr_conf_get ARM_MIN_LEAD_MINUTES 10)
if ! launch=$(rr_iso_to_epoch "$launch_iso"); then refuse launch-at "LAUNCH_AT must look like 2026-11-20T01:30:00Z (UTC, with Z)"
elif [ "$launch" -lt $(( $(rr_now) + lead * 60 )) ]; then refuse launch-at "LAUNCH_AT is less than $lead minutes ahead"; fi

tz=$(rr_conf_get OWNER_TZ ""); [ -n "$tz" ] || refuse owner-tz "OWNER_TZ is not set"

report=$(rr_conf_get STRESS_REPORT "")
tip=$(rr_sched_header tip 2>/dev/null || true)
if [ -z "$report" ] || [ ! -f "$report" ]; then refuse stress-report "no stress-test report (STRESS_REPORT)"
elif ! grep -q '^Result: PASS' "$report"; then refuse stress-report "the report does not say 'Result: PASS'"
elif [ -z "$tip" ] || ! grep -q "^Queue tip: $tip" "$report"; then refuse stress-report "the report is for another queue (no 'Queue tip: $tip')"; fi

if ! out=$("$RR_ROOT/bin/verify-schedule.sh" 2>&1); then refuse schedule "$out"; fi

if [ -z "$(rr_conf_get PUBLIC_CI_CHECK_CMD)" ]; then refuse public-ci "PUBLIC_CI_CHECK_CMD is not set"
elif ! rr_run PUBLIC_CI_CHECK_CMD >/dev/null 2>&1; then refuse public-ci "public CI is not green on the launch commit"; fi

p=$(rr_conf_get RELEASE_TOKEN_PROOF "$RR_HOME/release-token.proof"); [ -f "$p" ] || refuse release-token "no draft-release proof (run ghrelease.sh draft-test)"
p=$(rr_conf_get NOTIFY_PROOF "$RR_HOME/notify.proof"); [ -f "$p" ] || refuse notify "no notify proof (run notify-telegram.sh --test)"

if [ -n "$(git -C "$RR_WORK" config --get-regexp '^url\.' 2>/dev/null || true)" ]; then refuse origins "url.* rewrites are still set"; fi
if [ "$(rr_conf_get ALLOW_LOCAL_REMOTES 0)" != "1" ]; then
  for kv in "TELEGRAM_API https://api.telegram.org" "GITHUB_API https://api.github.com" "GITHUB_UPLOADS https://uploads.github.com"; do
    v=$(rr_conf_get "${kv%% *}" "${kv#* }"); [ "${v%/}" = "${kv#* }" ] || refuse origins "${kv%% *} points at a stand-in ($v)"
  done
  for r in $(git -C "$RR_WORK" remote 2>/dev/null); do
    case "$(git -C "$RR_WORK" remote get-url "$r")" in /*|file://*) refuse origins "remote $r points at a local path" ;; esac
  done
fi

if [ "$refused" -gt 0 ]; then echo "arm: $refused guard(s) refused; nothing changed"; exit 1; fi
echo "arm: every guard passed"
[ "$check_only" = "1" ] && exit 0
"$RR_ROOT/bin/set-times.sh" "$launch_iso" || exit 1
mkdir -p "$(dirname "$RR_FLAG")" && : > "$RR_FLAG"
rr_run SYSTEMCTL enable --now "$(rr_conf_get TIMER_UNIT capstan-release.timer)" || { rm -f "$RR_FLAG"; echo "arm: could not enable the timer; flag removed" >&2; exit 1; }
rr_log "arm: armed for $launch_iso"
rr_fix_owner
echo "arm: ARMED. Launch $launch_iso = $(rr_local_time "$launch" "$tz")"
