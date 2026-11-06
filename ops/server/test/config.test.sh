#!/bin/bash
# R9: the relay egress IP is written once; a change needs --i-have-a-reapproval-plan. Also the relay flag wrapper.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
T_NAME=egress-ip-guard
dir="$(stage_copy)"
c=/usr/local/sbin/capstan-config
# provision wrote 203.0.113.10 (provision.test.sh)
assert_eq "$($c get RELAY_EGRESS_IP)" "203.0.113.10"
assert_contains "$(cat /etc/capstan/api/env)" "RELAY_EGRESS_IP=203.0.113.10"
out="$($c set RELAY_EGRESS_IP 203.0.113.10 2>&1)" || fail "same value refused: $out"
assert_contains "$out" "skip: RELAY_EGRESS_IP unchanged"
if out="$($c set RELAY_EGRESS_IP 198.51.100.7 2>&1)"; then fail "a change without the flag was accepted"; fi
assert_contains "$out" "--i-have-a-reapproval-plan"
assert_eq "$($c get RELAY_EGRESS_IP)" "203.0.113.10" "value kept after refusal"
# provision with another IP is refused the same way
if /bin/bash "$dir/provision.sh" --local --egress-ip 198.51.100.7 >/tmp/prov.out 2>&1; then fail "provision changed the egress IP"; fi
out="$($c set RELAY_EGRESS_IP 198.51.100.7 --i-have-a-reapproval-plan 2>&1)" || fail "flagged change refused: $out"
assert_eq "$($c get RELAY_EGRESS_IP)" "198.51.100.7"
assert_contains "$(cat /etc/capstan/api/env)" "RELAY_EGRESS_IP=198.51.100.7"
assert_contains "$(tail -n 1 /var/log/capstan/ops/config.log)" "RELAY_EGRESS_IP 203.0.113.10 -> 198.51.100.7"
if $c set RELAY_EGRESS_IP 'x; rm' --i-have-a-reapproval-plan >/dev/null 2>&1; then fail "a non-IP value was accepted"; fi
$c set RELAY_EGRESS_IP 203.0.113.10 --i-have-a-reapproval-plan >/dev/null
pass

T_NAME=relay-flag
export CAPSTAN_SYSTEMCTL="$SRC/test/fake-systemctl.sh" FAKE_SYSTEMCTL_LOG=/tmp/flag-systemctl.log
rm -f /tmp/flag-systemctl.log
out="$(SUDO_USER=ops1 /usr/local/sbin/capstan-relay-flag ASTER_ENABLED off 2>&1)" || fail "flag off: $out"
assert_eq "$out" "flag: ASTER_ENABLED=0"
grep -qx 'ASTER_ENABLED=0' /etc/capstan/relay/env || fail "flag not written"
assert_contains "$(tail -n 1 /var/log/capstan/ops/flags.log)" "ops1 ASTER_ENABLED off"
assert_eq "$(cat /tmp/flag-systemctl.log)" "restart capstan-relay.service"
assert_eq "$(/usr/local/sbin/capstan-relay-flag ASTER_ENABLED off 2>&1)" "flag: ASTER_ENABLED=0 (unchanged)"
/usr/local/sbin/capstan-relay-flag ASTER_ENABLED on >/dev/null
grep -qx 'ASTER_ENABLED=1' /etc/capstan/relay/env || fail "flag not restored"
/usr/local/sbin/capstan-relay-flag SOMETHING_ENABLED off >/dev/null 2>&1 && fail "unknown flag accepted"
# Caddyfile renders once DOMAIN and ACME_EMAIL are set, and Caddy accepts it
c=/usr/local/sbin/capstan-config
$c set DOMAIN example.test >/dev/null; $c set ACME_EMAIL ops@example.test >/dev/null
out="$(/bin/bash "$dir/provision.sh" --local 2>&1)" || fail "provision after DOMAIN: $out"
assert_contains "$out" "done: caddyfile"
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy.out 2>&1 || fail "caddy validate: $(grep -iE "error|invalid" /tmp/caddy.out | tail -n 3)"
grep -q 'api.example.test' /etc/caddy/Caddyfile || fail "domain not rendered"
pass
