#!/bin/bash
# Prove the Solana x402 rail end to end on a local solana-test-validator (tracker line 78).
# The test (packages/x402/test/solana-local/solana-local.test.ts) starts its own validator with the real mainnet
# USDC mint (one read-only getAccountInfo from SOLANA_MAINNET_RPC_URL, default the public mainnet RPC; a local mint
# with the same address and 6 decimals when that read fails, and the log says so) and accounts funded at genesis:
# no faucet, no airdrop, no devnet, no mainnet write. It checks: 402 on a paid route, the payer pays, the facilitator
# refuses while disarmed (403), verifies and settles when armed (X402_SETTLE_ARMED=1 in the test only), the balance
# moves once, a replay is refused, a wrong amount is refused.
# Ports: validator RPC 25540 (+25541 websocket), faucet 25542 (0 SOL, unused), gossip 25543, facilitator 25559,
# validator dynamic ports SOLANA_DYNAMIC_PORT_RANGE (default 45540-45579; the validator needs 26 or more).
# Needs solana-test-validator on PATH or SOLANA_TEST_VALIDATOR (free: `brew install solana`, Agave 4.4.1 used).
# Usage (from backend/): ops/x402/solana-local-proof.sh     exit 0 = every check passed, 3 = no validator
#        ops/x402/solana-local-proof.sh --verdict <rc> <log>   judge a saved bun test log (used by its own test)
set -u
# PASS only when bun exited 0 and its summary says at least 1 pass, 0 fail and no skip (a skipped proof is no proof).
verdict() {
  local rc="$1" log="$2"
  [ "$rc" -eq 0 ] || return 1
  [ -f "$log" ] || return 1
  grep -Eq '^ *[1-9][0-9]* pass$' "$log" || return 1
  grep -Eq '^ *0 fail$' "$log" || return 1
  if grep -Eq '^ *[1-9][0-9]* skip$' "$log"; then return 1; fi
  return 0
}
if [ "${1:-}" = "--verdict" ]; then
  if verdict "${2:-1}" "${3:-}"; then echo "PASS"; exit 0; fi
  echo "FAIL"; exit 1
fi
cd "$(dirname "$0")/../.." || exit 2
BIN="${SOLANA_TEST_VALIDATOR:-$(command -v solana-test-validator || true)}"
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "solana-test-validator not found: install the Solana CLI (brew install solana) or set SOLANA_TEST_VALIDATOR" >&2
  exit 3
fi
if [ -n "${SOLANA_MAINNET_RPC_URL:-}" ]; then echo "mint read from SOLANA_MAINNET_RPC_URL (read-only)"; fi
for p in 25540 25541 25542 25543 25559; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $p is in use; stop its owner first" >&2; exit 2; fi
done
echo "validator: $("$BIN" --version)"
LOG=$(mktemp "${TMPDIR:-/tmp}/capstan-solana-proof.XXXXXX")
SOLANA_TEST_VALIDATOR="$BIN" bun test ./packages/x402/test/solana-local/solana-local.test.ts 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
if verdict "$rc" "$LOG"; then
  echo "SOLANA LOCAL PROOF: PASS (log $LOG)"
  exit 0
fi
echo "SOLANA LOCAL PROOF: FAIL (log $LOG)" >&2
exit 1
