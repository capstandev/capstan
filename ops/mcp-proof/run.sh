#!/bin/bash
# Hosted MCP and npm package proof (tracker line 79). Re-runnable; never publishes, never pushes, never broadcasts.
#  1. A local stack: Postgres + Redis (docker compose project $COMPOSE_PROJECT), the stand-in venues (ops/fork), the
#     api production entry, and the MCP production entry in keyless public mode (X402 off, MCP_ALLOWED_HOSTS set),
#     plus a second MCP entry with a low rate limit for the limit checks.
#  2. A fresh temp folder OUTSIDE the repo with plain npm and Node (no Bun on PATH): the official MCP SDK client over
#     Streamable HTTP calls every tool and checks Host, Origin, rate limits and key-like values (outside-client.mjs).
#  3. npm pack capstan-sdk and capstan-mcp, install both tarballs in that folder, build a quote with the SDK
#     (sdk-quote.mjs) and list the tools through `npx capstan-mcp` over stdio (stdio-list.mjs).
# Usage: ops/mcp-proof/run.sh [--keep]   (--keep leaves the stack up; stop it with the printed command)
# Ports: MCP_PROOF_PORT_BASE (default 24760) to base+9. Output: $OUT (default a fresh temp folder), summary on stdout.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1
B=${MCP_PROOF_PORT_BASE:-24760}
P_PG=$B; P_REDIS=$((B+1)); P_HL=$((B+2)); P_RH=$((B+3)); P_LM=$((B+4)); P_API=$((B+5)); P_MCP=$((B+6)); P_MCPRL=$((B+7)); P_DEAD=$((B+9))
COMPOSE_PROJECT=${COMPOSE_PROJECT:-capstan-mcpnpm}
PUBLIC_HOST=${MCP_PROOF_PUBLIC_HOST:-api.capstan.test}
OUT="${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/capstan-mcp-proof-XXXXXX")}"
case "$OUT" in "$root"*) echo "refuse: OUT must be outside the repo"; exit 1 ;; esac
mkdir -p "$OUT/logs" "$OUT/geo" "$OUT/work"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
NODEDIR="$(dirname "$NODE")"
DOCKER="$(command -v docker || echo /usr/local/bin/docker)"
PIDS=()

listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in $P_PG $P_REDIS $P_HL $P_RH $P_LM $P_API $P_MCP $P_MCPRL; do
  if listening "$p"; then echo "refuse: port $p is already in use (set MCP_PROOF_PORT_BASE)"; exit 1; fi
done

cleanup() {
  [ "$KEEP" = 1 ] && { echo "kept: stop with: kill ${PIDS[*]:-}; (cd $root && $DOCKER compose -p $COMPOSE_PROJECT down -v)"; return; }
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  (cd "$root" && CAPSTAN_PG_PORT=$P_PG CAPSTAN_REDIS_PORT=$P_REDIS "$DOCKER" compose -p "$COMPOSE_PROJECT" down -v >"$OUT/logs/compose-down.log" 2>&1) || true
}
trap cleanup EXIT

DB="postgres://capstan:capstan@127.0.0.1:$P_PG/capstan"
RD="redis://127.0.0.1:$P_REDIS"
# Every app starts from an empty environment (nothing inherited from this shell) plus what is listed here.
printf '#!/bin/sh\nexec /usr/bin/env -i HOME="%s" PATH="%s:/usr/bin:/bin" "$@"\n' "$OUT" "$(dirname "$BUN")" > "$OUT/clean"; chmod +x "$OUT/clean"
clean() { "$OUT/clean" "$@"; }
VENUES="CAPSTAN_VENUE_URL_HYPERLIQUID=http://127.0.0.1:$P_HL CAPSTAN_VENUE_URL_LIGHTER_RH=http://127.0.0.1:$P_RH CAPSTAN_VENUE_URL_LIGHTER_MAINNET=http://127.0.0.1:$P_LM CAPSTAN_VENUE_URL_ASTER=http://127.0.0.1:$P_DEAD CAPSTAN_VENUE_URL_ARCUS=http://127.0.0.1:$P_DEAD CAPSTAN_VENUE_URL_VARIATIONAL=http://127.0.0.1:$P_DEAD"
start() { # name port cmd...
  name="$1"; port="$2"; shift 2
  (cd "$root" && exec nohup "$@" >"$OUT/logs/$name.log" 2>&1 </dev/null) &
  PIDS+=("$!")
  i=0; while ! listening "$port"; do i=$((i+1)); [ "$i" -gt 150 ] && { echo "fail: $name did not listen on $port"; tail -20 "$OUT/logs/$name.log"; exit 1; }; sleep 0.2; done
  echo "up: $name on $port"
}

