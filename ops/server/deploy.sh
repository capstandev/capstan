#!/bin/bash
# Deploy one git sha of the private repo (installed as /usr/local/sbin/capstan-deploy, run with sudo).
#   sudo capstan-deploy <git-sha>      fetch, install, migrate once, restart in order, health check
#   sudo capstan-deploy --rollback     deploy the previous release again
# On a failed health check it rolls back to the previous release by itself, raises an ops alert and exits 1.
# One deploy at a time (flock); the migrator also holds the database advisory lock (packages/core/src/migrate.ts),
# so two deploys started together run the migrations once. Migrations only move forward: a rollback restarts the
# old code on the newer schema (every migration is additive by review).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
if [ -f "$here/lib.sh" ]; then . "$here/lib.sh"; else . /usr/local/lib/capstan/lib.sh; fi

SYSTEMCTL="${CAPSTAN_SYSTEMCTL:-/bin/systemctl}"
GIT="${CAPSTAN_GIT:-/usr/bin/git}"
BUN="${CAPSTAN_BUN:-/usr/local/bin/bun}"
LOCK="${CAPSTAN_DEPLOY_LOCK:-/run/capstan-deploy.lock}"
HEALTH_TRIES="${CAPSTAN_HEALTH_TRIES:-20}"
HEALTH_SLEEP="${CAPSTAN_HEALTH_SLEEP:-2}"
REL="$CAPSTAN_OPT/releases"
CUR="$CAPSTAN_OPT/current"
PREV_FILE="$CAPSTAN_OPT/previous"
CACHE="$CAPSTAN_OPT/repo.git"

arg="${1:-}"
[ -n "$arg" ] || die "usage: capstan-deploy <git-sha> | --rollback"
require_root
/bin/mkdir -p "$REL" "$CAPSTAN_LOG/ops"
exec 9> "$LOCK"
/usr/bin/flock 9

log() { printf '%s %s\n' "$(utc_now)" "$*" >> "$CAPSTAN_LOG/ops/deploy.log"; }
current_sha() { [ -L "$CUR" ] && basename "$(/usr/bin/readlink "$CUR")" || true; }

alert() { # kind json-detail
  ev="{\"kind\":\"$1\",\"severity\":\"critical\",\"detail\":$2,\"ts\":\"$(utc_now)\"}"
  log "alert $ev"
  if [ -n "${CAPSTAN_ALERT_CMD:-}" ]; then "$CAPSTAN_ALERT_CMD" "$ev" || true
  elif [ -x /usr/bin/docker ]; then /usr/bin/docker exec capstan-db-redis redis-cli RPUSH capstan:ops-alert:queue "$ev" >/dev/null 2>&1 || true
  fi
}

restart_all() {
  for s in $CAPSTAN_RESTART_ORDER; do "$SYSTEMCTL" restart "capstan-$s.service"; done
}

health() { # true when every service answers (or the test override says so)
  if [ -n "${CAPSTAN_HEALTH_CMD:-}" ]; then /bin/bash -c "$CAPSTAN_HEALTH_CMD"; return; fi
  for s in $CAPSTAN_RESTART_ORDER; do "$SYSTEMCTL" is-active --quiet "capstan-$s.service" || return 1; done
  for hp in 8710/v1/health 8711/health 8712/health 8713/health 8714/health; do
    /usr/bin/curl -fsS -m 3 "http://127.0.0.1:$hp" >/dev/null 2>&1 || return 1
  done
  # r1:9 F-3: /health has no host check, so also send an MCP request with the public Host Caddy forwards; a 403 means
  # MCP_ALLOWED_HOSTS does not hold api.<domain> and every hosted MCP call would be refused
  dom="$(conf_get DOMAIN 2>/dev/null || true)"
  if [ -n "$dom" ]; then
    code="$(/usr/bin/curl -sS -m 5 -o /dev/null -w '%{http_code}' -X POST -H "Host: api.$dom" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:8713/mcp 2>/dev/null || echo 000)"
    [ "$code" = "200" ] || return 1
  fi
}

