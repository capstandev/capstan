#!/bin/bash
# Owner-run planner for the monthly CPST burn (DECISIONS #37). Read-only: it quotes on chain and writes a Safe
# Transaction Builder batch file; it never sends a transaction and has no key. The brand Safe's signers load the file
# in the Safe UI, two of them approve, and the owner posts the tx hash.
# Usage: /bin/bash ops/deploy/burn-plan.sh fork-local|testnet|mainnet [--force]
#   fork-local : an anvil fork of 4663 on 127.0.0.1:21445 (RPC_URL to override); builds a throwaway Safe, CPST and
#                CPST/USDG pool inside the script's own simulation (no CPST pool exists on chain yet)
#   testnet    : 46630, real inputs (BRAND_SAFE, CPST_ADDRESS, CPST_POOL, AMOUNT_USDG, ...)
#   mainnet    : 4663, real inputs; POOL_KIND=v3 with CPST_POOL=<v3 pool> also works there
# Inputs: AMOUNT_USDG (whole USDG), BURN_CHUNK_USDG (default 1000), MAX_SLIPPAGE_BPS (default 100), POOL_KIND,
# CPST_POOL, CPST_POOL_FEE, CPST_POOL_TICK_SPACING, CPST_POOL_HOOKS. macOS bash 3.2 safe. One line per stage.
set -eu
net="${1:-}"
force="${2:-}"
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
FORGE="$HOME/.foundry/bin/forge"
CAST="$HOME/.foundry/bin/cast"
demo=0
case "$net" in
  fork-local) rpc="${RPC_URL:-http://127.0.0.1:21445}"; want=4663; demo=1 ;;
  testnet) rpc="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"; want=46630 ;;
  mainnet) rpc="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"; want=4663 ;;
  *) echo "usage: burn-plan.sh fork-local|testnet|mainnet [--force]"; exit 2 ;;
esac
if [ "$demo" = "1" ]; then
  case "$rpc" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "stage 1: refuse: fork-local needs a local RPC, got $rpc"; exit 1 ;; esac
fi
mkdir -p "$root/out/burn" "$root/out/deploy-logs"
day="$(date -u +%Y-%m-%d)"
file="$root/out/burn/$day.json"
log="$root/out/deploy-logs/burn-plan-$net-$(date -u +%Y%m%dT%H%M%SZ).log"

# stage 1: chain id
got="$("$CAST" chain-id --rpc-url "$rpc" 2>/dev/null || echo none)"
if [ "$got" != "$want" ]; then echo "stage 1: refuse: chain id $got, expected $want"; exit 1; fi
echo "stage 1: chain id $got ok"

if [ -f "$file" ] && [ "$force" != "--force" ]; then
  echo "refuse: $file already exists; not overwritten (pass --force to plan again today)"
  exit 0
fi
fx=0; [ "$force" = "--force" ] && fx=1

# stages 2 to 4 run inside the read-only planner (no broadcast flag exists in it)
if ! (cd "$root/contracts" && EXPECTED_CHAIN_ID="$want" BURN_DEMO_POOL="$demo" BURN_FORCE="$fx" BURN_OUT_DIR="../out/burn" \
  "$FORGE" script script/BurnPlan.s.sol:BurnPlan --rpc-url "$rpc" >"$log" 2>&1); then
  reason="$(grep -oE '(NoPool|NoLiquidity|WrongPool|PoolIdMismatch|StaleQuote|BadSlippage|NotAnErc20Pair|ZeroAmount|ZeroQuote|NotARealSafe|ChainMismatch|BatchExists)[^ ]*' "$log" | head -1)"
  echo "stage 2: refuse: ${reason:-planner failed} (log: $log)"
  exit 1
fi
echo "stage 2: pool exists and has liquidity"
quote="$(grep 'quote (raw CPST):' "$log" | sed -E 's/.*: *//')"
minout="$(grep 'min out and burn (raw CPST):' "$log" | sed -E 's/.*: *//')"
chunks="$(grep 'chunks:' "$log" | sed -E 's/.*chunks: *//')"
echo "stage 3: quote $quote raw CPST, min out and burn $minout raw CPST, chunks $chunks"
sum="$(/usr/bin/shasum -a 256 "$file" | cut -d' ' -f1)"
echo "stage 4: batch file $file sha256 $sum"
