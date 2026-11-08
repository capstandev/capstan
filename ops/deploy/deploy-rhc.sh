#!/bin/bash
# Owner-run deploy to Robinhood Chain, in order: CPST (whole supply to the brand Safe) -> CPSTLock -> CapstanReceiptAnchor.
# Usage: /bin/bash ops/deploy/deploy-rhc.sh local|testnet|mainnet
#   local   : anvil on 127.0.0.1:21445 (RPC_URL to override), chain 31337, a fresh throwaway keystore made here,
#             record in contracts/deployments/local/31337.json (never committed); with no BRAND_SAFE a code-only
#             stand-in holds the local supply
#   testnet : chain 46630, keystore account "capstan-deployer" (Foundry's own hidden password prompt), or for the agent-run
#             testnet run DEPLOYER_KEYSTORE + DEPLOYER_PASSWORD_FILE (testnet only), POSTER_ADDRESS,
#             BRAND_SAFE (must pass the real Safe check: Safe 1.4.1, threshold >= 2, no modules, no guard)
#   mainnet : chain 4663, same, plus CAPSTAN_MAINNET_GO=go-<today's UTC date> set by the owner
# macOS bash 3.2 safe. One line per stage. Every stage checks the chain first and skips what is already done, so a
# second run prints only skip lines for the deploy stages.
set -eu
net="${1:-}"
here="$(cd "$(dirname "$0")" && pwd -P)"
root="$(cd "$here/../.." && pwd -P)"
# Tool paths are absolute; DEPLOY_TOOL_DIR (tests only) points every tool at stand-ins.
FORGE="${DEPLOY_TOOL_DIR:-$HOME/.foundry/bin}/forge"
CAST="${DEPLOY_TOOL_DIR:-$HOME/.foundry/bin}/cast"
BUN="${DEPLOY_TOOL_DIR:-$HOME/.bun/bin}/bun"
[ -x "$BUN" ] || BUN="/opt/homebrew/bin/bun"
CURL="${DEPLOY_TOOL_DIR:-/usr/bin}/curl"
# Sourcify's read API: a contract counts as verified only when this answers a match for its address.
SOURCIFY_API="${SOURCIFY_API:-https://sourcify.dev/server}"
# Gas of one full deploy (CPST + lock + anchor): the local DeployAll run measured 2,482,333 (forge estimate), x1.5.
# An Orbit chain also charges an L1 data component, so this is a floor, not a promise.
DEPLOY_GAS=3700000

case "$net" in
  local) rpc="${RPC_URL:-http://127.0.0.1:21445}"; want="${EXPECTED_CHAIN_ID:-31337}"; file_rel="deployments/local/31337.json" ;;
  testnet) rpc="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"; want="${EXPECTED_CHAIN_ID:-46630}"; file_rel="deployments/46630.json" ;;
  mainnet) rpc="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"; want="${EXPECTED_CHAIN_ID:-4663}"; file_rel="deployments/4663.json" ;;
  *) echo "usage: deploy-rhc.sh local|testnet|mainnet"; exit 2 ;;
esac
mkdir -p "$root/contracts/deployments/local" "$root/out/deploy-logs"
log="$root/out/deploy-logs/deploy-$net-$(date -u +%Y%m%dT%H%M%SZ).log"
file="$root/contracts/$file_rel"

# stage 1: chain id
got="$("$CAST" chain-id --rpc-url "$rpc" 2>/dev/null || echo none)"
if [ "$got" != "$want" ]; then echo "stage 1: refuse: chain id $got, expected $want"; exit 1; fi
echo "stage 1: chain id $got ok"

