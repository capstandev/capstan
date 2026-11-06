#!/usr/bin/env bash
# Run the native parity checker (build/parity/main.go) on a vectors JSON file:
#   bash parity.sh <vectors.json>     prints one JSON summary line
# The checker is compiled once per main.go content against a cached checkout of the pinned lighter-go commit, in the
# pinned golang container, and runs with --network none. Needs git and docker.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
. "$here/common.sh"
vectors="${1:?usage: parity.sh <vectors.json>}"
[ -f "$vectors" ] || lw_die "no such file $vectors"
lw_need git
lw_need docker

cache="$(lw_cache_dir)"
src="$cache/src-$LIGHTER_GO_COMMIT"
if [ ! -d "$src/.git" ] || [ "$(git -C "$src" rev-parse HEAD 2>/dev/null)" != "$LIGHTER_GO_COMMIT" ]; then
  rm -rf "$src"
  lw_fetch_source "$src"
  lw_mod_download "$src" >&2
fi
checker_sha="$(lw_sha256 "$here/parity/main.go" | cut -c1-16)"
bin="$cache/bin/parity-$checker_sha"
if [ ! -x "$bin" ]; then
  mkdir -p "$cache/bin" "$src/capstan-parity"
  cp "$here/parity/main.go" "$src/capstan-parity/main.go"
  lw_go parity-build off "$src" -v "$cache/bin:/bin-out" -e GOPROXY=off -e CGO_ENABLED=0 -- \
    go build -mod=readonly -trimpath -buildvcs=false -o "/bin-out/parity-$checker_sha" ./capstan-parity >&2
fi
# copy the vectors under the cache (inside $HOME) so the container can see them on colima / Docker Desktop
run="$(mktemp -d "$cache/run.XXXXXX")"
trap 'rm -rf "$run"' EXIT
cp "$vectors" "$run/vectors.json"
lw_go parity-run off "$src" -v "$cache/bin:/bin-in:ro" -v "$run:/run-in:ro" -- "/bin-in/parity-$checker_sha" /run-in/vectors.json
