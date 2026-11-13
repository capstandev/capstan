#!/bin/bash
# Cherry box gaps (handoffs/cherry-server.md, 2026-11-12): with DOMAIN set and ACME_EMAIL empty, provision renders the
# Caddyfile without an email line and the additive firewall opens 80/443; a new DOMAIN reaches env files that an
# earlier run wrote (PUBLIC_API_HOST, the first MCP_ALLOWED_HOSTS entry). Runs after sharedhost.test.sh.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
T_NAME=domain-without-acme-email
dir="$(stage_copy)"
setkv() { awk -F= -v k="$1" -v v="$2" '$1 == k { print k "=" v; next } { print }' "$3" > "$3.t" && cat "$3.t" > "$3" && rm -f "$3.t"; }
setkv ACME_EMAIL "" /etc/capstan/server.conf
/bin/rm -f /etc/caddy/Caddyfile
/usr/sbin/ufw delete allow 80/tcp >/dev/null 2>&1; /usr/sbin/ufw delete allow 443/tcp >/dev/null 2>&1
/usr/sbin/ufw status | grep -qE '^80/tcp ' && fail "setup: 80/tcp still allowed"
# an owner edit on another MCP_ALLOWED_HOSTS entry and another line must survive
setkv MCP_ALLOWED_HOSTS "localhost:8710,127.0.0.1:8713,mcp.owner.test" /etc/capstan/mcp/env
echo "OWNER_LINE=kept" >> /etc/capstan/api/env
before="$(stat -c '%a %U:%G' /etc/capstan/api/env)"
out1="$(/bin/bash "$dir/provision.sh" --local --egress-ip 203.0.113.10 --db-port 5433 --firewall-additive --domain other.test 2>&1)"; rc1=$?
[ "$rc1" -eq 0 ] || fail "run exit $rc1: $(printf '%s' "$out1" | tail -n 10)"
assert_contains "$out1" "done: caddyfile"
[ -f /etc/caddy/Caddyfile ] || fail "no Caddyfile with ACME_EMAIL empty"
grep -q 'api.other.test' /etc/caddy/Caddyfile || fail "domain not rendered"
if grep -qE 'email|@ACME_EMAIL@|@DOMAIN@' /etc/caddy/Caddyfile; then fail "email line or placeholder left: $(grep -nE 'email|@' /etc/caddy/Caddyfile | head -n 3)"; fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy.out 2>&1 || fail "caddy validate: $(grep -iE "error|invalid" /tmp/caddy.out | tail -n 3)"
st="$(/usr/sbin/ufw status verbose)"
for p in 22 80 443; do printf '%s\n' "$st" | grep -qE "^$p/tcp +ALLOW IN +Anywhere" || fail "port $p/tcp not allowed with DOMAIN set"; done
for s in api ws relay mcp workers facilitator anchor receipts; do
  assert_eq "$(grep '^PUBLIC_API_HOST=' "/etc/capstan/$s/env")" "PUBLIC_API_HOST=api.other.test" "$s env"
done
assert_eq "$(grep '^MCP_ALLOWED_HOSTS=' /etc/capstan/mcp/env)" "MCP_ALLOWED_HOSTS=api.other.test,127.0.0.1:8713,mcp.owner.test"
grep -qx 'OWNER_LINE=kept' /etc/capstan/api/env || fail "an owner line was lost"
assert_eq "$(stat -c '%a %U:%G' /etc/capstan/api/env)" "$before" "env mode or owner changed"
out2="$(/bin/bash "$dir/provision.sh" --local --egress-ip 203.0.113.10 --db-port 5433 --firewall-additive --domain other.test 2>&1)"; rc2=$?
[ "$rc2" -eq 0 ] || fail "second run exit $rc2"
bad="$(printf '%s\n' "$out2" | grep -v '^skip: ' || true)"
[ -z "$bad" ] || fail "second run printed non-skip lines: $bad"
pass
