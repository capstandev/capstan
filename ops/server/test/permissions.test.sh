#!/bin/bash
# R2: each service runs as its own user and can read only its own /etc/capstan/<svc> (permission matrix).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
T_NAME=isolation
SVCS="api ws relay mcp workers facilitator anchor receipts"
for s in receipts anchor facilitator; do # a keystore-shaped file per key service, like make-service-key leaves it
  echo '{"address":"00"}' > "/etc/capstan/$s/keystore.json"; chmod 600 "/etc/capstan/$s/keystore.json"; chown "capstan-$s:capstan-$s" "/etc/capstan/$s/keystore.json"
done
checked=0
for a in $SVCS; do
  for b in $SVCS; do
    if runuser -u "capstan-$a" -- cat "/etc/capstan/$b/env" >/dev/null 2>&1; then r=read; else r=denied; fi
    if [ "$a" = "$b" ]; then assert_eq "$r" read "capstan-$a reading its own env"; else assert_eq "$r" denied "capstan-$a reading /etc/capstan/$b/env"; fi
    if runuser -u "capstan-$a" -- ls "/etc/capstan/$b" >/dev/null 2>&1; then l=list; else l=denied; fi
    if [ "$a" != "$b" ]; then assert_eq "$l" denied "capstan-$a listing /etc/capstan/$b"; fi
    checked=$((checked + 1))
  done
  if runuser -u "capstan-$a" -- cat /etc/capstan/db/password >/dev/null 2>&1; then fail "capstan-$a can read the database password"; fi
  if runuser -u "capstan-$a" -- cat /etc/capstan/server.conf >/dev/null 2>&1; then fail "capstan-$a can read server.conf"; fi
  # the service user cannot write its own env file (only root edits it)
  if runuser -u "capstan-$a" -- sh -c "echo x >> /etc/capstan/$a/env" 2>/dev/null; then fail "capstan-$a can write its env file"; fi
  # a service user has no login shell
  assert_eq "$(getent passwd "capstan-$a" | cut -d: -f7)" "/usr/sbin/nologin"
done
assert_eq "$checked" "64" "matrix size"
for s in receipts anchor facilitator; do
  runuser -u "capstan-$s" -- cat "/etc/capstan/$s/keystore.json" >/dev/null 2>&1 || fail "capstan-$s cannot read its own keystore"
  runuser -u capstan-api -- cat "/etc/capstan/$s/keystore.json" >/dev/null 2>&1 && fail "capstan-api can read the $s keystore"
done
# unit files: own user, own env file, hardening, only its own /etc/capstan folder visible
for s in $SVCS; do
  u="/etc/systemd/system/capstan-$s.service"
  for line in "User=capstan-$s" "EnvironmentFile=/etc/capstan/$s/env" "NoNewPrivileges=yes" "ProtectSystem=strict" "PrivateTmp=yes" "Restart=on-failure" "ReadWritePaths=/var/log/capstan/$s" "TemporaryFileSystem=/etc/capstan:ro" "BindReadOnlyPaths=/etc/capstan/$s"; do
    grep -qxF "$line" "$u" || fail "$u lacks $line"
  done
done
if command -v systemd-analyze >/dev/null 2>&1; then
  out="$(cd /etc/systemd/system && systemd-analyze verify capstan-*.service capstan-*.timer capstan-workers.target 2>&1 | grep -iE 'unknown|invalid|bad' || true)"
  [ -z "$out" ] || fail "systemd-analyze: $out"
fi
pass
