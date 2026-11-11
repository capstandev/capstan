#!/bin/bash
# R3: make-service-key.sh prints one address line, never the key or password; files 0600, owned by the service user.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
T_NAME=address-only
dir="$(stage_copy)"
export CAPSTAN_CAST="$SRC/test/fake-cast.sh" CAPSTAN_PASSWORD_STDIN=1
PW="correct horse battery staple 42"
rm -f /etc/capstan/receipts/keystore.*
out="$(printf '%s\n' "$PW" | FAKE_CAST_PASSWORD="$PW" /bin/bash "$dir/make-service-key.sh" receipts testnet 2>&1)"; rc=$?
[ "$rc" -eq 0 ] || fail "exit $rc: $out"
assert_eq "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" "1" "output line count"
printf '%s' "$out" | grep -qE '^0x[0-9a-f]{40}$' || fail "output is not one address: $out"
assert_not_contains "$out" "$PW"
assert_not_contains "$out" "decoy-secret"
assert_not_contains "$out" "keystore file"
for f in keystore.json keystore.password keystore.network; do
  assert_eq "$(stat -c '%a %U:%G' "/etc/capstan/receipts/$f")" "600 capstan-receipts:capstan-receipts" "$f mode and owner"
done
assert_eq "$(cat /etc/capstan/receipts/keystore.password)" "$PW" "stored password"
ls -A /etc/capstan/receipts | grep -q '^\.new\.' && fail "temporary folder left behind"
# the older cast output shape ("Address: 0x..." under the file line) still gives one address line
rm -f /etc/capstan/facilitator/keystore.*
outl="$(printf '%s\n' "$PW" | FAKE_CAST_SHAPE=legacy FAKE_CAST_PASSWORD="$PW" /bin/bash "$dir/make-service-key.sh" facilitator testnet 2>&1)" || fail "legacy cast shape: $outl"
printf '%s' "$outl" | grep -qE '^0x[0-9a-f]{40}$' || fail "legacy cast shape output is not one address: $outl"
rm -f /etc/capstan/facilitator/keystore.*
# a dropped session (HUP to the whole process group, as sshd sends it) mid-key leaves no half-made keystore folder
rm -f /etc/capstan/anchor/keystore.* /tmp/fake-cast.ready
ls -A /etc/capstan/anchor | grep -q '^\.new\.' && fail "a .new folder was there before the hangup test"
FAKE_CAST_HANG=1 FAKE_CAST_HANG_READY=/tmp/fake-cast.ready FAKE_CAST_PASSWORD="$PW" setsid /bin/bash "$dir/make-service-key.sh" anchor testnet </dev/null >/dev/null 2>&1 &
hpid=$!
for i in $(seq 1 50); do [ -e /tmp/fake-cast.ready ] && break; sleep 0.1; done
[ -e /tmp/fake-cast.ready ] || fail "fake cast never reached its prompt"
ls -A /etc/capstan/anchor | grep -q '^\.new\.' || fail "no .new folder while cast waits"
kill -HUP -- "-$hpid" 2>/dev/null; wait "$hpid" 2>/dev/null
ls -A /etc/capstan/anchor | grep -q '^\.new\.' && fail "hangup left the half-made keystore folder behind"
[ ! -e /etc/capstan/anchor/keystore.json ] || fail "keystore stored after a hangup"
rm -f /tmp/fake-cast.ready
# second run: nothing new, same address
m1="$(stat -c '%Y %i' /etc/capstan/receipts/keystore.json)"
out2="$(/bin/bash "$dir/make-service-key.sh" receipts testnet </dev/null 2>&1)"
assert_eq "$out2" "$out" "second run prints the same address"
assert_eq "$(stat -c '%Y %i' /etc/capstan/receipts/keystore.json)" "$m1" "keystore untouched"
# a mainnet run against a testnet key is refused without --rotate
if /bin/bash "$dir/make-service-key.sh" receipts mainnet </dev/null >/dev/null 2>&1; then fail "network change without --rotate was accepted"; fi
# a wrong second password stores nothing
rm -f /etc/capstan/anchor/keystore.*
if printf 'not the same\n' | FAKE_CAST_PASSWORD="$PW" /bin/bash "$dir/make-service-key.sh" anchor testnet >/dev/null 2>&1; then fail "a mismatched password was stored"; fi
[ ! -e /etc/capstan/anchor/keystore.json ] || fail "keystore stored after a password mismatch"
# --rotate keeps the old key aside and prints the new address only
out3="$(printf '%s\n' "$PW" | FAKE_CAST_PASSWORD="$PW" /bin/bash "$dir/make-service-key.sh" receipts testnet --rotate 2>&1)"
printf '%s' "$out3" | grep -qE '^0x[0-9a-f]{40}$' || fail "rotate output: $out3"
[ "$out3" != "$out" ] || fail "rotate kept the same address"
assert_eq "$(ls /etc/capstan/receipts | grep -cE '^keystore\.[0-9TZ]+\.json$')" "1" "old keystore kept"
# unknown service and the password never in process arguments (read from stdin, not argv)
if /bin/bash "$dir/make-service-key.sh" api testnet </dev/null >/dev/null 2>&1; then fail "a key for a service without keys was made"; fi
grep -v '^[[:space:]]*#' "$dir/make-service-key.sh" | grep -nE 'unsafe-password|CAST_PASSWORD' && fail "script uses an unsafe password path"
pass