# deployer and poster
if [ "$net" = "local" ]; then
  kdir="$root/out/deploy-local"
  mkdir -p "$kdir"
  if [ ! -f "$kdir/deployer.addr" ]; then
    # throwaway local keys: random password in a file, keystores under out/ (gitignored); never used off 31337
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$kdir/password"
    chmod 600 "$kdir/password"
    for who in deployer poster; do
      "$CAST" wallet new "$kdir" "$who" --unsafe-password "$(cat "$kdir/password")" >/dev/null 2>&1
      "$CAST" wallet address --keystore "$kdir/$who" --password-file "$kdir/password" > "$kdir/$who.addr"
    done
  fi
  deployer="$(cat "$kdir/deployer.addr")"
  POSTER_ADDRESS="${POSTER_ADDRESS:-$(cat "$kdir/poster.addr")}"
  wallet_args="--keystore $kdir/deployer --password-file $kdir/password"
else
  if [ -z "${POSTER_ADDRESS:-}" ]; then echo "stage 1: refuse: POSTER_ADDRESS is not set"; exit 1; fi
  if [ -z "${BRAND_SAFE:-}" ]; then echo "stage 1: refuse: BRAND_SAFE is not set"; exit 1; fi
  if [ "$net" = "testnet" ] && [ -n "${DEPLOYER_KEYSTORE:-}" ] && [ -n "${DEPLOYER_PASSWORD_FILE:-}" ]; then
    # agent-run testnet deploy (ops/testnet/run-all.ts): the testnet deployer keystore with its password file.
    # Testnet only: mainnet always uses the owner's keystore and Foundry's hidden password prompt.
    deployer="$("$CAST" wallet address --keystore "$DEPLOYER_KEYSTORE" --password-file "$DEPLOYER_PASSWORD_FILE")"
    wallet_args="--keystore $DEPLOYER_KEYSTORE --password-file $DEPLOYER_PASSWORD_FILE"
  else
    deployer="$("$CAST" wallet address --account capstan-deployer)"
    wallet_args="--account capstan-deployer"
  fi
fi

# stage 2: deployer balance against the dry-run gas
gp="$("$CAST" gas-price --rpc-url "$rpc")"
need=$(( DEPLOY_GAS * gp ))
bal="$("$CAST" balance "$deployer" --rpc-url "$rpc")"
if [ "$net" = "local" ] && [ "$bal" = "0" ]; then
  "$CAST" rpc anvil_setBalance "$deployer" 0x8AC7230489E80000 --rpc-url "$rpc" >/dev/null
  bal="$("$CAST" balance "$deployer" --rpc-url "$rpc")"
fi
if [ "$(echo "$bal < $need" | bc)" = "1" ]; then echo "stage 2: refuse: deployer $deployer has $bal wei, needs $need"; exit 1; fi
echo "stage 2: deployer $deployer balance ok ($bal wei, needs $need)"

# stage 3: what is already deployed (address in the file and code on chain)
# read with a JSON parser: the file is one line per contract when forge writes it and indented after stage 5 rewrites it
addr_of() { [ -f "$file" ] && "$BUN" -e 'const d=JSON.parse(await Bun.file(process.argv[1]).text());const a=d.contracts?.[process.argv[2]]?.address;if(typeof a==="string"&&/^0x[0-9a-fA-F]{40}$/.test(a))console.log(a)' "$file" "$1"; }
has_code() { [ -n "$1" ] && [ "$("$CAST" codesize "$1" --rpc-url "$rpc" 2>/dev/null || echo 0)" != "0" ]; }
todo=0
for c in CPST CPSTLock CapstanReceiptAnchor; do
  a="$(addr_of "$c" || true)"
  if has_code "${a:-}"; then echo "skip: already deployed at $a ($c)"; else todo=1; fi
done

# stage 4: deploy what is missing
if [ "$todo" = "1" ]; then
  (cd "$root/contracts" && CAPSTAN_DEPLOY_ARMED=1 EXPECTED_CHAIN_ID="$want" POSTER_ADDRESS="$POSTER_ADDRESS" \
    BRAND_SAFE="${BRAND_SAFE:-}" DEPLOYMENTS_FILE="$file_rel" \
    "$FORGE" script script/DeployAll.s.sol:DeployAll --rpc-url "$rpc" --broadcast $wallet_args >"$log" 2>&1) \
    || { echo "stage 4: deploy failed (log: $log)"; tail -20 "$log"; exit 1; }
  echo "stage 4: deployed (log: $log)"
