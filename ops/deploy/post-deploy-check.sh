#!/bin/bash
# Read-only post-deploy check (contracts/script/PostDeployCheck.s.sol): code at every address, runtime code equal to
# a fresh build, poster() and token() equal to the deployment file, reviewed selector set, chain id, Sourcify status.
# Usage: /bin/bash ops/deploy/post-deploy-check.sh local|testnet|mainnet   (never broadcasts)
set -eu
net="${1:-}"
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
FORGE="$HOME/.foundry/bin/forge"
case "$net" in
  local) rpc="${RPC_URL:-http://127.0.0.1:21445}"; want="${EXPECTED_CHAIN_ID:-31337}"; file_rel="deployments/local/31337.json" ;;
  testnet) rpc="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"; want="${EXPECTED_CHAIN_ID:-46630}"; file_rel="deployments/46630.json" ;;
  mainnet) rpc="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"; want="${EXPECTED_CHAIN_ID:-4663}"; file_rel="deployments/4663.json" ;;
  *) echo "usage: post-deploy-check.sh local|testnet|mainnet"; exit 2 ;;
esac
mkdir -p "$root/out/deploy-logs"
log="$root/out/deploy-logs/post-deploy-check-$net.log"
if (cd "$root/contracts" && EXPECTED_CHAIN_ID="$want" DEPLOYMENTS_FILE="$file_rel" BRAND_SAFE="${BRAND_SAFE:-}" \
  "$FORGE" script script/PostDeployCheck.s.sol:PostDeployCheck --rpc-url "$rpc" >"$log" 2>&1); then
  echo "stage 6: post-deploy check ok ($(grep -c 'ok:' "$log") contracts)"
else
  echo "stage 6: post-deploy check FAILED (log: $log)"; tail -15 "$log"; exit 1
fi
