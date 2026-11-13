#!/bin/bash
# Release autopilot sandbox: the real runner, installed as on the server, in a Debian 12 container with systemd as
# PID 1, against local bare repos and stand-in deploy, Telegram and GitHub endpoints. Nothing leaves the container:
# every URL is 127.0.0.1 (ports 25520 Telegram, 25521 GitHub), every remote is a local path.
#   bash ops/release/test/sandbox/run.sh            (prints PASS or FAIL per case; exit 1 on any FAIL)
# The container is made and removed by this script (compose project label capstan-sandbox). KEEP=1 keeps it.
# Stress mode (stress72.sh, the real queue): STRESS_REPO=<bare copy of the backend repo> STRESS_BASE=<sha>
#   STRESS_TIP=<sha> [STRESS_NOTES=<dir of NN.md>] [STRESS_REPORT_FILE=<report.md>] [STRESS_ARM_ONLY=1] bash run.sh
# Docker Desktop cannot mount ~/Documents on this Mac: run from a clone outside it.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
rel="$(cd "$here/../.." && pwd -P)"
DOCKER="${DOCKER:-$(command -v docker || echo /opt/homebrew/bin/docker)}"
BASE="debian:12@sha256:268fb24c39bca92d326dd83ea3abebe4a3f7751c804ffef23bb6d857dd343ff8" # not-a-key
TOOLS="systemd systemd-sysv sudo git curl python3 procps ca-certificates openssh-client"
IMAGE="capstan-sandbox:base-$(printf '%s %s' "$BASE" "$TOOLS" | shasum -a 256 | cut -c1-12)"
NAME="capstan-sandbox-$$"
LABEL="com.docker.compose.project=capstan-sandbox"

if ! "$DOCKER" image inspect "$BASE" >/dev/null 2>&1; then
  cfg="$(mktemp -d)"; echo '{}' > "$cfg/config.json"
  DOCKER_CONFIG="$cfg" "$DOCKER" pull "$BASE" >/dev/null || { echo "sandbox: cannot pull $BASE"; exit 1; }
  rm -rf "$cfg"
fi
if ! "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "sandbox: building $IMAGE"
  "$DOCKER" run --name "$NAME-build" --label "$LABEL" "$BASE" bash -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $TOOLS >/dev/null" \
    || { "$DOCKER" rm -f "$NAME-build" >/dev/null 2>&1; echo "sandbox: image build failed"; exit 1; }
  "$DOCKER" commit "$NAME-build" "$IMAGE" >/dev/null; "$DOCKER" rm -f "$NAME-build" >/dev/null
fi

cleanup() { [ "${KEEP:-0}" = 1 ] && { echo "sandbox: kept container $NAME"; return; }; "$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# systemd as PID 1 needs a writable cgroup tree and tmpfs /run (Docker Desktop: --privileged with the host cgroupns)
inner=/src/release/test/sandbox/inside.sh; extra=(); envs=()
if [ -n "${STRESS_REPO:-}" ]; then
  inner=/src/release/test/sandbox/stress72.sh; extra=(-v "$STRESS_REPO:/src/queue:ro")
  [ -n "${STRESS_NOTES:-}" ] && extra+=(-v "$STRESS_NOTES:/src/notes:ro")
  [ -n "${STRESS_REPORT_FILE:-}" ] && extra+=(-v "$STRESS_REPORT_FILE:/src/report.md:ro")
  envs=(-e "STRESS_BASE=${STRESS_BASE:?}" -e "STRESS_TIP=${STRESS_TIP:?}" -e "STRESS_ARM_ONLY=${STRESS_ARM_ONLY:-0}")
fi
"$DOCKER" run -d --name "$NAME" --label "$LABEL" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock -v "$rel:/src/release:ro" -v "$rel/../public:/src/public:ro" ${extra[@]+"${extra[@]}"} "$IMAGE" /lib/systemd/systemd >/dev/null \
  || { echo "sandbox: cannot start the container"; exit 1; }
for _ in $(seq 60); do
  s=$("$DOCKER" exec "$NAME" systemctl is-system-running 2>/dev/null || true)
  case "$s" in running|degraded) break ;; esac; sleep 1
done
echo "sandbox: systemd is $s in $NAME ($("$DOCKER" exec "$NAME" bash -c 'echo $BASH_VERSION; git --version' | tr '\n' ' '))"
"$DOCKER" exec ${envs[@]+"${envs[@]}"} "$NAME" /bin/bash "$inner"
rc=$?
[ "$rc" -ne 0 ] && "$DOCKER" exec "$NAME" tail -n 40 /var/lib/capstan-release/log/runner.log > "${TMPDIR:-/tmp}/capstan-sandbox-runner.log" 2>/dev/null \
  && echo "sandbox: runner log tail saved to ${TMPDIR:-/tmp}/capstan-sandbox-runner.log"
exit "$rc"
