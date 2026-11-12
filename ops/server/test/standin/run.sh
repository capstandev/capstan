#!/bin/bash
# The whole VPS setup in a local stand-in (tracker line 80): a Debian 12 container booting real systemd, with its own
# Docker engine inside (Postgres and Redis run there, as on the VPS). Prints PASS or FAIL per step, then a total.
#   /bin/bash ops/server/test/standin/run.sh            (from the repo root; macOS bash 3.2 or Linux bash)
# Env: CAPSTAN_VPS_HTTPS_PORT (25560) and CAPSTAN_VPS_HTTP_PORT (25561) on 127.0.0.1; CAPSTAN_VPS_KEEP=1 keeps the
# container afterwards; CAPSTAN_VPS_LOG (a folder for the full log). The deployed releases come from this repo's
# HEAD (A), plus two commits made only inside the stand-in: B (a marker file) and C (an api that throws at start).
# Throwaway keys only: the service keystores and the age identity are made inside the container and die with it.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
srv="$(cd "$here/../.." && pwd -P)"
root="$(cd "$srv/../.." && pwd -P)"
DOCKER="${DOCKER:-$(command -v docker || echo /opt/homebrew/bin/docker)}"
NAME="capstan-vps-host"; IMAGE="capstan-vps-standin:debian12"; VOL="capstan-vps-docker"; VOL2="capstan-vps-containerd"
HTTPS_PORT="${CAPSTAN_VPS_HTTPS_PORT:-25560}"; HTTP_PORT="${CAPSTAN_VPS_HTTP_PORT:-25561}"
DOMAIN="capstan.test"
LOGD="${CAPSTAN_VPS_LOG:-$(mktemp -d "${TMPDIR:-/tmp}/capstan-vps.XXXXXX")}"; mkdir -p "$LOGD"; LOG="$LOGD/standin.log"; : > "$LOG"
passed=0; failed=0

