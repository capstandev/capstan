#!/bin/bash
# Creates the TESTNET brand Safe on Robinhood Chain testnet (46630) once: SafeL2 1.4.1 proxy, owners safe-1, safe-2 and
# safe-3 from make-wallets.sh, threshold 2, no modules, no guard (what DeployAll's Safe check requires). Sent from the
# testnet deployer keystore after a chain-id assert. Safe to run again: a recorded Safe with code is a skip line.
# Records <home>/brand-safe.json (public: address, owners, threshold, tx). Testnet only: refuses any other chain.
# RPC_URL overrides the public testnet RPC (an anvil fork of 46630 in tests; it still has to answer chain id 46630).
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
CAST="${TESTNET_TOOL_DIR:-$HOME/.foundry/bin}/cast"
BUN="${TESTNET_BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="/opt/homebrew/bin/bun"
home="${CAPSTAN_TESTNET_HOME:-$HOME/.capstan-testnet}"
ks="${CAPSTAN_TESTNET_KEYSTORES:-$HOME/.foundry/keystores}"
rpc="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
# Safe 1.4.1 on 46630 (packages/schema constants/chains.ts rows safeL2141, safeProxyFactory141, safeFallbackHandler141)
SAFE_L2="0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"
FACTORY="0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"
FALLBACK="0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99"
ZERO="0x0000000000000000000000000000000000000000"
SALT="${SAFE_SALT:-4663046630}"
out="$home/brand-safe.json"

case "$rpc" in
  https://rpc.testnet.chain.robinhood.com|http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "refuse: $rpc is not the RHC testnet RPC or a local fork"; exit 1 ;;
esac
got="$("$CAST" chain-id --rpc-url "$rpc" 2>/dev/null || echo none)"
if [ "$got" != "46630" ]; then echo "refuse: chain id $got, expected 46630"; exit 1; fi
echo "safe: chain id $got ok"

addr_of() { "$BUN" -e 'const d=JSON.parse(await Bun.file(process.argv[1]).text());const a=d[process.argv[2]];if(!a)process.exit(1);console.log(a)' "$1" "$2"; }
if [ -f "$out" ]; then
  a="$(addr_of "$out" address)"
  if [ "$("$CAST" codesize "$a" --rpc-url "$rpc" 2>/dev/null || echo 0)" != "0" ]; then echo "skip: brand Safe already at $a"; exit 0; fi
fi

s1="$(addr_of "$home/addresses.json" safe-1)"; s2="$(addr_of "$home/addresses.json" safe-2)"; s3="$(addr_of "$home/addresses.json" safe-3)"
deployer="$(addr_of "$home/addresses.json" deployer)"
kargs="--keystore $ks/capstan-testnet-deployer --password-file $home/capstan-testnet-deployer.password"
init="$("$CAST" calldata 'setup(address[],uint256,address,bytes,address,address,uint256,address)' "[$s1,$s2,$s3]" 2 "$ZERO" 0x "$FALLBACK" "$ZERO" 0 "$ZERO")"
predicted="$("$CAST" call "$FACTORY" 'createProxyWithNonce(address,bytes,uint256)(address)' "$SAFE_L2" "$init" "$SALT" --from "$deployer" --rpc-url "$rpc")"
tx="$("$CAST" send "$FACTORY" 'createProxyWithNonce(address,bytes,uint256)' "$SAFE_L2" "$init" "$SALT" $kargs --rpc-url "$rpc" --json | "$BUN" -e 'const j=JSON.parse(await Bun.stdin.text());if(j.status!=="0x1"){console.error("reverted");process.exit(1)}console.log(j.transactionHash)')"
threshold="$("$CAST" call "$predicted" 'getThreshold()(uint256)' --rpc-url "$rpc")"
if [ "$threshold" != "2" ]; then echo "safe: refuse: threshold $threshold at $predicted"; exit 1; fi
"$BUN" -e 'const [f,a,o1,o2,o3,tx]=process.argv.slice(1);await Bun.write(f,JSON.stringify({address:a,owners:[o1,o2,o3],threshold:2,singleton:"SafeL2 1.4.1",chainId:46630,tx},null,2)+"\n")' "$out" "$predicted" "$s1" "$s2" "$s3" "$tx"
echo "safe: brand Safe $predicted created (owners safe-1, safe-2, safe-3, threshold 2)"
