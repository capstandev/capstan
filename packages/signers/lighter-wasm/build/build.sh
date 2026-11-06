#!/usr/bin/env bash
# Reproducible build of the lighter-go wasm signer (wasm/ target) at a pinned commit, in a pinned golang container.
#   bash build.sh            build, copy lighter-signer.wasm + wasm_exec.js to artifacts/, write artifacts/SHA256SUMS
#   bash build.sh --out DIR  build into DIR only (artifacts/ untouched); prints the wasm sha256
#   bash build.sh --check    build into a temp dir and fail unless both files match artifacts/SHA256SUMS
# Steps: shallow fetch of the pinned commit (HEAD asserted), `go mod download` with network, then the build with
# --network none. Go never runs on the host. Needs git and docker.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
pkg="$(cd "$here/.." && pwd -P)"
# shellcheck source=common.sh
. "$here/common.sh"

mode="write"
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) mode="check" ;;
    --out) mode="out"; out="${2:?--out needs a directory}"; shift ;;
    *) lw_die "unknown argument $1" ;;
  esac
  shift
done

lw_need git
lw_need docker
docker info >/dev/null 2>&1 || lw_die "docker is not reachable"

# the work dir sits under the cache dir (inside $HOME), because colima and Docker Desktop only share $HOME by default
work="$(mktemp -d "$(lw_cache_dir)/build.XXXXXX")"
trap 'rm -rf "$work"' EXIT
src="$work/lighter-go"
build_out="$work/out"
mkdir -p "$build_out"

echo "lighter-wasm: fetch lighter-go $LIGHTER_GO_COMMIT"
lw_fetch_source "$src"
echo "lighter-wasm: go mod download (network on)"
lw_mod_download "$src"
echo "lighter-wasm: go build GOOS=js GOARCH=wasm (network off)"
lw_go build off "$src" -v "$build_out:/out" -e GOPROXY=off -e CGO_ENABLED=0 -e GOOS=js -e GOARCH=wasm -- \
  sh -c 'go build -mod=readonly -trimpath -buildvcs=false -o /out/lighter-signer.wasm ./wasm/ && cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /out/wasm_exec.js && go version > /out/go-version.txt'

wasm_sha="$(lw_sha256 "$build_out/lighter-signer.wasm")"
exec_sha="$(lw_sha256 "$build_out/wasm_exec.js")"
wasm_size="$(wc -c < "$build_out/lighter-signer.wasm" | tr -d ' ')"
exec_size="$(wc -c < "$build_out/wasm_exec.js" | tr -d ' ')"
echo "lighter-wasm: $(cat "$build_out/go-version.txt")"
echo "lighter-wasm: lighter-signer.wasm $wasm_size bytes sha256 $wasm_sha"
echo "lighter-wasm: wasm_exec.js $exec_size bytes sha256 $exec_sha"

rel="packages/signers/lighter-wasm/artifacts"
sums="$pkg/artifacts/SHA256SUMS"
case "$mode" in
  out)
    mkdir -p "$out"
    cp "$build_out/lighter-signer.wasm" "$build_out/wasm_exec.js" "$out/"
    echo "$wasm_sha"
    ;;
  check)
    [ -f "$sums" ] || lw_die "no $sums to check against"
    want_wasm="$(awk '/lighter-signer.wasm$/ {print $1}' "$sums")"
    want_exec="$(awk '/wasm_exec.js$/ {print $1}' "$sums")"
    [ "$wasm_sha" = "$want_wasm" ] || lw_die "lighter-signer.wasm sha256 $wasm_sha differs from SHA256SUMS $want_wasm"
    [ "$exec_sha" = "$want_exec" ] || lw_die "wasm_exec.js sha256 $exec_sha differs from SHA256SUMS $want_exec"
    echo "lighter-wasm: check ok, rebuilt bytes equal SHA256SUMS"
    ;;
  write)
    mkdir -p "$pkg/artifacts"
    cp "$build_out/lighter-signer.wasm" "$build_out/wasm_exec.js" "$pkg/artifacts/"
    printf '%s  %s\n%s  %s\n' "$wasm_sha" "$rel/lighter-signer.wasm" "$exec_sha" "$rel/wasm_exec.js" > "$sums"
    echo "lighter-wasm: wrote $rel/{lighter-signer.wasm,wasm_exec.js,SHA256SUMS}"
    ;;
esac
