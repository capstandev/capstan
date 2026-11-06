#!/bin/bash
# Test double for systemctl in a container without systemd: records calls, answers is-active from a state file.
echo "$*" >> "${FAKE_SYSTEMCTL_LOG:-/tmp/systemctl.log}"
case "${1:-}" in
  is-active) [ "${FAKE_SYSTEMCTL_ACTIVE:-1}" = "1" ] && { [ "${2:-}" = "--quiet" ] || echo active; exit 0; }; exit 3 ;;
  *) exit 0 ;;
esac
