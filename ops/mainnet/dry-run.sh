#!/bin/bash
# Mainnet dry run on a local anvil fork of Robinhood Chain 4663 (todo 47 R1, R2, R4). Agent-run, fork only.
#   /bin/bash ops/mainnet/dry-run.sh                  full run, report to ../docs/reports/mainnet-dry-run-<date>.md
#   /bin/bash ops/mainnet/dry-run.sh --check-rpc URL  answers ok (exit 0) or refuse (exit 3) for an RPC URL
# It runs the EXACT owner script, ops/deploy/deploy-rhc.sh mainnet, from a snapshot of the committed tree (git
# archive HEAD, every deploy file's sha256 compared with the checkout), with the real chain id 4663, the same
# constants and the same go flag check. Only two things differ from the owner's run, and the report records both:
#   1. the deployer: a fresh `cast wallet new` keystore named capstan-deployer in a throwaway HOME (so --account
#      capstan-deployer finds it; the owner's real keystore folder is never read), funded with anvil_setBalance;
#   2. the RPC: http://127.0.0.1:22545 (fee shim, anvil itself on 22549), a fork behind ops/fork/rpc-cache.ts on 22546, which refuses every
#      write upstream. Any RPC_URL that is not one of those two loopback ports is refused before anything starts.
# Stage 5 (Sourcify) gets stand-in forge and curl for its two calls only (fork addresses do not exist on 4663, and
# nothing may be sent to Sourcify for them); every other tool is the real one.
# Inputs (all optional): BRAND_SAFE (the real brand Safe, read from the fork; default a fork-made Safe 1.4.1, 2 of 3),
# SAFE_OWNERS (three comma-separated public signer addresses: the fork-made stand-in Safe gets these owners instead of
# fresh ones, so the deploy runs with the real signer set before the real Safe exists; ignored when BRAND_SAFE is set),
# POSTER_ADDRESS (the address make-service-key.sh printed on the server; default a fresh fork key; a given address
# is impersonated on the fork for the anchor post). Then, on the fork contracts: a second deploy run (only skip
# lines), live-check.sh, one anchor post, one USDG settle on each path (Permit2, EIP-3009) through the facilitator's
# own signer. macOS bash 3.2 safe. Stops only the processes it started.
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
root="$(cd "$here/../.." && pwd -P)"
ANVIL="$HOME/.foundry/bin/anvil"
CAST="$HOME/.foundry/bin/cast"
FORGE="$HOME/.foundry/bin/forge"
BUN="$HOME/.bun/bin/bun"; [ -x "$BUN" ] || BUN="/opt/homebrew/bin/bun"
P_ANVIL="${DRYRUN_ANVIL_PORT:-22545}"
P_CACHE="${DRYRUN_CACHE_PORT:-22546}"
P_ANVIL_IN="${DRYRUN_ANVIL_INNER_PORT:-22549}" # anvil itself; 22545 is ops/fork/fee-shim.ts with the real chain's tip (0)
RPC="http://127.0.0.1:$P_ANVIL"
CACHE="http://127.0.0.1:$P_CACHE"
UPSTREAM="${RHC_UPSTREAM:-https://rpc.mainnet.chain.robinhood.com}" # read through rpc-cache only, which refuses writes
SOURCIFY_STUB="http://127.0.0.1:9/dry-run-sourcify"

is_local_rpc() {
  case "$1" in
    "http://127.0.0.1:$P_ANVIL"|"http://127.0.0.1:$P_CACHE"|"http://localhost:$P_ANVIL"|"http://localhost:$P_CACHE") return 0 ;;
    *) return 1 ;;
  esac
}
if [ "${1:-}" = "--check-rpc" ]; then
  if is_local_rpc "${2:-}"; then echo "ok: ${2:-} is the local dry-run fork"; exit 0; fi
  echo "refuse: ${2:-<empty>} is not the local dry-run anvil ($RPC) or rpc-cache ($CACHE)"; exit 3
