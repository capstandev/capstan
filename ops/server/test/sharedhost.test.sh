#!/bin/bash
# Shared host options (Cherry box, Ubuntu 26.04, 2026-11-12): --db-port moves Postgres off a host Postgres's 5432, and
# --firewall-additive keeps the host's own ufw rules (a bare "443" rule made the default check die). Runs last: it
# changes the provisioned container.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
T_NAME=db-port-and-additive-firewall
dir="$(stage_copy)"
/usr/sbin/ufw allow 443 >/dev/null 2>&1 # a rule this script did not make, like the Cherry box's
/bin/rm -f /etc/capstan/api/env         # written again with the new port
out1="$(/bin/bash "$dir/provision.sh" --local --egress-ip 203.0.113.10 --db-port 5433 --firewall-additive 2>&1)"; rc1=$?
[ "$rc1" -eq 0 ] || fail "first run exit $rc1: $(printf '%s' "$out1" | tail -n 10)"
assert_eq "$(grep '^DB_PORT=' /etc/capstan/server.conf)" "DB_PORT=5433"
assert_eq "$(grep '^CAPSTAN_DB_PORT=' /etc/capstan/db/env)" "CAPSTAN_DB_PORT=5433"
grep -q '@127.0.0.1:5433/capstan$' /etc/capstan/api/env || fail "api env does not use port 5433"
assert_eq "$(stat -c '%a %U' /etc/capstan/db/env)" "600 root"
st="$(/usr/sbin/ufw status verbose)"
printf '%s\n' "$st" | grep -qE '^443 +ALLOW IN +Anywhere' || fail "the host's own 443 rule was removed"
printf '%s\n' "$st" | grep -qE '^22/tcp +ALLOW IN +Anywhere' || fail "22/tcp not allowed"
out2="$(/bin/bash "$dir/provision.sh" --local --egress-ip 203.0.113.10 --db-port 5433 --firewall-additive 2>&1)"; rc2=$?
[ "$rc2" -eq 0 ] || fail "second run exit $rc2"
bad="$(printf '%s\n' "$out2" | grep -v '^skip: ' || true)"
[ -z "$bad" ] || fail "second run printed non-skip lines: $bad"
# compose substitutes the port and stays on 127.0.0.1
grep -qF '"127.0.0.1:${CAPSTAN_DB_PORT:-5432}:5432"' /opt/capstan/compose/capstan-compose.yaml || fail "compose port is not the CAPSTAN_DB_PORT form"
pass
