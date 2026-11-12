#!/bin/bash
# Runs every ops/server test. Container tests run in a Debian 12 container pinned by digest, made by this script
# and removed by it (trap). provision.sh runs twice in provision.test.sh; later tests use the provisioned container.
# The bash 3.2 check runs on this Mac.
#   bash ops/server/test/run-all.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
srv="$(cd "$here/.." && pwd -P)"
DOCKER="${DOCKER:-$(command -v docker || echo /opt/homebrew/bin/docker)}"
BASE="debian:12@sha256:268fb24c39bca92d326dd83ea3abebe4a3f7751c804ffef23bb6d857dd343ff8" # not-a-key
TOOLS="postgresql systemd iptables procps"
IMAGE="capstan-ops-test:base-$(printf '%s %s' "$BASE" "$TOOLS" | shasum -a 256 | cut -c1-12)"
NAME="capstan-ops-test-$$"
results=""; failed=0
record() { results="$results$1"$'\n'; case "$1" in PASS*) ;; *) failed=$((failed + 1)) ;; esac; }

# Base image: pulled once. A throwaway client config avoids any credential helper (public image, no login).
if ! "$DOCKER" image inspect "$BASE" >/dev/null 2>&1; then
  cfg="$(mktemp -d)"; echo '{}' > "$cfg/config.json"
  host="$("$DOCKER" context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
  DOCKER_CONFIG="$cfg" DOCKER_HOST="${DOCKER_HOST:-$host}" "$DOCKER" pull "$BASE" >/dev/null || { echo "run-all: cannot pull $BASE"; exit 1; }
  rm -rf "$cfg"
fi
# Test image: the base plus test-only tools (a local Postgres for the backup round trip, systemd-analyze, iptables).
if ! "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "run-all: building $IMAGE"
  "$DOCKER" run --name "$NAME-build" "$BASE" bash -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $TOOLS >/dev/null" || { "$DOCKER" rm -f "$NAME-build" >/dev/null 2>&1; echo "run-all: image build failed"; exit 1; }
  "$DOCKER" commit "$NAME-build" "$IMAGE" >/dev/null
  "$DOCKER" rm -f "$NAME-build" >/dev/null
fi

cleanup() { "$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$DOCKER" run -d --name "$NAME" --cap-add NET_ADMIN -v "$srv:/src/server:ro" "$IMAGE" sleep infinity >/dev/null || { echo "run-all: cannot start the test container"; exit 1; }

for t in provision permissions keys deploy backup firewall config sharedhost; do
  echo "run-all: $t.test.sh"
  out="$("$DOCKER" exec "$NAME" /bin/bash "/src/server/test/$t.test.sh" 2>&1)"
  lines="$(printf '%s\n' "$out" | grep -E '^(PASS|FAIL) ' || true)"
  [ -n "$lines" ] || lines="FAIL $t.test.sh: no result (last output: $(printf '%s' "$out" | tail -n 5 | tr '\n' ' '))"
  while IFS= read -r l; do record "$l"; done <<< "$lines"
  printf '%s\n' "$lines"
done
for t in bash32 tracked memory; do
  echo "run-all: $t.test.sh (host)"
  out="$(/bin/bash "$here/$t.test.sh" 2>&1)"
  lines="$(printf '%s\n' "$out" | grep -E '^(PASS|FAIL) ' || echo "FAIL $t.test.sh: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')")"
  while IFS= read -r l; do record "$l"; done <<< "$lines"
  printf '%s\n' "$lines"
done

total="$(printf '%s' "$results" | grep -c . || true)"
echo "run-all: $((total - failed)) passed, $failed failed"
[ "$failed" -eq 0 ]
