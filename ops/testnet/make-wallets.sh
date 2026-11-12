#!/bin/bash
# Makes every Capstan testnet wallet on this Mac (todo 41). Agent-run; safe to run again (existing wallets are kept).
#   EVM   : encrypted Foundry keystores <keystores>/capstan-testnet-<role> (default ~/.foundry/keystores)
#   Solana: encrypted solana-ed25519 v3 keystores <home>/solana/capstan-testnet-<role>.json
#   Passwords: one random password per wallet in <home>/capstan-testnet-<role>.password, chmod 600
#   Addresses (public): <home>/addresses.json
# <home> is ~/.capstan-testnet (CAPSTAN_TESTNET_HOME overrides, tests only), outside every repo.
# Prints role and address only. Never prints a key or a password. Testnet only: never fund these on a mainnet.
# Aster wallets are made on the VPS by make-wallets-vps.sh. macOS bash 3.2 safe.
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
CAST="${TESTNET_TOOL_DIR:-$HOME/.foundry/bin}/cast"
# no foundryup install (CI's foundry-toolchain): the cast on PATH; an explicit TESTNET_TOOL_DIR is never overridden
if [ ! -x "$CAST" ] && [ -z "${TESTNET_TOOL_DIR:-}" ]; then CAST="$(command -v cast || echo "$CAST")"; fi
BUN="${TESTNET_BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="/opt/homebrew/bin/bun"
[ -x "$BUN" ] || BUN="$(command -v bun || echo "$BUN")"
home="${CAPSTAN_TESTNET_HOME:-$HOME/.capstan-testnet}"
ks="${CAPSTAN_TESTNET_KEYSTORES:-$HOME/.foundry/keystores}"
umask 077
mkdir -p "$home" "$home/solana" "$ks"
chmod 700 "$home" "$home/solana"

for role in $("$BUN" "$here/wallets.ts" roles evm); do
  name="capstan-testnet-$role"
  pw="$home/$name.password"
  state="exists"
  if [ ! -f "$ks/$name" ]; then
    if [ ! -f "$pw" ]; then
      head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$pw"
      chmod 600 "$pw"
    fi
    # the password reaches cast through its environment, never the command line; cast's own output is dropped
    CAST_PASSWORD="$(cat "$pw")" "$CAST" wallet new "$ks" "$name" >/dev/null 2>&1 || { echo "$role: cast wallet new failed"; exit 1; }
    chmod 600 "$ks/$name"
    state="created"
  elif [ ! -f "$pw" ]; then
    echo "$role: keystore $ks/$name exists without its password file; refusing to guess"; exit 1
  fi
  addr="$("$CAST" wallet address --keystore "$ks/$name" --password-file "$pw" 2>/dev/null)" || { echo "$role: cannot read the address"; exit 1; }
  case "$addr" in 0x????????????????????????????????????????) ;; *) echo "$role: unexpected address output"; exit 1 ;; esac
  "$BUN" "$here/wallets.ts" record "$role" "$addr"
  echo "$role $addr $state (evm)"
done

"$BUN" "$here/make-solana.ts"
echo "addresses: $home/addresses.json"
