#!/bin/bash
# R1: provision.sh run twice leaves the same state; the second run prints only "skip" lines.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
T_NAME=idempotent-twice
dir="$(stage_copy)"
snapshot() {
  { getent passwd | grep '^capstan-' | sort
    getent group | grep '^capstan-' | sort
    find /etc/capstan /opt/capstan /var/log/capstan /usr/local/sbin /usr/local/lib/capstan /etc/systemd/system -path /etc/systemd/system/multi-user.target.wants -prune -o -print 2>/dev/null | sort | while read -r p; do stat -c '%n %a %U:%G' "$p"; done
    find /etc/capstan /opt/capstan/compose /usr/local/sbin /etc/systemd/system/capstan-* /etc/sudoers.d/capstan /etc/logrotate.d/capstan /etc/systemd/journald.conf.d/capstan.conf -type f 2>/dev/null | sort | xargs sha256sum
    /usr/sbin/ufw status verbose
    /usr/local/bin/bun --version; } 2>&1
}
out1="$(/bin/bash "$dir/provision.sh" --local --egress-ip 203.0.113.10 2>&1)"; rc1=$?
[ "$rc1" -eq 0 ] || fail "first run exit $rc1: $(printf '%s' "$out1" | tail -n 20)"
assert_contains "$out1" "done: unix users"
assert_contains "$out1" "done: bun 1.4.4"
s1="$(snapshot)"
out2="$(/bin/bash "$dir/provision.sh" --local --egress-ip 203.0.113.10 2>&1)"; rc2=$?
[ "$rc2" -eq 0 ] || fail "second run exit $rc2"
bad="$(printf '%s\n' "$out2" | grep -v '^skip: ' || true)"
[ -z "$bad" ] || fail "second run printed non-skip lines: $bad"
s2="$(snapshot)"
[ "$s1" = "$s2" ] || fail "state changed on the second run: $(diff <(echo "$s1") <(echo "$s2") | head -n 20)"
# one line per stage, and every line is skip or done
n="$(printf '%s\n' "$out1" | grep -cvE '^(skip|done): ')"
assert_eq "$n" "0" "first run printed lines that are not stage lines"
# the database password exists, is 0600 root, and was never printed
assert_eq "$(stat -c '%a %U' /etc/capstan/db/password)" "600 root"
assert_not_contains "$out1" "$(cat /etc/capstan/db/password)"
# every template placeholder is filled (the VPS stand-in found OTLP_FILE=/var/log/capstan/@SVC@/spans.jsonl)
left="$(grep -l '@[A-Z_]*@' /etc/capstan/*/env 2>/dev/null || true)"
assert_eq "$left" "" "env files with an unfilled @PLACEHOLDER@"
assert_eq "$(grep '^OTLP_FILE=' /etc/capstan/api/env)" "OTLP_FILE=/var/log/capstan/api/spans.jsonl"
# with "admin off" in the Caddyfile, caddy cannot reload; provision must restart it (the stand-in proves the restart)
if grep -q 'admin off' "$SRC/Caddyfile.tmpl" && grep -qE 'systemctl (reload|reload-or-restart) caddy' "$SRC/provision.sh"; then fail "provision reloads caddy, but the Caddyfile turns the admin API off"; fi
pass
