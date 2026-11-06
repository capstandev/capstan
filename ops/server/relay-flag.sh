#!/bin/bash
# Stop or restart order relaying, globally or for one venue (installed as /usr/local/sbin/capstan-relay-flag).
#   sudo capstan-relay-flag RELAY_ENABLED off|on
#   sudo capstan-relay-flag HL_ENABLED|LIGHTER_304_ENABLED|LIGHTER_RH_ENABLED|ASTER_ENABLED off|on
# Writes the flag into /etc/capstan/relay/env, restarts the relay, logs operator and UTC time to
# /var/log/capstan/ops/flags.log. Direct mode is not affected (users submit to the venue themselves).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
if [ -f "$here/lib.sh" ]; then . "$here/lib.sh"; else . /usr/local/lib/capstan/lib.sh; fi
SYSTEMCTL="${CAPSTAN_SYSTEMCTL:-/bin/systemctl}"

flag="${1:-}"; state="${2:-}"
in_list "$flag" "$CAPSTAN_RELAY_FLAGS" || die "usage: capstan-relay-flag <$CAPSTAN_RELAY_FLAGS> on|off"
case "$state" in on) v=1 ;; off) v=0 ;; *) die "state must be on or off" ;; esac
require_root
f="$CAPSTAN_ETC/relay/env"
[ -f "$f" ] || die "no $f"
cur="$(conf_get "$flag" "$f")"
if [ "$cur" = "$v" ]; then say "flag: $flag=$v (unchanged)"; exit 0; fi
conf_set "$flag" "$v" "$f"
/bin/mkdir -p "$CAPSTAN_LOG/ops"
printf '%s %s %s %s\n' "$(utc_now)" "${SUDO_USER:-$(id -un)}" "$flag" "$state" >> "$CAPSTAN_LOG/ops/flags.log"
"$SYSTEMCTL" restart capstan-relay.service
say "flag: $flag=$v"
