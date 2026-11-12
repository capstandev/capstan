#!/bin/bash
# Stop exactly what ops/fork/up.sh started: the PIDs recorded in ops/fork/.pids (each checked to still be alive) and
# the docker compose project capstan-e2e-launch. Touches no other process. Fork state and the database volume are
# kept; `down.sh --wipe` also removes the compose volumes. macOS bash 3.2 safe.
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
root="$(cd "$here/../.." && pwd -P)"
pids="$here/.pids"
DOCKER="/opt/homebrew/bin/docker"
[ -x "$DOCKER" ] || DOCKER="$(command -v docker)"
rm -f "$here/.state/ready" # a stack that is going down is not ready: every-tx.ts refuses to run without this marker
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
if [ -f "$pids" ]; then
  # newest first, so the apps stop before the chain they read
  tail -r "$pids" | while read -r n p port; do
    [ -n "${p:-}" ] || continue
    if alive "$p"; then
      kill "$p" 2>/dev/null || true
      i=0; while alive "$p" && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done
      if alive "$p"; then kill -9 "$p" 2>/dev/null || true; fi
      echo "stopped: $n (pid $p)"
    fi
  done
  left=""
  while read -r n p port; do alive "${p:-}" && left="$left $n:$p"; done < "$pids"
  if [ -n "$left" ]; then echo "fail: still alive:$left"; exit 1; fi
  : > "$pids"
fi
wipe=""; [ "${1:-}" = "--wipe" ] && wipe="-v"
project="${FORK_COMPOSE_PROJECT:-capstan-e2e-launch}"
(cd "$root" && "$DOCKER" compose -p "$project" down $wipe >/dev/null 2>&1) && echo "stopped: docker compose project $project"
echo "down: nothing from this stack is running"