# 1. stack
(cd "$root" && CAPSTAN_PG_PORT=$P_PG CAPSTAN_REDIS_PORT=$P_REDIS "$DOCKER" compose -p "$COMPOSE_PROJECT" up -d --wait >"$OUT/logs/compose.log" 2>&1) || { echo "fail: docker compose"; tail -5 "$OUT/logs/compose.log"; exit 1; }
echo "up: compose $COMPOSE_PROJECT (Postgres $P_PG, Redis $P_REDIS)"
(cd "$root" && clean DATABASE_URL="$DB" "$BUN" packages/core/src/migrate.ts >"$OUT/logs/migrate.log" 2>&1) || { echo "fail: migrations"; tail -5 "$OUT/logs/migrate.log"; exit 1; }
# loopback and TEST-NET-1 count as DE (writes allowed); TEST-NET-3 is US (refused)
printf '127.0.0.0,127.255.255.255,DE\n192.0.2.0,192.0.2.255,DE\n203.0.113.0,203.0.113.255,US\n::1,::1,DE\n' | gzip -c > "$OUT/geo/dbip-country-lite.csv.gz"
start venues "$P_HL" "$OUT/clean" "$BUN" ops/fork/fake-venues.ts --hl "$P_HL" --lighter-rh "$P_RH" --lighter "$P_LM"
(cd "$root" && clean DATABASE_URL="$DB" REDIS_URL="$RD" $VENUES "$BUN" ops/fork/seed-catalog.ts >"$OUT/logs/seed.log" 2>&1) || { echo "fail: seed"; tail -10 "$OUT/logs/seed.log"; exit 1; }
tail -1 "$OUT/logs/seed.log"
# the hosted api env (ops/server/etc/api.env) with local hosts; no receipt signer, no x402, no web origins
start api "$P_API" "$OUT/clean" CAPSTAN_NETWORK=testnet PUBLIC_API_HOST="$PUBLIC_HOST" API_PORT="$P_API" DATABASE_URL="$DB" REDIS_URL="$RD" \
  CAPSTAN_EGRESS_ID=proof CAPSTAN_TRUST_FORWARDED_FOR=1 CAPSTAN_GEO_DIR="$OUT/geo" X402_ENABLED=0 CAPSTAN_WEB_ORIGINS= RECEIPT_SIGNERS= \
  $VENUES "$BUN" apps/api/src/index.ts
# the hosted MCP env (ops/server/etc/mcp.env): keyless, X402 off, the public host plus loopback in MCP_ALLOWED_HOSTS
MCP_ENV="CAPSTAN_NETWORK=testnet PUBLIC_API_HOST=$PUBLIC_HOST API_BASE_URL=http://127.0.0.1:$P_API/v1 X402_ENABLED=0 DATABASE_URL=$DB"
start mcp "$P_MCP" "$OUT/clean" $MCP_ENV MCP_PORT="$P_MCP" MCP_ALLOWED_HOSTS="$PUBLIC_HOST,127.0.0.1:$P_MCP,localhost:$P_MCP" "$BUN" apps/mcp/src/index.ts
start mcp-ratelimit "$P_MCPRL" "$OUT/clean" $MCP_ENV MCP_PORT="$P_MCPRL" MCP_RATE_LIMIT_PER_MIN=5 MCP_ALLOWED_HOSTS="$PUBLIC_HOST,127.0.0.1:$P_MCPRL" "$BUN" apps/mcp/src/index.ts