fi
if [ -n "${RPC_URL:-}" ] && ! is_local_rpc "$RPC_URL"; then
  echo "refuse: RPC_URL $RPC_URL is not the local dry-run anvil ($RPC) or rpc-cache ($CACHE)"; exit 3
fi
[ "$#" -eq 0 ] || { echo "usage: dry-run.sh [--check-rpc URL]"; exit 2; }

# the dry run deploys the committed tree: refuse uncommitted changes to anything the deploy reads
deploy_paths="ops/deploy contracts/script contracts/src contracts/lib contracts/foundry.toml contracts/remappings.txt ops/ci/gen-deployments.ts ops/ci/deployments.ts"
# shellcheck disable=SC2086
if ! git -C "$root" diff --quiet HEAD -- $deploy_paths; then echo "refuse: uncommitted changes under the deploy inputs; commit first"; exit 1; fi

listening() { /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
for p in "$P_ANVIL" "$P_CACHE" "$P_ANVIL_IN"; do if listening "$p"; then echo "refuse: port $p is taken by a process this script did not start"; exit 1; fi; done

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
# run state lives outside every checkout (a snapshot inside the repo would be scanned by the repo checks and tests)
run="${DRYRUN_STATE_DIR:-$HOME/Library/Caches/capstan-mainnet-dry-run}/run-$stamp"
mkdir -p "$run/logs"
started=""
cleanup() {
  for p in $started; do
    if kill -0 "$p" 2>/dev/null; then kill "$p" 2>/dev/null || true; fi
  done
  for p in $started; do i=0; while kill -0 "$p" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done; done
  # throwaway fork keys: removed with the run (logs and public results stay)
  rm -rf "$run/keys" "$run/home/.foundry/keystores"
  # the snapshot and its build (the report keeps what it needs); DRYRUN_KEEP=1 keeps them for a look
  [ "${DRYRUN_KEEP:-0}" = "1" ] || rm -rf "$run/repo"
}
trap cleanup EXIT
wait_port() { i=0; while ! listening "$1"; do i=$((i+1)); if [ "$i" -gt 240 ]; then echo "fail: $2 did not listen on $1 (log: $run/logs/$2.log)"; tail -20 "$run/logs/$2.log" || true; exit 1; fi; sleep 0.25; done; }
meta() { echo "$1=$2" >> "$run/meta.env"; }
: > "$run/meta.env"

# 1. the fork: rpc-cache (refuses writes upstream) and anvil on loopback, chain id 4663
nohup "$BUN" "$root/ops/fork/rpc-cache.ts" --port "$P_CACHE" --upstream "$UPSTREAM" >"$run/logs/rpc-cache.log" 2>&1 </dev/null &
started="$started $!"; wait_port "$P_CACHE" rpc-cache
live_gp="$("$CAST" gas-price --rpc-url "$CACHE")"
nohup "$ANVIL" --fork-url "$CACHE" --port "$P_ANVIL_IN" --chain-id 4663 --hardfork cancun --no-storage-caching --host 127.0.0.1 \
  --disable-min-priority-fee --block-base-fee-per-gas "$live_gp" >"$run/logs/anvil.log" 2>&1 </dev/null &
started="$started $!"; wait_port "$P_ANVIL_IN" anvil
# anvil always suggests a 1 gwei tip (RHC answers 0): the shim answers the real tip, everything else passes through
nohup "$BUN" "$root/ops/fork/fee-shim.ts" --port "$P_ANVIL" --target "http://127.0.0.1:$P_ANVIL_IN" --tip 0 >"$run/logs/fee-shim.log" 2>&1 </dev/null &
started="$started $!"; wait_port "$P_ANVIL" fee-shim
got="$("$CAST" chain-id --rpc-url "$RPC")"
[ "$got" = "4663" ] || { echo "fail: fork chain id $got, expected 4663"; exit 1; }
fork_block="$("$CAST" block-number --rpc-url "$RPC")"
fork_ts="$("$CAST" block latest -f timestamp --rpc-url "$RPC")"
day="$(date -u -r "$fork_ts" +%Y-%m-%d)"
echo "step 1: fork of 4663 at block $fork_block on $RPC (rpc-cache $CACHE, live gas price $live_gp wei)"
meta rpc "$RPC"; meta cache "$CACHE"; meta upstream "$UPSTREAM"; meta fork_block "$fork_block"; meta fork_ts "$fork_ts"; meta live_gas_price "$live_gp"; meta stamp "$stamp"

# 2. throwaway keys (random passwords in 0600 files), funded on the fork only
home="$run/home"; keys="$run/keys"
mkdir -p "$home/.foundry/keystores" "$home/Library/Application Support" "$keys"
chmod 700 "$keys" "$home/.foundry/keystores"
ln -s "$HOME/.foundry/bin" "$home/.foundry/bin"
[ -d "$HOME/Library/Application Support/svm" ] && ln -s "$HOME/Library/Application Support/svm" "$home/Library/Application Support/svm"
newkey() { # dir name -> prints the address
  openssl rand -hex 24 > "$keys/$2.password"; chmod 600 "$keys/$2.password"
  "$CAST" wallet new "$1" "$2" --unsafe-password "$(cat "$keys/$2.password")" >/dev/null 2>&1
  "$CAST" wallet address --keystore "$1/$2" --password-file "$keys/$2.password"
}
fund() { "$CAST" rpc anvil_setBalance "$1" "$2" --rpc-url "$RPC" >/dev/null; }
deployer="$(newkey "$home/.foundry/keystores" capstan-deployer)"
fund "$deployer" 0xDE0B6B3A7640000 # 1 ETH on the fork
poster_mode="keystore"
if [ -n "${POSTER_ADDRESS:-}" ]; then poster="$POSTER_ADDRESS"; poster_mode="given"; else poster="$(newkey "$keys" poster)"; fi
fund "$poster" 0xB1A2BC2EC50000 # 0.05 ETH
facilitator="$(newkey "$keys" facilitator)"
fund "$facilitator" 0xB1A2BC2EC50000
echo "step 2: fresh deployer $deployer, poster $poster ($poster_mode), facilitator $facilitator (fork balances only)"
meta deployer "$deployer"; meta poster "$poster"; meta poster_mode "$poster_mode"; meta facilitator "$facilitator"

# 3. the brand Safe: the real one if given (read from the fork), else a Safe 1.4.1 made on the fork
if [ -n "${BRAND_SAFE:-}" ]; then safe="$BRAND_SAFE"; safe_mode="given"
elif [ -n "${SAFE_OWNERS:-}" ]; then safe="$("$BUN" "$here/fork-steps.ts" safe --rpc "$RPC" --out "$run/safe.json" --owners "$SAFE_OWNERS" | tail -1)"; safe_mode="fork-made-given-owners"; meta safe_owners "$SAFE_OWNERS"
else safe="$("$BUN" "$here/fork-steps.ts" safe --rpc "$RPC" --out "$run/safe.json" | tail -1)"; safe_mode="fork-made"; fi
echo "$safe" | grep -Eq '^0x[0-9a-fA-F]{40}$' || { echo "fail: no brand Safe address (fork-made Safe failed?)"; exit 1; }
echo "step 3: brand Safe $safe ($safe_mode)"
meta safe "$safe"; meta safe_mode "$safe_mode"

# 4. the exact script from the committed tree
repo="$run/repo"; mkdir -p "$repo"
git -C "$root" archive --format=tar HEAD | tar -x -C "$repo"
head_sha="$(git -C "$root" rev-parse HEAD)"
meta head_sha "$head_sha"
: > "$run/exact-script.tsv"
same=1
for f in ops/deploy/deploy-rhc.sh ops/deploy/post-deploy-check.sh contracts/script/DeployAll.s.sol contracts/script/DeployAnchorLock.s.sol \
  contracts/script/PostDeployCheck.s.sol contracts/script/lib/Guard.sol contracts/script/lib/SafeCheck.sol contracts/script/lib/Deployments.sol \
  contracts/script/lib/RhcAddresses.sol contracts/src/CPST.sol contracts/src/CPSTLock.sol contracts/src/CapstanReceiptAnchor.sol contracts/foundry.toml; do
  a="$(shasum -a 256 "$root/$f" | cut -d' ' -f1)"; b="$(shasum -a 256 "$repo/$f" | cut -d' ' -f1)"
  printf '%s\t%s\t%s\n' "$f" "$a" "$b" >> "$run/exact-script.tsv"
  [ "$a" = "$b" ] || same=0
done
[ "$same" = "1" ] || { echo "fail: the snapshot differs from the checkout (see $run/exact-script.tsv)"; exit 1; }
sha_or_absent() { if [ -f "$1" ]; then shasum -a 256 "$1" | cut -d' ' -f1; else echo absent; fi; }
real_before="$(sha_or_absent "$root/contracts/deployments/4663.json")"
echo "step 4: snapshot of $head_sha, deploy files equal to the checkout"

tools="$run/tools"; mkdir -p "$tools"
ln -s "$BUN" "$tools/bun"
# dry-run stand-ins. forge and cast: the throwaway deployer's password comes from its file where the owner types it at
# Foundry's hidden prompt (only when the call names --account); forge verify-contract is not passed on (nothing is
# sent to Sourcify for fork addresses). curl: answers the Sourcify read for the stub URL only.
for t in forge cast; do
  real="$FORGE"; [ "$t" = "cast" ] && real="$CAST"
  cat > "$tools/$t" <<STUB
#!/bin/bash
if [ "$t" = "forge" ] && [ "\${1:-}" = "verify-contract" ]; then echo "dry run: verify-contract not sent to Sourcify"; exit 0; fi
for a in "\$@"; do if [ "\$a" = "--account" ]; then exec "$real" "\$@" --password-file "$keys/capstan-deployer.password"; fi; done
exec "$real" "\$@"
STUB
done
cat > "$tools/curl" <<STUB
#!/bin/bash
for a in "\$@"; do case "\$a" in "$SOURCIFY_STUB"/*) echo '{"match":"exact_match","note":"dry-run stand-in"}'; exit 0 ;; esac; done
exec /usr/bin/curl "\$@"
STUB
chmod +x "$tools/cast" "$tools/forge" "$tools/curl"
deploy() { # log
  /usr/bin/env -i HOME="$home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" DEPLOY_TOOL_DIR="$tools" RPC_URL="$RPC" \
    POSTER_ADDRESS="$poster" BRAND_SAFE="$safe" CAPSTAN_MAINNET_GO="go-$day" \
    SOURCIFY_API="$SOURCIFY_STUB" /bin/bash "$repo/ops/deploy/deploy-rhc.sh" mainnet >"$1" 2>&1
}
bal0="$("$CAST" balance "$deployer" --rpc-url "$RPC")"
if ! deploy "$run/logs/deploy-1.log"; then echo "fail: deploy-rhc.sh mainnet on the fork (log: $run/logs/deploy-1.log)"; tail -20 "$run/logs/deploy-1.log"; exit 1; fi
bal1="$("$CAST" balance "$deployer" --rpc-url "$RPC")"
meta deployer_balance_before "$bal0"; meta deployer_balance_after "$bal1"
sed 's/^/  /' "$run/logs/deploy-1.log"
file="$repo/contracts/deployments/4663.json"
cp "$repo/contracts/broadcast/DeployAll.s.sol/4663/run-latest.json" "$run/broadcast.json"
cp "$file" "$run/deployment-4663-fork.json"
echo "step 5: deploy-rhc.sh mainnet exit 0 on the fork"

# 6. second run: every deploy stage must skip
if ! deploy "$run/logs/deploy-2.log"; then echo "fail: second deploy-rhc.sh run (log: $run/logs/deploy-2.log)"; tail -20 "$run/logs/deploy-2.log"; exit 1; fi
skips="$(grep -c '^skip:' "$run/logs/deploy-2.log" || true)"
if grep -q '^stage 4: deployed' "$run/logs/deploy-2.log" || [ "$skips" -lt 5 ]; then echo "fail: the second run deployed again or skipped too little ($skips skip lines)"; exit 1; fi
meta rerun_skips "$skips"
echo "step 6: second run printed $skips skip lines and deployed nothing"

# 7. read-only live check against the fork record (bytecode vs build, poster, token, ticker, supply in the Safe, Safe)
if ! RPC_URL="$RPC" BRAND_SAFE="$safe" LIVE_CHECK_OUT="$run/live-check.md" LIVE_CHECK_CONTRACTS="$repo/contracts" /bin/bash "$here/live-check.sh" "$file" >"$run/logs/live-check.log" 2>&1; then
  echo "fail: live-check.sh on the fork record (log: $run/logs/live-check.log)"; tail -20 "$run/logs/live-check.log"; exit 1
fi
echo "step 7: $(tail -1 "$run/logs/live-check.log")"

# 8. one anchor post from the poster (the last closed hour of the fork clock)
anchor="$("$BUN" -e 'const d=JSON.parse(await Bun.file(process.argv[1]).text());console.log(d.contracts.CapstanReceiptAnchor.address)' "$file")"
hour=$(( fork_ts / 3600 - 1 ))
aroot="$("$CAST" keccak "capstan mainnet dry run $stamp")"
if [ "$poster_mode" = "keystore" ]; then
  "$CAST" send "$anchor" 'postRoot(uint64,bytes32,uint32)' "$hour" "$aroot" 1 --keystore "$keys/poster" --password-file "$keys/poster.password" --rpc-url "$RPC" --json >"$run/anchor.json" 2>"$run/logs/anchor.err"
else
  "$CAST" rpc anvil_impersonateAccount "$poster" --rpc-url "$RPC" >/dev/null
  "$CAST" send "$anchor" 'postRoot(uint64,bytes32,uint32)' "$hour" "$aroot" 1 --from "$poster" --unlocked --rpc-url "$RPC" --json >"$run/anchor.json" 2>"$run/logs/anchor.err"
  "$CAST" rpc anvil_stopImpersonatingAccount "$poster" --rpc-url "$RPC" >/dev/null
fi
posted="$("$CAST" call "$anchor" 'rootOf(uint64)(bytes32,uint32,uint64)' "$hour" --rpc-url "$RPC" | head -1)"
[ "$posted" = "$aroot" ] || { echo "fail: rootOf($hour) is $posted, expected $aroot"; exit 1; }
meta anchor_hour "$hour"
echo "step 8: anchor postRoot for hour $hour ok"

# 9. one USDG x402 settle on each RHC path, through the facilitator's own signer and the stock exact scheme
for m in permit2 eip3009; do
  if ! "$BUN" "$here/fork-steps.ts" settle --rpc "$RPC" --safe "$safe" --keystore "$keys/facilitator" --password-file "$keys/facilitator.password" --method "$m" --out "$run/settle-$m.json" >"$run/logs/settle-$m.log" 2>&1; then
    echo "fail: USDG $m settle (log: $run/logs/settle-$m.log)"; tail -10 "$run/logs/settle-$m.log"; exit 1
  fi
  echo "step 9: $(tail -1 "$run/logs/settle-$m.log")"
done

# 10. the committed 4663.json is untouched, then the report (prices read through the cache, never written)
real_after="$(sha_or_absent "$root/contracts/deployments/4663.json")"
[ "$real_before" = "$real_after" ] || { echo "fail: the checkout's contracts/deployments/4663.json changed"; exit 1; }
meta real_record "$real_after"
"$BUN" "$here/report.ts" --run "$run" --cache "$CACHE" --out-dir "${REPORT_DIR:-$root/../docs/reports}"
echo "dry-run: PASS (run folder $run)"
