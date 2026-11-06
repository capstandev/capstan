#!/bin/bash
# MCP inspector check (todo 31 R8): the official inspector CLI (pinned) lists and calls every tool against the local
# endpoint http://127.0.0.1:${MCP_PORT:-22113}/mcp. Output goes to $OUT (a fresh temp folder by default).
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN=/opt/homebrew/bin/bun
INSPECTOR="@modelcontextprotocol/inspector@2.13.0"
PORT="${MCP_PORT:-22113}"
URL="http://127.0.0.1:${PORT}/mcp"
OUT="${OUT:-$(mktemp -d)}"
mkdir -p "$OUT" "$OUT/home"
CATALOG="$OUT/catalog.json"

"$BUN" "$ROOT/apps/mcp/test/local-stack.ts" > "$OUT/stack.log" 2>&1 &
STACK_PID=$!
trap 'kill "$STACK_PID" 2>/dev/null || true' EXIT
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if grep -q ready "$OUT/stack.log" 2>/dev/null; then break; fi
  sleep 0.5
done
grep -q ready "$OUT/stack.log" || { echo "inspector: stack did not start"; cat "$OUT/stack.log"; exit 1; }
echo "stage: stack up on $URL"

# MCP_CATALOG_PATH keeps the inspector from writing a catalog in the home folder
ins() { HOME="$OUT/home" MCP_CATALOG_PATH="$CATALOG" "$BUN" x "$INSPECTOR" --cli "$URL" --transport http "$@"; }

ins --method tools/list > "$OUT/tools-list.json"
COUNT=$(grep -o '"name": *"capstan_[a-z_]*"' "$OUT/tools-list.json" | sort -u | wc -l | tr -d ' ')
echo "stage: tools/list $COUNT tools"

OWNER=0x00000000000000000000000000000000000000a1
ENV='{"buildId":"01JB0000000000000000000000","venue":"hyperliquid","encoding":"hl_l1_action","signedBody":{},"signature":"0x00","signerRef":"x","payloadHash":"0x00"}'
INTENT='{"marketId":"hyperliquid:-:ETH","side":"buy","size":"1","type":"market","tif":"ioc","reduceOnly":false,"maxSlippageBps":50}'
READ='{"message":"bm90LWEtcmVhbC1zaWduZWQtcmVhZA==","signature":"0x'"$(printf '%0130d' 0)"'"}'
called=0
call() {
  name="$1"; shift
  ins --method tools/call --tool-name "$name" "$@" > "$OUT/call-$name.json" 2>&1 || true
  if grep -q '"content"' "$OUT/call-$name.json"; then called=$((called + 1)); echo "stage: called $name"; else echo "stage: FAILED $name"; cat "$OUT/call-$name.json"; fi
}
call capstan_markets --tool-arg asset=CR:ETH
call capstan_quote --tool-arg canonicalAsset=CR:ETH side=buy sizeBase=1 leverage=5 holdHours=2 orderType=market
call capstan_build_order --tool-arg owner=$OWNER agentRef=hl:test "intent=$INTENT" mode=relay
call capstan_submit --tool-arg buildId=01JB0000000000000000000000 "signedEnvelope=$ENV"
call capstan_positions --tool-arg owner=$OWNER "ownerRead=$READ"
call capstan_risk --tool-arg owner=$OWNER "ownerRead=$READ"
echo "inspector: listed $COUNT, called $called of 6 (output in $OUT)"
[ "$COUNT" -ge 6 ] && [ "$called" -eq 6 ]
