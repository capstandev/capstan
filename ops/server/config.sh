#!/bin/bash
# Server settings in /etc/capstan/server.conf (installed as /usr/local/sbin/capstan-config).
#   sudo capstan-config get KEY
#   sudo capstan-config set KEY VALUE [--i-have-a-reapproval-plan]
# RELAY_EGRESS_IP is written once. It is the relay's egress and every relay-mode Aster agent's IP whitelist
# (DECISIONS #21): changing it breaks those agents until each user re-approves. A change therefore needs
# --i-have-a-reapproval-plan, and it also updates the api env file that hands the IP to onboarding.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
if [ -f "$here/lib.sh" ]; then . "$here/lib.sh"; else . /usr/local/lib/capstan/lib.sh; fi

KEYS="DOMAIN ACME_EMAIL RELAY_EGRESS_IP REPO_URL AGE_RECIPIENT BACKUP_OFFBOX"
cmd="${1:-}"; key="${2:-}"
in_list "$key" "$KEYS" || die "usage: capstan-config get|set KEY [VALUE] (keys: $KEYS)"
case "$cmd" in
  get) conf_get "$key"; exit 0 ;;
  set) ;;
  *) die "usage: capstan-config get|set KEY [VALUE]" ;;
esac
require_root
val="${3:-}"; flag="${4:-}"
[ -n "$val" ] || die "set needs a value"
case "$val" in *[[:space:]]*|*'|'*|*'`'*|*'$'*) die "value has spaces or shell characters" ;; esac
[ -f "$CAPSTAN_SERVER_CONF" ] || die "no $CAPSTAN_SERVER_CONF (run provision.sh first)"
cur="$(conf_get "$key")"
if [ "$key" = "RELAY_EGRESS_IP" ]; then
  echo "$val" | /bin/grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-fA-F:]+$' || die "RELAY_EGRESS_IP must be an IP address"
  if [ -n "$cur" ] && [ "$cur" != "$val" ] && [ "$flag" != "--i-have-a-reapproval-plan" ]; then
    die "RELAY_EGRESS_IP is already $cur. Changing it breaks every relay-mode Aster agent until its owner re-approves. Re-run with --i-have-a-reapproval-plan once the re-approval campaign is ready."
  fi
fi
if [ "$cur" = "$val" ]; then [ "${CAPSTAN_QUIET:-0}" = "1" ] || stage_skip "$key unchanged"; exit 0; fi
conf_set "$key" "$val" "$CAPSTAN_SERVER_CONF"
if [ "$key" = "RELAY_EGRESS_IP" ] && [ -f "$CAPSTAN_ETC/api/env" ]; then conf_set RELAY_EGRESS_IP "$val" "$CAPSTAN_ETC/api/env"; fi
/bin/mkdir -p "$CAPSTAN_LOG/ops"
printf '%s %s %s %s -> %s\n' "$(utc_now)" "${SUDO_USER:-$(id -un)}" "$key" "${cur:-(empty)}" "$val" >> "$CAPSTAN_LOG/ops/config.log"
[ "${CAPSTAN_QUIET:-0}" = "1" ] || stage_done "$key set"