else
  echo "skip: stage 4, nothing to deploy"
fi

# stage 5: Sourcify (lists 4663 and 46630, checked 2026-11-06 at sourcify.dev/server/chains). A contract counts as
# verified only when forge exits 0 AND Sourcify's own read API then answers a match for the address. Any failure is
# recorded as "verified": false with the failed names, the copies are regenerated, and the run exits 1 (a re-run
# retries stage 5, because only "verified": true skips it).
sourcify_match() { # address -> 0 when Sourcify answers match or exact_match
  "$CURL" -fsS --max-time 20 "$SOURCIFY_API/v2/contract/$want/$1" 2>/dev/null | grep -Eq '"match" *: *"(exact_match|match)"'
}
stage5_failed=""
if [ "$net" = "local" ]; then
  echo "skip: stage 5, no Sourcify on the local chain"
elif grep -q '"verified": true' "$file"; then
  echo "skip: stage 5, Sourcify already recorded"
else
  cpst_addr="$(addr_of CPST)"
  for c in CPST CPSTLock CapstanReceiptAnchor; do
    a="$(addr_of "$c")"
    case "$c" in
      CPST) args="$("$CAST" abi-encode 'f(address)' "$BRAND_SAFE")" ;;
      CPSTLock) args="$("$CAST" abi-encode 'f(address)' "$cpst_addr")" ;;
      *) args="$("$CAST" abi-encode 'f(address)' "$POSTER_ADDRESS")" ;;
    esac
    if (cd "$root/contracts" && "$FORGE" verify-contract "$a" "src/$c.sol:$c" --verifier sourcify --chain-id "$want" \
      --constructor-args "$args" --watch >>"$log" 2>&1); then
      if sourcify_match "$a"; then
        echo "stage 5: Sourcify verified $c at $a"
      else
        echo "stage 5: Sourcify verify FAILED for $c: forge exited 0 but Sourcify has no match for $a (log: $log)"
        stage5_failed="$stage5_failed $c"
      fi
    else
      echo "stage 5: Sourcify verify FAILED for $c (log: $log)"
      stage5_failed="$stage5_failed $c"
    fi
  done
  if [ -z "$stage5_failed" ]; then
    "$BUN" -e 'const f=process.argv[1];const d=JSON.parse(await Bun.file(f).text());d.sourcify={verified:true,url:"https://repo.sourcify.dev/"+d.chainId+"/"+d.contracts.CapstanReceiptAnchor.address};await Bun.write(f,JSON.stringify(d,null,2)+"\n")' "$file"
    (cd "$root" && "$BUN" ops/ci/gen-deployments.ts >/dev/null)
    echo "stage 5: Sourcify recorded as verified, copies regenerated"
  else
    "$BUN" -e 'const f=process.argv[1];const d=JSON.parse(await Bun.file(f).text());d.sourcify={verified:false,failed:process.argv[2].trim().split(/\s+/)};await Bun.write(f,JSON.stringify(d,null,2)+"\n")' "$file" "$stage5_failed"
    (cd "$root" && "$BUN" ops/ci/gen-deployments.ts >/dev/null)
    echo "stage 5: refuse: Sourcify NOT verified for$stage5_failed; recorded as not verified, copies regenerated"
  fi
fi

# stage 6: read-only post-deploy check
/bin/bash "$here/post-deploy-check.sh" "$net"
# a failed Sourcify verify fails the run (after the read-only check), so the owner re-runs to retry stage 5
if [ -n "$stage5_failed" ]; then echo "result: deploy ok, Sourcify NOT verified for$stage5_failed (exit 1; re-run to retry)"; exit 1; fi
