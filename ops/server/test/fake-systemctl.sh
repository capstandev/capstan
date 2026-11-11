#!/bin/bash
# Test double for systemctl in a container without systemd: records calls, answers is-active from a state file.
echo "$*" >> "${FAKE_SYSTEMCTL_LOG:-/tmp/systemctl.log}"
# A unit with a file in FAKE_SYSTEMCTL_FAILED (default /tmp/fake-failed) has hit its start limit, as a crash-looping
# unit does: restart and start then fail until reset-failed clears it (as systemd does).
fd="${FAKE_SYSTEMCTL_FAILED:-/tmp/fake-failed}"
case "${1:-}" in
  restart|start) [ -e "$fd/${2:-}" ] && { echo "Job for ${2:-} failed: start-limit-hit" >&2; exit 1; }; exit 0 ;;
  reset-failed) rm -f "$fd/${2:-}"; exit 0 ;;
  is-active) [ "${FAKE_SYSTEMCTL_ACTIVE:-1}" = "1" ] && { [ "${2:-}" = "--quiet" ] || echo active; exit 0; }; exit 3 ;;
  *) exit 0 ;;
esac
