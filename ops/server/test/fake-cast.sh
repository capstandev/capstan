#!/bin/bash
# Test double for Foundry's cast (no Foundry in the test container). Same stdout shape as the real tool:
#   cast wallet new <dir>: reads the password (stands in for Foundry's hidden prompt) from FAKE_CAST_PASSWORD,
#     writes <dir>/<uuid> as a keystore-shaped JSON with the address, prints the address on stdout and
#     "Created new encrypted keystore file: <path>" on stderr, as Foundry 1.8.4 does (FAKE_CAST_SHAPE=legacy: both
#     on stdout, the file line then "Address: 0x...", as older releases did). It also prints a decoy secret line to stderr to prove the script never relays it.
#     FAKE_CAST_HANG=1 writes the keystore, touches FAKE_CAST_HANG_READY and then waits, as at a prompt.
#   cast wallet address --keystore <file> --password-file <f>: prints the address when the password matches.
set -euo pipefail
if [ "$1 $2" = "wallet new" ]; then
  dir="$3"; id="$(cat /proc/sys/kernel/random/uuid)"
  addr="$(head -c 20 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  pwh="$(printf '%s' "${FAKE_CAST_PASSWORD:?}" | sha256sum | cut -c1-16)"
  printf '{"address":"%s","crypto":{"fake":"%s"},"id":"%s","version":3}\n' "$addr" "$pwh" "$id" > "$dir/$id"
  echo "decoy-secret-line-never-relayed" >&2
  # FAKE_CAST_HANG=1: the keystore is written, then cast waits at its prompt (a session dropped mid-key)
  if [ "${FAKE_CAST_HANG:-0}" = "1" ]; then : > "${FAKE_CAST_HANG_READY:?}"; sleep 30; exit 1; fi
  if [ "${FAKE_CAST_SHAPE:-1.8.4}" = "legacy" ]; then
    echo "Created new encrypted keystore file: $dir/$id"
    echo "Address: 0x$addr"
  else # Foundry 1.8.4: the file line on stderr, only the checksummed-style address on stdout
    echo "Created new encrypted keystore file: $dir/$id" >&2
    echo "0x$addr"
  fi
  exit 0
fi
if [ "$1 $2" = "wallet address" ]; then
  ks=""; pf=""
  shift 2
  while [ "$#" -gt 0 ]; do case "$1" in --keystore) ks="$2"; shift 2 ;; --password-file) pf="$2"; shift 2 ;; *) shift ;; esac; done
  want="$(sed -E 's/.*"fake":"([0-9a-f]+)".*/\1/' "$ks")"
  got="$(sha256sum < "$pf" | cut -c1-16)"
  [ "$want" = "$got" ] || { echo "Error: invalid password" >&2; exit 1; }
  echo "0x$(sed -E 's/.*"address":"([0-9a-f]+)".*/\1/' "$ks")"
  exit 0
fi
exit 2
