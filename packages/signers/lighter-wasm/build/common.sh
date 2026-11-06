#!/usr/bin/env bash
# Shared helpers for build.sh and parity.sh. Sourced, never run on its own.
# Pins: the lighter-go commit and the golang image index digest (resolved 2026-11-05 with the Docker Hub registry API:
# HEAD /v2/library/golang/manifests/1.26.8 -> docker-content-digest, an OCI image index; equals the local RepoDigest).
# Go is never built on the host: every Go step runs in the pinned container.

LIGHTER_GO_REPO="https://github.com/elliottech/lighter-go"
LIGHTER_GO_COMMIT="aefa96848a105d82a6bbb55d3d05663293a71713"
GO_IMAGE="golang:1.26.8@sha256:eb36c1664dd974cde625f736e02c204383deebe03977365caaec5bf49f794348"

lw_die() {
  echo "lighter-wasm: $*" >&2
  exit 1
}

lw_need() {
  command -v "$1" >/dev/null 2>&1 || lw_die "$1 not found"
}

# Persistent caches (module downloads, the parity checker source). Safe to delete at any time.
lw_cache_dir() {
  local base="${LIGHTER_WASM_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/capstan-lighter-wasm}"
  mkdir -p "$base"
  (cd "$base" && pwd -P)
}

# lw_fetch_source <dir>: shallow fetch of the pinned commit into <dir> (must not exist), then assert HEAD.
lw_fetch_source() {
  local dir="$1"
  [ -e "$dir" ] && lw_die "source dir $dir already exists"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "$LIGHTER_GO_REPO"
  if ! git -C "$dir" fetch -q --depth 1 origin "$LIGHTER_GO_COMMIT" 2>/dev/null; then
    rm -rf "$dir"
    git clone -q "$LIGHTER_GO_REPO" "$dir"
  fi
  git -C "$dir" -c advice.detachedHead=false checkout -q --detach "$LIGHTER_GO_COMMIT"
  local head
  head="$(git -C "$dir" rev-parse HEAD)"
  [ "$head" = "$LIGHTER_GO_COMMIT" ] || lw_die "lighter-go HEAD is $head, expected $LIGHTER_GO_COMMIT"
  [ -z "$(git -C "$dir" status --porcelain)" ] || lw_die "lighter-go checkout is not clean"
}

# lw_go <name-suffix> <network: on|off> <src dir> <extra docker args...> -- <command...>
# Runs a command in the pinned golang container as the calling user, with the module cache mounted.
lw_go() {
  local suffix="$1" net="$2" src="$3"
  shift 3
  local extra=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    extra+=("$1")
    shift
  done
  [ "${1:-}" = "--" ] && shift
  local modcache
  modcache="$(lw_cache_dir)/gomod"
  mkdir -p "$modcache"
  local netflag=()
  [ "$net" = "off" ] && netflag=(--network none)
  docker run --rm --name "capstan-lighter-wasm-${suffix}-$$" \
    ${netflag[@]+"${netflag[@]}"} \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e GOCACHE=/tmp/gocache -e GOMODCACHE=/gomod -e GOTOOLCHAIN=local -e GOFLAGS= \
    -v "$src:/src" -v "$modcache:/gomod" -w /src \
    ${extra[@]+"${extra[@]}"} \
    "$GO_IMAGE" "$@"
}

# lw_mod_download <src>: download modules with network (go.sum checks every zip), then verify offline.
lw_mod_download() {
  local src="$1"
  lw_go moddl on "$src" -- go mod download
  lw_go modverify off "$src" -e GOPROXY=off -- go mod verify >/dev/null
}

lw_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}