wait_healthy() {
  i=0
  while [ "$i" -lt "$HEALTH_TRIES" ]; do
    if health; then return 0; fi
    i=$((i + 1)); /bin/sleep "$HEALTH_SLEEP"
  done
  return 1
}

switch_to() { # release dir
  /bin/ln -sfn "$1" "$CUR.new"
  /bin/mv -Tf "$CUR.new" "$CUR"
}

if [ "$arg" = "--rollback" ]; then
  [ -s "$PREV_FILE" ] || die "no previous release recorded"
  sha="$(/bin/cat "$PREV_FILE")"
else
  printf '%s' "$arg" | /bin/grep -qE '^[0-9a-f]{7,40}$' || die "not a git sha: $arg"
  repo="$(conf_get REPO_URL)"
  [ -n "$repo" ] || die "REPO_URL is not set (sudo capstan-config set REPO_URL <url>)"
  if [ ! -d "$CACHE" ]; then "$GIT" clone --quiet --bare "$repo" "$CACHE"; fi
  "$GIT" --git-dir="$CACHE" fetch --quiet --force "$repo" '+refs/heads/*:refs/heads/*'
  sha="$("$GIT" --git-dir="$CACHE" rev-parse --verify --quiet "$arg^{commit}")" || die "sha $arg not found in the repo"
fi

prev="$(current_sha)"
if [ "$prev" = "$sha" ]; then say "deploy: skip $sha (already live)"; exit 0; fi
dir="$REL/$sha"
log "start $sha (previous ${prev:-none}) by ${SUDO_USER:-$(id -un)}"

if [ ! -d "$dir" ]; then
  [ -d "$CACHE" ] || die "release $sha is not on this server and no repo cache exists"
  /bin/mkdir -p "$dir.tmp"
  "$GIT" --git-dir="$CACHE" archive "$sha" | /bin/tar -x -C "$dir.tmp"
  ( cd "$dir.tmp" && if [ -n "${CAPSTAN_INSTALL_CMD:-}" ]; then /bin/bash -c "$CAPSTAN_INSTALL_CMD"; else "$BUN" install --frozen-lockfile --production >> "$CAPSTAN_LOG/ops/deploy.log" 2>&1; fi )
  /bin/chmod -R a+rX "$dir.tmp"
  /bin/mv "$dir.tmp" "$dir"
fi
say "deploy: release $sha ready"

# one migrator: as the workers user with its env, under the database advisory lock
if [ -n "${CAPSTAN_MIGRATE_CMD:-}" ]; then ( cd "$dir" && /bin/bash -c "$CAPSTAN_MIGRATE_CMD" )
else
  /usr/sbin/runuser -u capstan-workers -- /bin/bash -c "set -a; . '$CAPSTAN_ETC/workers/env'; set +a; cd '$dir' && '$BUN' packages/core/src/migrate.ts" >> "$CAPSTAN_LOG/ops/deploy.log" 2>&1
fi
say "deploy: migrations done"

switch_to "$dir"
restart_all
if wait_healthy; then
  [ -n "$prev" ] && printf '%s\n' "$prev" > "$PREV_FILE"
  log "ok $sha"
  say "deploy: ok $sha"
  exit 0
fi

log "health failed for $sha"
if [ -n "$prev" ] && [ -d "$REL/$prev" ]; then
  switch_to "$REL/$prev"
  restart_all
  if wait_healthy; then rb="ok"; else rb="unhealthy"; fi
  alert deploy.rollback "{\"sha\":\"$sha\",\"previous\":\"$prev\",\"rollback\":\"$rb\"}"
  say "deploy: failed $sha, rolled back to $prev ($rb)"
else
  alert deploy.rollback "{\"sha\":\"$sha\",\"previous\":null,\"rollback\":\"none\"}"
  say "deploy: failed $sha, no previous release to roll back to"
fi
exit 1