# 2. the outside folder: plain npm + Node, no Bun anywhere on PATH
W="$OUT/work"
mkdir -p "$W/bin" "$W/tarballs"
for t in node npm npx; do ln -sf "$NODEDIR/$t" "$W/bin/$t"; done
outside() { /usr/bin/env -i HOME="$W" PATH="$W/bin:/usr/bin:/bin" npm_config_cache="$W/.npm" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false "$@"; }
(cd "$root/ops/release/npm/capstan-sdk" && PATH="$NODEDIR:$(dirname "$BUN"):/usr/bin:/bin" npm pack --pack-destination "$W/tarballs" >"$OUT/logs/pack-sdk.log" 2>&1) || { echo "fail: npm pack capstan-sdk"; tail -10 "$OUT/logs/pack-sdk.log"; exit 1; }
(cd "$root/ops/release/npm/capstan-mcp" && PATH="$NODEDIR:/usr/bin:/bin" npm pack --pack-destination "$W/tarballs" >"$OUT/logs/pack-mcp.log" 2>&1) || { echo "fail: npm pack capstan-mcp"; tail -10 "$OUT/logs/pack-mcp.log"; exit 1; }
SDK_TGZ="$(ls "$W"/tarballs/capstan-sdk-*.tgz)"; MCP_TGZ="$(ls "$W"/tarballs/capstan-mcp-*.tgz)"
echo "packed: $(basename "$SDK_TGZ") $(wc -c <"$SDK_TGZ" | tr -d ' ') bytes, $(basename "$MCP_TGZ") $(wc -c <"$MCP_TGZ" | tr -d ' ') bytes"
printf '{ "name": "capstan-outside-proof", "private": true, "type": "module" }\n' > "$W/package.json"
cp "$here/outside-client.mjs" "$here/sdk-quote.mjs" "$here/stdio-list.mjs" "$here/keyscan.mjs" "$W/"
MCP_SDK_VERSION=$(sed -n 's/.*"@modelcontextprotocol\/sdk": "\([0-9.]*\)".*/\1/p' "$root/apps/mcp/package.json")
(cd "$W" && outside npm install "@modelcontextprotocol/sdk@$MCP_SDK_VERSION" "$SDK_TGZ" "$MCP_TGZ" >"$OUT/logs/npm-install.log" 2>&1) || { echo "fail: npm install"; tail -10 "$OUT/logs/npm-install.log"; exit 1; }
echo "installed: @modelcontextprotocol/sdk@$MCP_SDK_VERSION, capstan-sdk, capstan-mcp with $(outside npm --version | tr -d '\n') on Node $(outside node --version)"
if outside sh -c 'command -v bun' >/dev/null 2>&1; then echo "fail: bun is on the outside PATH"; exit 1; fi

fail=0
run() { # label cmd...
  label="$1"; shift
  if (cd "$W" && outside "$@" >"$OUT/logs/$label.log" 2>&1); then echo "PASS $label: $(tail -1 "$OUT/logs/$label.log")"; else echo "FAIL $label (log: $OUT/logs/$label.log)"; tail -15 "$OUT/logs/$label.log"; fail=1; fi
}
run outside-client env MCP_URL="http://127.0.0.1:$P_MCP/mcp" MCP_RL_URL="http://127.0.0.1:$P_MCPRL/mcp" PUBLIC_HOST="$PUBLIC_HOST" API_BASE="http://127.0.0.1:$P_API/v1" OUT_JSON="$OUT/outside-client.json" node outside-client.mjs
run sdk-quote env API_BASE="http://127.0.0.1:$P_API/v1" HL_URL="http://127.0.0.1:$P_HL" OUT_JSON="$OUT/sdk-quote.json" node sdk-quote.mjs
run stdio-list env CAPSTAN_MCP_URL="http://127.0.0.1:$P_MCP/mcp" OUT_JSON="$OUT/stdio-list.json" node stdio-list.mjs
# the apps' own logs carry no key-like value either
run app-logs node keyscan.mjs "$OUT/logs/api.log" "$OUT/logs/mcp.log" "$OUT/logs/mcp-ratelimit.log"

echo "output: $OUT"
[ "$fail" = 0 ] && echo "mcp-proof: PASS" || { echo "mcp-proof: FAIL"; exit 1; }