res() { # res PASS|FAIL name detail
  printf '%s %s%s\n' "$1" "$2" "${3:+: $3}"; printf '%s %s%s\n' "$1" "$2" "${3:+: $3}" >> "$LOG"
  if [ "$1" = "PASS" ]; then passed=$((passed + 1)); else failed=$((failed + 1)); fi
}
on() { "$DOCKER" exec "$NAME" /bin/bash -c "$1"; } # run a snippet as root on the stand-in host
step() { # step name snippet: PASS when the snippet exits 0; its last output line is the detail
  printf '\n== %s\n' "$1" >> "$LOG"
  out="$(on "$2" 2>&1)"; rc=$?
  printf '%s\n' "$out" >> "$LOG"
  last="$(printf '%s\n' "$out" | grep . | tail -n 1 | cut -c1-160)"
  if [ "$rc" -eq 0 ]; then res PASS "$1" "$last"; return 0; fi
  res FAIL "$1" "exit $rc, $last"; return 1
}
finish() {
  echo "standin: $passed passed, $failed failed (full log: $LOG)"
  [ "$failed" -eq 0 ]
}
stop_here() { res FAIL "$1" "later steps need it; stopping"; finish; exit 1; }
cleanup() {
  [ "${CAPSTAN_VPS_KEEP:-0}" = "1" ] && { echo "standin: kept $NAME (remove: docker rm -f $NAME; docker volume rm $VOL $VOL2)"; return; }
  "$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true
  "$DOCKER" volume rm "$VOL" "$VOL2" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------- the stand-in host
"$DOCKER" rm -f "$NAME" >/dev/null 2>&1; "$DOCKER" volume rm "$VOL" "$VOL2" >/dev/null 2>&1
trap cleanup EXIT
if "$DOCKER" build -q -t "$IMAGE" "$here" >> "$LOG" 2>&1; then res PASS "image (debian 12, systemd, cast 1.8.4)"; else stop_here "image build"; fi
# Image layers live in /var/lib/docker and /var/lib/containerd: both on volumes, since overlayfs cannot nest on the
# container's own overlay root (whiteouts fail with "operation not permitted").
# privileged: systemd as PID 1, an inner Docker engine and ufw's iptables need it (a VPS has all three)
"$DOCKER" run -d --name "$NAME" --hostname capstan-vps --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock -v "$VOL:/var/lib/docker" -v "$VOL2:/var/lib/containerd" \
  -p "127.0.0.1:$HTTPS_PORT:443" -p "127.0.0.1:$HTTP_PORT:80" "$IMAGE" >> "$LOG" 2>&1 || stop_here "start container"
step "boot (systemd is PID 1)" 'for i in $(seq 1 60); do s="$(systemctl is-system-running 2>/dev/null)"; case "$s" in running|degraded) break ;; esac; sleep 1; done; [ "$(ps -o comm= -p 1)" = systemd ] || exit 1; grep -q memory /sys/fs/cgroup/system.slice/cgroup.subtree_control && echo "systemd $s, cgroup controllers delegated"' || stop_here "boot"

# ---------------------------------------------------------------- provision (what provision.sh <host> runs over ssh)
"$DOCKER" exec "$NAME" mkdir -p /tmp/capstan-provision
COPYFILE_DISABLE=1 /usr/bin/tar -C "$srv/.." --exclude 'server/test' -cf - server | "$DOCKER" exec -i "$NAME" tar -C /tmp/capstan-provision -xf - 2>/dev/null || stop_here "copy ops/server"
COPYFILE_DISABLE=1 /usr/bin/tar -C "$here/.." -cf - standin | "$DOCKER" exec -i "$NAME" tar -C /tmp/capstan-provision -xf - 2>/dev/null || stop_here "copy the stand-in tools"
P="CAPSTAN_CADDY_LOCAL_CA=1 /bin/bash /tmp/capstan-provision/server/provision.sh --local --egress-ip 203.0.113.10 --domain $DOMAIN"
step "provision, first run" "$P > /root/provision-1.out 2>&1; rc=\$?; cat /root/provision-1.out; exit \$rc" || stop_here "provision"
step "server settings (capstan-config)" 'capstan-config set ACME_EMAIL ops@capstan.test && capstan-config set REPO_URL /srv/capstan.git && mkdir -p /root/standin-age && chmod 700 /root/standin-age && age-keygen -o /root/standin-age/identity 2>/dev/null && capstan-config set AGE_RECIPIENT "$(age-keygen -y /root/standin-age/identity)" && capstan-config get DOMAIN'
step "provision, second run renders the Caddyfile (local CA)" "$P 2>&1 | grep 'caddyfile' && grep -q '^\s*local_certs' /etc/caddy/Caddyfile && systemctl is-active --quiet caddy"
step "provision, third run prints only skip lines" "out=\"\$($P 2>&1)\" || { echo \"\$out\"; exit 1; }; bad=\"\$(printf '%s\n' \"\$out\" | grep -v '^skip: ')\"; [ -z \"\$bad\" ] || { echo \"not skip: \$bad\"; exit 1; }; echo \"\$(printf '%s\n' \"\$out\" | wc -l) skip lines\""
step "users, folders and env files (8 services)" 'n=0; for s in api ws relay mcp workers facilitator anchor receipts; do f=/etc/capstan/$s/env; [ "$(stat -c "%a %U:%G" $f)" = "640 root:capstan-$s" ] || { echo "bad $f"; exit 1; }; grep -q "@[A-Z_]*@" $f && { echo "placeholder left in $f: $(grep -o "@[A-Z_]*@" $f | sort -u | tr "\n" " ")"; exit 1; }; n=$((n+1)); done; [ "$(stat -c %a /etc/capstan/db/password)" = 600 ] || exit 1; echo "$n env files 0640, no placeholders, db password 0600"'
step "units installed and enabled, backup timer running" 'systemd-analyze verify /etc/systemd/system/capstan-*.service /etc/systemd/system/capstan-*.timer 2>&1 | grep -v "^$" | grep -iv "docker.service" ; for u in capstan-db capstan-api capstan-ws capstan-relay capstan-mcp capstan-facilitator capstan-workers capstan-anchor capstan-receipts; do systemctl is-enabled --quiet $u.service || { echo "$u not enabled"; exit 1; }; done; systemctl is-enabled --quiet capstan-backup.timer && systemctl is-active --quiet capstan-backup.timer && n="$(systemctl show -p NextElapseUSecRealtime --value capstan-backup.timer)" && [ -n "$n" ] && echo "9 services enabled, backup timer active (next: $n)"'

# ---------------------------------------------------------------- settings, databases, keys
step "postgres and redis (capstan-db.service), 127.0.0.1 only" 'systemctl start capstan-db.service || { journalctl -u capstan-db -n 20 --no-pager; exit 1; }; docker exec capstan-db-postgres pg_isready -U capstan -d capstan >/dev/null && [ "$(docker exec capstan-db-redis redis-cli ping)" = PONG ] || exit 1; b="$(ss -Hltn | awk "{print \$4}" | grep -E ":(5432|6379)\$" | sort -u | tr "\n" " ")"; echo "$b" | grep -vqE "(^| )(0\.0\.0\.0|\[::\]|\*):" && echo "listening: $b"' || stop_here "databases"
for s in receipts anchor facilitator; do
  step "service key: $s (make-service-key.sh, hidden prompts)" "expect /tmp/capstan-provision/standin/make-key.exp $s testnet | tail -n 1 | grep -E '^0x[0-9a-fA-F]{40}\$' >/dev/null && [ \"\$(stat -c '%a %U' /etc/capstan/$s/keystore.json /etc/capstan/$s/keystore.password | sort -u)\" = '600 capstan-$s' ] && echo 'keystore and password file 0600 capstan-$s'"
done

# ---------------------------------------------------------------- releases A, B, C in a repo on the box
git -C "$root" bundle create "$LOGD/repo.bundle" HEAD >> "$LOG" 2>&1 || stop_here "git bundle of HEAD"
"$DOCKER" cp "$LOGD/repo.bundle" "$NAME:/root/repo.bundle" >> "$LOG" 2>&1
step "release repo (A = HEAD, B, C)" 'set -e; G="git -c user.name=standin -c user.email=standin@capstan.test"; git init -q --bare -b main /srv/capstan.git; git -C /srv/capstan.git fetch -q /root/repo.bundle HEAD:refs/heads/main; rm -rf /root/work; git clone -q /srv/capstan.git /root/work; cd /root/work; A=$(git rev-parse HEAD); echo "stand-in release B" > STANDIN_RELEASE; git add STANDIN_RELEASE; $G commit -qm "test: stand-in release B"; B=$(git rev-parse HEAD); sed -i "1i throw new Error(\"stand-in: broken release C\");" apps/api/src/index.ts; $G commit -qam "test: stand-in release C (api throws at start)"; C=$(git rev-parse HEAD); git push -q origin HEAD:refs/heads/main; git checkout -q -b side; echo "off main" > STANDIN_SIDE; git add STANDIN_SIDE; $G commit -qm "test: stand-in commit off main"; D=$(git rev-parse HEAD); git push -q origin HEAD:refs/heads/side; printf "%s\n" "$A" "$B" "$C" "$D" > /root/shas; echo "A=${A:0:7} B=${B:0:7} C=${C:0:7} D=${D:0:7} (D off main)"' || stop_here "release repo"
A="$(on 'sed -n 1p /root/shas')"; B="$(on 'sed -n 2p /root/shas')"; C="$(on 'sed -n 3p /root/shas')"; D="$(on 'sed -n 4p /root/shas')"

HEALTH='for hp in 8710/v1/health 8711/health 8712/health 8713/health 8714/health; do curl -fsS -m 3 -o /dev/null http://127.0.0.1:$hp || { echo "down: $hp"; exit 1; }; done'
step "deploy refuses a sha off main (r3d-02)" "out=\"\$(capstan-deploy $D 2>&1)\"; rc=\$?; echo \"\$out\" | tail -n 1; [ \$rc -ne 0 ] && echo \"\$out\" | grep -q 'not on main' && [ ! -e /opt/capstan/releases/$D ] && [ ! -e /opt/capstan/current ]"
step "deploy A (first release)" "capstan-deploy $A 2>&1 | tail -n 3; [ \"\$(basename \"\$(readlink /opt/capstan/current)\")\" = $A ] || { tail -n 30 /var/log/capstan/ops/deploy.log; for s in api ws relay mcp workers facilitator anchor receipts; do systemctl is-active capstan-\$s >/dev/null || { echo \"== \$s\"; tail -n 15 /var/log/capstan/\$s/\$s.jsonl; }; done; exit 1; }" || stop_here "deploy A"
step "health checks (8 units active, 5 ports, MCP with the public Host)" "for s in api ws relay mcp workers facilitator anchor receipts; do systemctl is-active --quiet capstan-\$s || { echo \"\$s not active\"; exit 1; }; done; $HEALTH; c=\$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Host: api.$DOMAIN' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' http://127.0.0.1:8713/mcp); [ \"\$c\" = 200 ] && echo 'all healthy, mcp tools/list 200'"
# HTTPS through Caddy from this Mac, trusting only the stand-in's local CA
"$DOCKER" cp "$NAME:/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt" "$LOGD/standin-ca.crt" >> "$LOG" 2>&1
hdr="$(curl -sS -m 10 -D - -o "$LOGD/https-api.json" --cacert "$LOGD/standin-ca.crt" --resolve "api.$DOMAIN:$HTTPS_PORT:127.0.0.1" "https://api.$DOMAIN:$HTTPS_PORT/v1/health" 2>&1)"; printf '%s\n' "$hdr" >> "$LOG"
if printf '%s' "$hdr" | grep -q '^HTTP/[0-9.]* 200' && printf '%s' "$hdr" | grep -qi '^strict-transport-security' && ! printf '%s' "$hdr" | grep -qi '^server:'; then res PASS "https api.$DOMAIN via caddy (local CA, HSTS, no Server header)"; else res FAIL "https api.$DOMAIN via caddy" "$(printf '%s' "$hdr" | head -n 1)"; fi
wsc="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' --cacert "$LOGD/standin-ca.crt" --resolve "ws.$DOMAIN:$HTTPS_PORT:127.0.0.1" "https://ws.$DOMAIN:$HTTPS_PORT/health" 2>&1)"
if [ "$wsc" = "200" ]; then res PASS "https ws.$DOMAIN via caddy"; else res FAIL "https ws.$DOMAIN via caddy" "http $wsc"; fi
plain="$(curl -sS -m 10 -o /dev/null -w '%{http_code} %{redirect_url}' -H "Host: api.$DOMAIN" "http://127.0.0.1:$HTTP_PORT/v1/health" 2>&1)"
case "$plain" in 30[18]\ https://api.$DOMAIN/*) res PASS "http redirects to https" "$plain" ;; *) res FAIL "http redirects to https" "$plain" ;; esac

step "second deploy B (by a capstan-ops member through sudo)" "id owner >/dev/null 2>&1 || useradd -m -G capstan-ops -s /bin/bash owner; runuser -u owner -- sudo -n /usr/local/sbin/capstan-deploy $B | tail -n 1; [ \"\$(basename \"\$(readlink /opt/capstan/current)\")\" = $B ] && [ \"\$(cat /opt/capstan/previous)\" = $A ] && $HEALTH && echo 'current B, previous A, healthy'"
step "owner sudo is narrow (no shell, no other command)" 'runuser -u owner -- sudo -n /bin/bash -c true 2>/dev/null && { echo "owner got a root shell"; exit 1; }; runuser -u owner -- sudo -n /usr/local/sbin/capstan-backup 2>/dev/null && { echo "owner ran backup"; exit 1; }; echo "only deploy, relay-flag, status"'
step "failed deploy C rolls back to B by itself" "out=\"\$(capstan-deploy $C 2>&1)\"; rc=\$?; echo \"\$out\" | tail -n 2; [ \$rc -eq 1 ] && echo \"\$out\" | grep -q 'rolled back to $B (ok)' && [ \"\$(basename \"\$(readlink /opt/capstan/current)\")\" = $B ] && grep -q 'alert .*deploy.rollback' /var/log/capstan/ops/deploy.log && $HEALTH && echo \"exit 1, live on B, alert raised, healthy (\$(grep -c 'stand-in: broken release C' /var/log/capstan/api/api.jsonl) api crash lines logged)\""
step "deploy --rollback goes back to A" "capstan-deploy --rollback | tail -n 1; [ \"\$(basename \"\$(readlink /opt/capstan/current)\")\" = $A ] && $HEALTH && echo 'live on A, healthy'"

# ---------------------------------------------------------------- logs, backups, firewall
step "log rotation (logrotate, journald 7 days)" 'logrotate -d /etc/logrotate.d/capstan >/dev/null 2>&1 || exit 1; logrotate -f -s /root/logrotate.state /etc/logrotate.d/capstan || exit 1; d=$(date +%Y%m%d); n=$(ls /var/log/capstan/*/*.jsonl-$d* 2>/dev/null | wc -l); [ "$n" -ge 8 ] || { echo "only $n rotated"; exit 1; }; curl -fsS -o /dev/null http://127.0.0.1:8710/v1/health; sleep 2; for s in api ws relay mcp workers facilitator anchor receipts; do systemctl is-active --quiet capstan-$s || exit 1; done; grep -q "^MaxRetentionSec=7day" /etc/systemd/journald.conf.d/capstan.conf && echo "$n files rotated to -$d, services still writing, journald 7 days"'
step "backup (capstan-backup.service, age encrypted)" 'systemctl start capstan-backup.service || { journalctl -u capstan-backup -n 20 --no-pager; exit 1; }; f=$(ls -1 /var/backups/capstan/daily/capstan-*.dump.age | tail -n 1); [ -s "$f" ] && [ -s "$f.counts" ] && [ "$(stat -c %a /var/backups/capstan)" = 700 ] && head -c 22 "$f" | grep -q "age-encryption.org/v1" && echo "$(basename "$f") $(stat -c %s "$f") bytes, $(wc -l < "$f.counts") tables counted"'
step "restore test (capstan-restore-test)" 'capstan-restore-test --identity /root/standin-age/identity | tail -n 1 | tee /dev/stderr | grep -q "^restore-test: ok" && ! docker exec capstan-db-postgres psql -U capstan -qAtc "SELECT 1 FROM pg_database WHERE datname = '"'"'capstan_restore_test'"'"'" | grep -q 1'
step "provision after a settings change re-renders and reloads caddy" "capstan-config set ACME_EMAIL ops2@capstan.test && $P 2>&1 | grep caddyfile && grep -q 'email ops2@capstan.test' /etc/caddy/Caddyfile && systemctl is-active --quiet caddy && curl -fsS -m 5 -o /dev/null --cacert /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt --resolve api.$DOMAIN:443:127.0.0.1 https://api.$DOMAIN/v1/health && echo 'caddy serves the new config'"
step "firewall: only 22, 80, 443 open (ufw)" 'ufw status verbose | tee /root/ufw.txt >/dev/null; grep -q "^Status: active" /root/ufw.txt && grep -q "Default: deny (incoming)" /root/ufw.txt || exit 1; open="$(grep "ALLOW IN" /root/ufw.txt | awk "{print \$1}" | sort -u | tr "\n" " ")"; [ "$open" = "22/tcp 443/tcp 80/tcp " ] || { echo "open: $open"; exit 1; }; echo "allow in: $open"'
on 'cat /root/ufw.txt' >> "$LOG" 2>&1

finish
