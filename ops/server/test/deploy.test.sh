#!/bin/bash
# R4: a failing health check rolls back to the previous sha and exits non-zero; a good sha deploys.
# R5: two deploys started together run the migrations once (flock here; the database advisory lock in
#     packages/core/src/migrate.ts covers two migrators, proven by packages/core/test single-migrator).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
dir="$(stage_copy)"
export CAPSTAN_SYSTEMCTL="$SRC/test/fake-systemctl.sh" FAKE_SYSTEMCTL_LOG=/tmp/systemctl.log
export CAPSTAN_INSTALL_CMD="true" CAPSTAN_HEALTH_CMD='test -f /opt/capstan/current/HEALTHY' CAPSTAN_HEALTH_TRIES=2 CAPSTAN_HEALTH_SLEEP=0
export CAPSTAN_ALERT_CMD="$SRC/test/fake-alert.sh" FAKE_ALERT_LOG=/tmp/alerts.log
export CAPSTAN_MIGRATE_CMD='sleep 1; echo "$PWD" >> /tmp/migrate.log'
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid

reset() {
  rm -rf /tmp/fake-failed /tmp/repo /opt/capstan/releases/* /opt/capstan/current /opt/capstan/previous /opt/capstan/repo.git /tmp/systemctl.log /tmp/alerts.log /tmp/migrate.log
  mkdir -p /tmp/repo && git -C /tmp/repo init -q -b main
  /usr/local/sbin/capstan-config set REPO_URL /tmp/repo >/dev/null
}
commit() { # name healthy?
  echo "$1" > /tmp/repo/RELEASE
  if [ "$2" = "yes" ]; then echo ok > /tmp/repo/HEALTHY; else rm -f /tmp/repo/HEALTHY; fi
  git -C /tmp/repo add -A && git -C /tmp/repo commit -q -m "$1" && git -C /tmp/repo rev-parse HEAD
}
cur() { basename "$(readlink /opt/capstan/current)"; }

T_NAME=rollback
reset
A="$(commit a yes)"
out="$(/bin/bash "$dir/deploy.sh" "$A" 2>&1)" || fail "good sha A failed: $out"
assert_contains "$out" "deploy: ok $A"
assert_eq "$(cur)" "$A" "A live"
# restart order is the documented one
order="$(grep '^restart' /tmp/systemctl.log | awk '{ print $2 }' | tr '\n' ' ')"
assert_eq "$order" "capstan-workers.service capstan-anchor.service capstan-receipts.service capstan-relay.service capstan-api.service capstan-ws.service capstan-mcp.service capstan-facilitator.service " "restart order"
B="$(commit b no)"
out="$(/bin/bash "$dir/deploy.sh" "$B" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] || fail "failing sha B exited 0"
assert_contains "$out" "deploy: failed $B, rolled back to $A (ok)"
assert_eq "$(cur)" "$A" "rolled back to A"
assert_contains "$(cat /tmp/alerts.log)" '"kind":"deploy.rollback"'
C="$(commit c yes)"
out="$(/bin/bash "$dir/deploy.sh" "${C:0:12}" 2>&1)" || fail "good sha C (short) failed: $out"
assert_eq "$(cur)" "$C" "C live"
assert_eq "$(cat /opt/capstan/previous)" "$A" "previous is A"
out="$(/bin/bash "$dir/deploy.sh" --rollback 2>&1)" || fail "rollback failed: $out"
assert_eq "$(cur)" "$A" "--rollback went back to A"
# refusals: not a sha, unknown sha
/bin/bash "$dir/deploy.sh" 'main; rm -rf /' >/dev/null 2>&1 && fail "accepted a non-sha argument"
/bin/bash "$dir/deploy.sh" deadbeefdeadbeef >/dev/null 2>&1 && fail "accepted an unknown sha"
assert_eq "$(cur)" "$A" "refusals changed nothing"
pass

# The VPS stand-in (2026-11-11): a release that crash-loops its unit runs it into systemd's start limit, and the
# rollback's restart was then refused, so set -e ended the deploy with no rollback and no alert. The deploy now
# clears the failed state before every restart.
T_NAME=rollback-after-start-limit
reset
A="$(commit a yes)"
/bin/bash "$dir/deploy.sh" "$A" >/dev/null 2>&1 || fail "good sha A failed"
B="$(commit b no)"
out="$(CAPSTAN_HEALTH_CMD='test -f /opt/capstan/current/HEALTHY || { mkdir -p /tmp/fake-failed; touch /tmp/fake-failed/capstan-api.service; false; }' /bin/bash "$dir/deploy.sh" "$B" 2>&1)"; rc=$?
assert_eq "$rc" "1" "crash-looping sha B exit code"
assert_contains "$out" "deploy: failed $B, rolled back to $A (ok)"
assert_eq "$(cur)" "$A" "rolled back to A"
assert_contains "$(cat /tmp/alerts.log)" '"kind":"deploy.rollback"'
grep -q '^reset-failed capstan-api.service' /tmp/systemctl.log || fail "no reset-failed before the restart"
pass

T_NAME=single-migrator
reset
D="$(commit d yes)"
/bin/bash "$dir/deploy.sh" "$D" > /tmp/d1.out 2>&1 & p1=$!
/bin/bash "$dir/deploy.sh" "$D" > /tmp/d2.out 2>&1 & p2=$!
wait "$p1"; r1=$?; wait "$p2"; r2=$?
assert_eq "$r1 $r2" "0 0" "both deploys exit 0"
assert_eq "$(wc -l < /tmp/migrate.log | tr -d ' ')" "1" "migrations ran once"
both="$(cat /tmp/d1.out /tmp/d2.out)"
assert_contains "$both" "deploy: ok $D"
assert_contains "$both" "deploy: skip $D (already live)"
pass

# r3d-02: capstan-deploy is granted to the release runner with any argument. Only shas reachable from main deploy, and
# bun installs as the unprivileged install user with --ignore-scripts, never as root; root owns the finished tree.
T_NAME=main-only-and-unprivileged-install
reset
cat > /tmp/fake-bun <<'BUN'
#!/bin/bash
printf '%s|%s|%s\n' "$(id -un)" "$PWD" "$*" >> /tmp/bun.log
BUN
chmod 0755 /tmp/fake-bun; rm -f /tmp/bun.log; : > /tmp/bun.log; chmod 0666 /tmp/bun.log
E="$(commit e yes)"
git -C /tmp/repo checkout -q -b side
F="$(commit f-off-main yes)"
git -C /tmp/repo checkout -q main
out="$(CAPSTAN_INSTALL_CMD= CAPSTAN_BUN=/tmp/fake-bun /bin/bash "$dir/deploy.sh" "$F" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] || fail "a sha off main deployed: $out"
assert_contains "$out" "not on main" "refusal names the reason"
[ ! -e "/opt/capstan/releases/$F" ] || fail "a release dir was made for the off-main sha"
[ ! -s /tmp/bun.log ] || fail "bun ran for an off-main sha: $(cat /tmp/bun.log)"
out="$(CAPSTAN_INSTALL_CMD= CAPSTAN_BUN=/tmp/fake-bun /bin/bash "$dir/deploy.sh" "$E" 2>&1)" || fail "sha E on main failed: $out"
assert_eq "$(cur)" "$E" "E live"
call="$(cat /tmp/bun.log)"
assert_contains "$call" "capstan-install|" "bun ran as the install-only user, not root"
assert_not_contains "$call" "root|" "bun ran as root"
assert_contains "$call" "install --frozen-lockfile --production --ignore-scripts" "lifecycle scripts are off"
assert_eq "$(stat -c %U "/opt/capstan/releases/$E")" "root" "root owns the release tree"
[ -z "$(find "/opt/capstan/releases/$E" ! -user root | head -n 1)" ] || fail "files in the release not owned by root"
pass

# G4-03: the install user used to be capstan-workers, a live service account that could write the new release (which
# the api, relay and facilitator then run) for the length of the install. It is now an install-only account that no
# unit runs as; the tree is closed to everyone else during the install and left with no write bit but root's.
T_NAME=install-only-account
reset
cat > /tmp/fake-bun <<'BUN'
#!/bin/bash
printf '%s|%s|%s\n' "$(id -un)" "$(stat -c '%U %a' "$PWD")" "$*" >> /tmp/bun.log
mkdir -p node_modules/pkg && echo x > node_modules/pkg/index.js && chmod 0666 node_modules/pkg/index.js && chmod 0777 node_modules/pkg
BUN
chmod 0755 /tmp/fake-bun; : > /tmp/bun.log; chmod 0666 /tmp/bun.log
G="$(commit g yes)"
assert_eq "$(getent passwd capstan-install | cut -d: -f7)" "/usr/sbin/nologin" "capstan-install has no login shell"
[ -z "$(grep -lE '^User=capstan-install' /etc/systemd/system/capstan-* 2>/dev/null)" ] || fail "a unit runs as capstan-install"
for u in root capstan-workers capstan-api capstan-facilitator; do
  out="$(CAPSTAN_INSTALL_USER=$u CAPSTAN_INSTALL_CMD= CAPSTAN_BUN=/tmp/fake-bun /bin/bash "$dir/deploy.sh" "$G" 2>&1)"; rc=$?
  [ "$rc" -ne 0 ] || fail "deploy ran with the service account $u as install user"
  assert_contains "$out" "install-only account" "refusal for $u names the reason"
done
[ ! -s /tmp/bun.log ] || fail "bun ran with a service account as install user: $(cat /tmp/bun.log)"
[ ! -e "/opt/capstan/releases/$G" ] || fail "a release dir was made with a service account as install user"
out="$(CAPSTAN_INSTALL_CMD= CAPSTAN_BUN=/tmp/fake-bun /bin/bash "$dir/deploy.sh" "$G" 2>&1)" || fail "deploy with the default install user failed: $out"
assert_eq "$(cur)" "$G" "G live"
call="$(cat /tmp/bun.log)"
assert_contains "$call" "capstan-install|capstan-install 700|" "bun ran as capstan-install in a tree only it can open"
assert_contains "$call" "--ignore-scripts" "lifecycle scripts stay off"
rel="/opt/capstan/releases/$G"
[ -z "$(find "$rel" ! -user root | head -n 1)" ] || fail "files in the release not owned by root"
[ -z "$(find "$rel" -perm /022 | head -n 1)" ] || fail "group or other can write in the release: $(find "$rel" -perm /022 | head -n 3)"
[ -r "$rel/node_modules/pkg/index.js" ] && runuser -u capstan-api -- test -r "$rel/node_modules/pkg/index.js" || fail "services cannot read the release"
! runuser -u capstan-workers -- test -w "$rel/node_modules/pkg/index.js" || fail "capstan-workers can write the release"
pass
