#!/bin/bash
# R8: the firewall leaves only 22, 80 and 443 open; Postgres and Redis bind to 127.0.0.1 only.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
T_NAME=ports
st="$(/usr/sbin/ufw status verbose 2>&1)"
assert_contains "$st" "Status: active"
assert_contains "$st" "Default: deny (incoming)"
for p in 22 80 443; do printf '%s\n' "$st" | grep -qE "^$p/tcp +ALLOW IN +Anywhere" || fail "port $p not allowed"; done
extra="$(printf '%s\n' "$st" | grep 'ALLOW IN' | grep -vE '^(22|80|443)/tcp( \(v6\))? +ALLOW IN' || true)"
[ -z "$extra" ] || fail "extra allow rules: $extra"
# every published port in the production compose file is on 127.0.0.1
ports="$(grep -E '^\s+ports:' "$SRC/capstan-compose.yaml")"
assert_eq "$(printf '%s\n' "$ports" | wc -l | tr -d ' ')" "2" "two services publish ports"
printf '%s\n' "$ports" | grep -vqE '"127\.0\.0\.1:([0-9]+|\$\{CAPSTAN_DB_PORT:-[0-9]+\}):[0-9]+"' && fail "a port is not bound to 127.0.0.1: $ports"
# Caddy proxies only to 127.0.0.1; env files point the apps at 127.0.0.1 databases
grep -E 'reverse_proxy' "$SRC/Caddyfile.tmpl" | grep -vq '127.0.0.1:' && fail "Caddy proxies to a non-local address"
grep -hE '^(DATABASE_URL|REDIS_URL)=' /etc/capstan/*/env | grep -vqE '@127\.0\.0\.1:|//127\.0\.0\.1:' && fail "an env file points at a non-local database"
pass
