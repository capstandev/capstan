#!/bin/bash
# Make a service keystore ON the server (DECISIONS #20). Owner-run, as root:
#   sudo /bin/bash /opt/capstan/current/ops/server/make-service-key.sh <receipts|anchor|facilitator> <testnet|mainnet> [--rotate]
# Foundry makes the key and asks for the keystore password at its own hidden prompt (never --unsafe-password).
# Then this script asks for the same password once more, at a hidden prompt, stores it in a 0600 file for the
# service, and checks that the stored password opens the keystore. It prints one line: the address.
# Files: /etc/capstan/<svc>/keystore.json and keystore.password, both 0600, owned by capstan-<svc>.
# A second run without --rotate makes nothing and prints the existing address. --rotate keeps the old files as
# keystore.<UTC date>.json / .password.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
if [ -f "$here/lib.sh" ]; then . "$here/lib.sh"; else . /usr/local/lib/capstan/lib.sh; fi
CAST="${CAPSTAN_CAST:-/root/.foundry/bin/cast}"

svc="${1:-}"; net="${2:-}"; rot="${3:-}"
in_list "$svc" "$CAPSTAN_KEY_SERVICES" || die "usage: make-service-key.sh <$CAPSTAN_KEY_SERVICES> <testnet|mainnet> [--rotate]"
case "$net" in testnet|mainnet) ;; *) die "network must be testnet or mainnet" ;; esac
case "$rot" in ""|--rotate) ;; *) die "third argument can only be --rotate" ;; esac
require_root
[ -x "$CAST" ] || die "cast not found at $CAST (install Foundry for root first)"
dir="$CAPSTAN_ETC/$svc"
[ -d "$dir" ] || die "no $dir (run provision.sh first)"
ks="$dir/keystore.json"; pw="$dir/keystore.password"; meta="$dir/keystore.network"

addr_of() { /usr/bin/awk -F'"' '{ for (i = 1; i < NF; i++) if ($i == "address") { print "0x" $(i + 2); exit } }' "$1"; }

if [ -f "$ks" ] && [ "$rot" != "--rotate" ]; then
  [ "$(/bin/cat "$meta" 2>/dev/null || echo "$net")" = "$net" ] || die "$svc already has a $(/bin/cat "$meta") key; use --rotate to replace it"
  addr_of "$ks"
  exit 0
fi

umask 077
work="$(/bin/mktemp -d "$dir/.new.XXXXXX")"
trap '/bin/rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM # a dropped ssh session still removes the half-made keystore
# Foundry's hidden prompt; its stdout names the file and the address, never the key
# (cast's stderr is kept aside and shown only when cast fails; the hidden prompt itself uses the terminal)
if ! out="$("$CAST" wallet new "$work" 2> "$work/cast.err")"; then
  /usr/bin/tail -n 1 "$work/cast.err" >&2; die "cast wallet new failed"
fi
/bin/rm -f "$work/cast.err"
newks="$(/bin/ls "$work" | /bin/grep -v '^cast\.err$' | /usr/bin/head -n 1)"
[ -n "$newks" ] || die "cast made no keystore"
# Foundry 1.8.4 prints only the address on stdout (the "Created new encrypted keystore file" line goes to stderr);
# older releases printed "Address: 0x..." under that line. Both shapes are read (VPS stand-in, 2026-11-11).
addr="$(printf '%s\n' "$out" | /usr/bin/awk '/^Address:/ { print $2; exit } /^0x[0-9a-fA-F]+$/ { print $1; exit }')"
printf '%s\n' "$addr" | /bin/grep -qE '^0x[0-9a-fA-F]{40}$' || die "cast output had no address"

# the same password again, hidden, for the service's password file
if [ -r /dev/tty ] && [ "${CAPSTAN_PASSWORD_STDIN:-0}" != "1" ]; then
  printf 'Type the same keystore password again (hidden): ' > /dev/tty
  IFS= read -r -s p < /dev/tty; printf '\n' > /dev/tty
else
  IFS= read -r -s p
fi
[ -n "$p" ] || die "empty password"
printf '%s' "$p" > "$work/password"; p=""
got="$("$CAST" wallet address --keystore "$work/$newks" --password-file "$work/password" 2>/dev/null || true)"
lc() { printf '%s' "$1" | /usr/bin/tr 'A-F' 'a-f'; }
[ "$(lc "$got")" = "$(lc "$addr")" ] || die "that password does not open the new keystore; nothing was stored"

if [ -f "$ks" ]; then
  stamp="$(/bin/date -u '+%Y%m%dT%H%M%SZ')"
  /bin/mv "$ks" "$dir/keystore.$stamp.json"
  [ -f "$pw" ] && /bin/mv "$pw" "$dir/keystore.$stamp.password"
fi
/bin/mv "$work/$newks" "$ks"
/bin/mv "$work/password" "$pw"
printf '%s\n' "$net" > "$meta"
for f in "$ks" "$pw" "$meta"; do /bin/chmod 600 "$f"; chown_maybe "capstan-$svc:capstan-$svc" "$f"; done
printf '%s\n' "$addr"
