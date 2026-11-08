#!/bin/bash
# Makes the two Aster testnet wallets ON THE VPS (todo 41, BACKLOG A4, D1). Aster's terms list Canada, so these
# wallets are made, funded and used only on the VPS, never on this Mac. Run as the deploy user on the VPS:
#   CAPSTAN_RUNNER=vps /bin/bash ops/testnet/make-wallets-vps.sh
# Keystores in ~/.foundry/keystores/capstan-testnet-aster-{main,builder}, passwords in chmod-600 files under
# ~/.capstan-testnet/, addresses in ~/.capstan-testnet/addresses.json. Prints role and address only.
# Then the VPS suite env is (paths only, no secrets):
#   CAPSTAN_RUNNER=vps ASTER_TESTNET_KEYSTORE=~/.foundry/keystores/capstan-testnet-aster-main
#   ASTER_TESTNET_PASSWORD_FILE=~/.capstan-testnet/capstan-testnet-aster-main.password ASTER_TESTNET_BUILDER=<builder address>
set -eu
if [ "${CAPSTAN_RUNNER:-}" != "vps" ]; then echo "refusing: Aster testnet wallets are made on the VPS only (set CAPSTAN_RUNNER=vps there)"; exit 1; fi
here="$(cd "$(dirname "$0")" && pwd -P)"
CAST="${TESTNET_TOOL_DIR:-$HOME/.foundry/bin}/cast"
BUN="${TESTNET_BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="$(command -v bun)"
home="${CAPSTAN_TESTNET_HOME:-$HOME/.capstan-testnet}"
ks="${CAPSTAN_TESTNET_KEYSTORES:-$HOME/.foundry/keystores}"
umask 077
mkdir -p "$home" "$ks"
chmod 700 "$home"
for role in $("$BUN" "$here/wallets.ts" roles vps); do
  name="capstan-testnet-$role"
  pw="$home/$name.password"
  state="exists"
  if [ ! -f "$ks/$name" ]; then
    [ -f "$pw" ] || { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$pw"; chmod 600 "$pw"; }
    CAST_PASSWORD="$(cat "$pw")" "$CAST" wallet new "$ks" "$name" >/dev/null 2>&1 || { echo "$role: cast wallet new failed"; exit 1; }
    chmod 600 "$ks/$name"
    state="created"
  elif [ ! -f "$pw" ]; then
    echo "$role: keystore exists without its password file; refusing to guess"; exit 1
  fi
  addr="$("$CAST" wallet address --keystore "$ks/$name" --password-file "$pw" 2>/dev/null)" || { echo "$role: cannot read the address"; exit 1; }
  "$BUN" "$here/wallets.ts" record "$role" "$addr"
  echo "$role $addr $state (aster testnet, VPS)"
done
echo "addresses: $home/addresses.json"
