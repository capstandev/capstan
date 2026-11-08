#!/bin/bash
# The whole Capstan stack on a local anvil fork of Robinhood Chain mainnet (4663) plus a Base (8453) fork, for the
# every-transaction run (ops/fork/every-tx.ts), the browser pass and an owner click-through. Nothing here sends to a
# real chain: anvil forks through ops/fork/rpc-cache.ts, which refuses every write, and the apps get loopback RPCs only.
# Usage: /bin/bash ops/fork/up.sh            start everything (skips what is already running)
#        /bin/bash ops/fork/up.sh apps       (re)start the six apps and the web (after every-tx.ts deploys contracts)
#        /bin/bash ops/fork/up.sh web        restart the web dev server only (after every-tx.ts writes the fork pins)
#        /bin/bash ops/fork/up.sh status     one line per process
# Default ports (lane e2e-launch; FORK_P_* moves them): api 22410, ws 22411, relay 22412, mcp 22413, facilitator 22414, fake HL 22420, fake
# Lighter-RH 22421, fake Lighter 22422, Postgres 22432, RHC fork RPC 22445 (fee-shim, anvil itself on 22449),
# rpc-cache RHC 22446, Base fork RPC 22447 (fee-shim, anvil on 22450), rpc-cache Base 22448, web 22473, Redis 22479. PIDs go to ops/fork/.pids (down.sh stops only those).
# macOS bash 3.2 safe. Keys: fresh throwaway keystores under ops/fork/.state/keys (random password files, chmod 600),
# never anvil's default accounts (EIP-7702 sweepers sit on them on 4663).
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
root="$(cd "$here/../.." && pwd -P)"
cmd="${1:-all}"
ANVIL="$HOME/.foundry/bin/anvil"
CAST="$HOME/.foundry/bin/cast"
BUN="$HOME/.bun/bin/bun"
[ -x "$BUN" ] || BUN="/opt/homebrew/bin/bun"
DOCKER="/opt/homebrew/bin/docker"
[ -x "$DOCKER" ] || DOCKER="$(command -v docker)"
state="$here/.state"
pids="$here/.pids"
logs="$state/logs"
mkdir -p "$state" "$logs" "$state/keys" "$state/armed" "$state/geo"
chmod 700 "$state/keys"
touch "$pids"
COMPOSE_PROJECT="${FORK_COMPOSE_PROJECT:-capstan-e2e-launch}"
RHC_UPSTREAM="${RHC_UPSTREAM:-https://rpc.mainnet.chain.robinhood.com}"
BASE_UPSTREAM="${BASE_UPSTREAM:-https://mainnet.base.org}"
# Every port and the compose project can be moved with FORK_P_<NAME> / FORK_COMPOSE_PROJECT, so a second lane runs its
# own stack beside this one (the defaults are lane e2e-launch's). ops/fork/lib.ts reads the same variables.
P_API=${FORK_P_API:-22410}; P_WS=${FORK_P_WS:-22411}; P_RELAY=${FORK_P_RELAY:-22412}; P_MCP=${FORK_P_MCP:-22413}; P_FAC=${FORK_P_FAC:-22414}
P_HL=${FORK_P_HL:-22420}; P_RH=${FORK_P_RH:-22421}; P_LM=${FORK_P_LM:-22422}; P_PG=${FORK_P_PG:-22432}; P_ANVIL=${FORK_P_ANVIL:-22445}; P_CACHE=${FORK_P_CACHE:-22446}; P_BASE=${FORK_P_BASE:-22447}; P_BCACHE=${FORK_P_BCACHE:-22448}
P_ANVIL_IN=${FORK_P_ANVIL_IN:-22449}; P_BASE_IN=${FORK_P_BASE_IN:-22450} # anvil itself; P_ANVIL and P_BASE are fee-shim front doors with the real chains' tips
P_WEB=${FORK_P_WEB:-22473}; P_REDIS=${FORK_P_REDIS:-22479}

listening() { /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
pid_of() { awk -v n="$1" '$1==n {p=$2} END {print p}' "$pids"; }
record() { grep -v "^$1 " "$pids" > "$pids.tmp" || true; mv "$pids.tmp" "$pids"; echo "$1 $2 $3" >> "$pids"; } # name pid port
wait_port() { # port name seconds
  i=0; while ! listening "$1"; do i=$((i+1)); if [ "$i" -gt "$(( $3 * 4 ))" ]; then echo "fail: $2 did not listen on $1 (log: $logs/$2.log)"; tail -20 "$logs/$2.log" || true; exit 1; fi; sleep 0.25; done
}
start() { # name port command...
  name="$1"; port="$2"; shift 2
  p="$(pid_of "$name")"
  if alive "$p" && listening "$port"; then echo "skip: $name already running (pid $p, port $port)"; return 0; fi
  if listening "$port"; then echo "refuse: port $port is taken by a process this script did not start ($name)"; exit 1; fi
  nohup "$@" >"$logs/$name.log" 2>&1 </dev/null &
  record "$name" "$!" "$port"
  wait_port "$port" "$name" 90
  echo "up: $name pid $! port $port"
}

keys() {
  for who in poster receipt facilitator; do
    if [ ! -f "$state/keys/$who" ]; then
      openssl rand -hex 32 > "$state/keys/$who.password"
      chmod 600 "$state/keys/$who.password"
      "$CAST" wallet new "$state/keys" "$who" --unsafe-password "$(cat "$state/keys/$who.password")" >/dev/null 2>&1
      "$CAST" wallet address --keystore "$state/keys/$who" --password-file "$state/keys/$who.password" > "$state/keys/$who.addr"
    fi
  done
  # arming files: the fork is a mainnet chain id, so the anchor and settle paths need their armed pair (fork only)
  echo "fork only: $(date -u +%FT%TZ)" > "$state/armed/anchor"
  echo "fork only: $(date -u +%FT%TZ)" > "$state/armed/x402"
}

geo() {
  # A fork-only DB-IP style country file: loopback counts as DE so a local browser can write; TEST-NET-1 is DE and
  # TEST-NET-3 is US (every-tx S10 forces it with X-Forwarded-For to prove the GEO_REFUSED path).
  if [ ! -f "$state/geo/dbip-country-lite.csv.gz" ]; then
    printf '127.0.0.0,127.255.255.255,DE\n192.0.2.0,192.0.2.255,DE\n203.0.113.0,203.0.113.255,US\n::1,::1,DE\n' | gzip -c > "$state/geo/dbip-country-lite.csv.gz"
  fi
}

write_env() {
  dep_env="$state/deploy.env"; [ -f "$dep_env" ] || : > "$dep_env"
  # a deployment record from an earlier fork (or an archived one) is not this fork's: start without contracts
  f="$(grep '^CAPSTAN_FORK_DEPLOYMENTS=' "$dep_env" | cut -d= -f2 || true)"
  if [ -n "$f" ] && [ ! -f "$f" ]; then : > "$dep_env"; echo "note: deployment record $f is gone; apps start without contracts until every-tx.ts S1"; fi
  # every value here is loopback or a fork-only file; rpc-cache refuses writes upstream
  cat > "$state/stack.env" <<ENV
CAPSTAN_NETWORK=mainnet
CAPSTAN_FORK=1
LOG_LEVEL=info
PUBLIC_API_HOST=127.0.0.1:$P_API
DATABASE_URL=postgres://capstan:capstan@127.0.0.1:$P_PG/capstan
REDIS_URL=redis://127.0.0.1:$P_REDIS
API_PORT=$P_API
WS_PORT=$P_WS
RELAY_PORT=$P_RELAY
MCP_PORT=$P_MCP
FACILITATOR_PORT=$P_FAC
API_BASE_URL=http://127.0.0.1:$P_API/v1
FACILITATOR_URL=http://127.0.0.1:$P_FAC
CAPSTAN_WEB_ORIGINS=http://127.0.0.1:$P_WEB,http://localhost:$P_WEB
CAPSTAN_GEO_DIR=$state/geo
CAPSTAN_TRUST_FORWARDED_FOR=1
RHC_RPC_URL=http://127.0.0.1:$P_ANVIL
BASE_RPC_URL=http://127.0.0.1:$P_BASE
ANCHOR_RPC_URL=http://127.0.0.1:$P_ANVIL
CAPSTAN_VENUE_URL_HYPERLIQUID=http://127.0.0.1:$P_HL
CAPSTAN_VENUE_URL_LIGHTER_RH=http://127.0.0.1:$P_RH
CAPSTAN_VENUE_URL_LIGHTER_MAINNET=http://127.0.0.1:$P_LM
RELAY_SUBMIT_ARMED=1
RELAY_EGRESS_ID=fork
RECEIPT_SIGNER=none
RECEIPT_CHAIN_ID=4663
ANCHOR_SIGNER=keystore
ANCHOR_KEYSTORE_PATH=$state/keys/poster
ANCHOR_KEYSTORE_PASSWORD_FILE=$state/keys/poster.password
ANCHOR_CHAIN_ID=4663
ANCHOR_ARMED=1
ANCHOR_ARMED_FILE=$state/armed/anchor
FACILITATOR_SIGNER=keystore
FACILITATOR_KEYSTORE_PATH=$state/keys/facilitator
FACILITATOR_KEYSTORE_PASSWORD_FILE=$state/keys/facilitator.password
FACILITATOR_CHAIN_ID=4663
X402_SETTLE_ARMED=1
X402_SETTLE_ARMED_FILE=$state/armed/x402
X402_ENABLED=1
X402_USDG_EIP3009_MAINNET=1
X402_PAYTO_EVM=$(cat "$state/keys/payto.addr" 2>/dev/null || echo 0x000000000000000000000000000000000000dEaD)
X402_PAY_TO_EVM=$(cat "$state/keys/payto.addr" 2>/dev/null || echo 0x000000000000000000000000000000000000dEaD)
X402_PAY_TO_SOL=So1PayTo1111111111111111111111111111111111
CAPSTAN_INTERNAL_TOKEN=$(cat "$state/keys/internal.token")
RECEIPT_SIGNERS=$(cat "$state/keys/receipt.addr")
HL_EXECUTION=1
HL_BUILDER_ADDRESS=$(cat "$state/keys/builder.addr")
OTLP_FILE=
PROM_PORT=
ENV
}

payto() {
  # a fresh pay-to address (no key needed: it only receives on the fork); an internal token between api and mcp
  # owner-test: the account an owner imports into a browser wallet for a click-through (JSON keystore + password file)
  for who in payto builder owner-test; do
    if [ ! -f "$state/keys/$who.addr" ]; then
      openssl rand -hex 32 > "$state/keys/$who.password"; chmod 600 "$state/keys/$who.password"
      "$CAST" wallet new "$state/keys" "$who" --unsafe-password "$(cat "$state/keys/$who.password")" >/dev/null 2>&1
      "$CAST" wallet address --keystore "$state/keys/$who" --password-file "$state/keys/$who.password" > "$state/keys/$who.addr"
    fi
  done
  [ -f "$state/keys/internal.token" ] || { openssl rand -hex 24 > "$state/keys/internal.token"; chmod 600 "$state/keys/internal.token"; }
}

# Every app runs through this wrapper: a clean environment (nothing inherited from the caller's shell, so no stray
# real RPC URL can leak in) plus the stack env and the deployment env written by every-tx.ts.
cat > "$state/envrun.sh" <<'WRAP'
#!/bin/bash
d="$(cd "$(dirname "$0")" && pwd -P)"
exec /usr/bin/env -i HOME="$HOME" PATH="$HOME/.foundry/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" /bin/bash -c 'set -a; . "$0/stack.env"; [ -f "$0/deploy.env" ] && . "$0/deploy.env"; set +a; exec "$@"' "$d" "$@"
WRAP
chmod +x "$state/envrun.sh"
envrun() { "$state/envrun.sh" "$@"; }
ENVRUN="$state/envrun.sh"

stop_one() { # name
  p="$(pid_of "$1")"
  if alive "$p"; then kill "$p" 2>/dev/null || true; i=0; while alive "$p" && [ "$i" -lt 40 ]; do sleep 0.1; i=$((i+1)); done; alive "$p" && kill -9 "$p" 2>/dev/null || true; fi
}

chain() {
  start rpc-cache "$P_CACHE" "$BUN" "$here/rpc-cache.ts" --port "$P_CACHE" --upstream "$RHC_UPSTREAM"
  start rpc-cache-base "$P_BCACHE" "$BUN" "$here/rpc-cache.ts" --port "$P_BCACHE" --upstream "$BASE_UPSTREAM"
  # gas like the real chains (chain-facts: RHC 0.0223 gwei, Base 0.006 gwei, priority 0): anvil's default 1 gwei
  # minimum tip would make every x402 settle look 50x too dear and the gate drop every rail (REL-3 economics)
  # a new fork has none of the earlier fork's contracts
  if ! listening "$P_ANVIL_IN"; then : > "$state/deploy.env"; fi
  start anvil "$P_ANVIL_IN" "$ANVIL" --fork-url "http://127.0.0.1:$P_CACHE" --port "$P_ANVIL_IN" --chain-id 4663 --hardfork cancun --no-storage-caching --host 127.0.0.1 --disable-min-priority-fee --block-base-fee-per-gas 22324000
  start anvil-base "$P_BASE_IN" "$ANVIL" --fork-url "http://127.0.0.1:$P_BCACHE" --port "$P_BASE_IN" --chain-id 8453 --hardfork cancun --no-storage-caching --host 127.0.0.1 --disable-min-priority-fee --block-base-fee-per-gas 6000000
  start fee-shim "$P_ANVIL" "$BUN" "$here/fee-shim.ts" --port "$P_ANVIL" --target "http://127.0.0.1:$P_ANVIL_IN" --tip 0
  start fee-shim-base "$P_BASE" "$BUN" "$here/fee-shim.ts" --port "$P_BASE" --target "http://127.0.0.1:$P_BASE_IN" --tip 1000000
  got="$("$CAST" chain-id --rpc-url "http://127.0.0.1:$P_ANVIL")"; [ "$got" = "4663" ] || { echo "fail: anvil chain id $got"; exit 1; }
  got="$("$CAST" chain-id --rpc-url "http://127.0.0.1:$P_BASE")"; [ "$got" = "8453" ] || { echo "fail: base anvil chain id $got"; exit 1; }
  echo "fork: RHC block $("$CAST" block-number --rpc-url "http://127.0.0.1:$P_ANVIL"), Base block $("$CAST" block-number --rpc-url "http://127.0.0.1:$P_BASE")" | tee "$state/fork-blocks.txt"
}

db() {
  (cd "$root" && CAPSTAN_PG_PORT=$P_PG CAPSTAN_REDIS_PORT=$P_REDIS "$DOCKER" compose -p "$COMPOSE_PROJECT" up -d --wait >"$logs/compose.log" 2>&1) || { echo "fail: docker compose (log: $logs/compose.log)"; tail -5 "$logs/compose.log"; exit 1; }
  echo "up: docker compose project $COMPOSE_PROJECT (Postgres $P_PG, Redis $P_REDIS)"
  (cd "$root" && DATABASE_URL="postgres://capstan:capstan@127.0.0.1:$P_PG/capstan" "$BUN" packages/core/src/migrate.ts >"$logs/migrate.log" 2>&1) || { echo "fail: migrations (log: $logs/migrate.log)"; tail -5 "$logs/migrate.log"; exit 1; }
  echo "up: migrations applied"
}

apps() {
  for n in web workers facilitator mcp relay ws api; do stop_one "$n"; done
  write_env
  cd "$root"
  start api "$P_API" "$ENVRUN" "$BUN" apps/api/src/index.ts
  start ws "$P_WS" "$ENVRUN" "$BUN" apps/ws/src/index.ts
  start relay "$P_RELAY" "$ENVRUN" "$BUN" apps/relay/src/index.ts
  start mcp "$P_MCP" "$ENVRUN" "$BUN" apps/mcp/src/index.ts
  start facilitator "$P_FAC" "$ENVRUN" "$BUN" apps/facilitator/src/index.ts
  # workers: receipts (the relay holds no key), the RootPosted indexer and the USDG detection; merkle-anchor is run
  # by every-tx.ts with the hour closed on the fork clock (S3), so it is not scheduled here. FORK_EXTRA_JOBS adds read
  # jobs (the site pass uses ingest-hl, so funding and marks come from the Hyperliquid stand-in)
  nohup "$ENVRUN" /usr/bin/env WORKER_JOBS=receipt-sign,receipt-sign-refusal,root-indexer,x402-detect${FORK_EXTRA_JOBS:+,$FORK_EXTRA_JOBS} RECEIPT_SIGNER=keystore \
    RECEIPT_KEYSTORE_PATH="$state/keys/receipt" RECEIPT_KEYSTORE_PASSWORD_FILE="$state/keys/receipt.password" \
    "$BUN" apps/workers/src/index.ts >"$logs/workers.log" 2>&1 </dev/null &
  record workers "$!" 0
  sleep 3; alive "$!" || { echo "fail: workers exited (log: $logs/workers.log)"; tail -20 "$logs/workers.log"; exit 1; }
  echo "up: workers pid $!"
  web
}

web() {
  dep="$state/deploy.env"
  anchor="$(grep '^ANCHOR_ADDRESS=' "$dep" | cut -d= -f2 || true)"
  signer="$(cat "$state/keys/receipt.addr")"
  # the SDK pins for this fork (builder, onboarding template, receipt signer, anchor), written by every-tx.ts; release
  # pins stay empty until launch, so without these the dashboard refuses to onboard (fail closed)
  pins=""; [ -f "$state/web-pins.json" ] && pins="$(cat "$state/web-pins.json")"
  # the generated OpenAPI and MCP tool files the docs pages import (what `bun run dev` does first)
  (cd "$root/web" && "$BUN" scripts/sync-openapi.ts >"$logs/web-sync.log" 2>&1) || { echo "fail: web sync-openapi (log: $logs/web-sync.log)"; exit 1; }
  # the build's VITE_* variables, as positional parameters (macOS bash 3.2 has no arrays worth trusting here)
  set -- VITE_PROFILE=fork VITE_NETWORK=mainnet VITE_API_BASE="http://127.0.0.1:$P_API/v1" VITE_RPC_URL="http://127.0.0.1:$P_ANVIL" \
    VITE_TOKEN_CHAIN_ID=4663 VITE_RECEIPT_SIGNERS="[\"$signer\"]" VITE_VENUE_HOSTS="{\"hyperliquid\":\"http://127.0.0.1:$P_HL\"}" \
    ${anchor:+VITE_ANCHOR=$anchor} ${anchor:+VITE_ANCHOR_CHAIN_ID=4663} VITE_PINS="$pins"
  if [ "${FORK_WEB:-dev}" = "dist" ]; then
    # the built site (hashed names, clean URLs) served the way the static host serves it: web/scripts/serve-dist.ts
    (cd "$root/web" && /usr/bin/env "$@" "$root/web/node_modules/.bin/vite" build --outDir "$state/web-dist" --emptyOutDir >"$logs/web-build.log" 2>&1 \
      && "$BUN" scripts/hash-public.ts "$state/web-dist" >>"$logs/web-build.log" 2>&1) || { echo "fail: web build (log: $logs/web-build.log)"; tail -5 "$logs/web-build.log"; exit 1; }
    (cd "$root/web" && exec "$BUN" scripts/serve-dist.ts --dir "$state/web-dist" --port "$P_WEB") >"$logs/web.log" 2>&1 </dev/null &
  else
    (cd "$root/web" && exec /usr/bin/env "$@" "$root/web/node_modules/.bin/vite" --host 127.0.0.1 --port "$P_WEB" --strictPort) >"$logs/web.log" 2>&1 </dev/null &
  fi
  record web "$!" "$P_WEB"
  wait_port "$P_WEB" web 120
  echo "up: web http://127.0.0.1:$P_WEB (fork profile, ${FORK_WEB:-dev})"
}

status() {
  while read -r n p port; do
    [ -n "$n" ] || continue
    if alive "$p"; then echo "running: $n pid $p port $port"; else echo "stopped: $n (pid $p)"; fi
  done < "$pids"
}

case "$cmd" in
  all)
    keys; payto; geo
    chain
    db
    start fake-venues "$P_HL" "$BUN" "$here/fake-venues.ts" --hl "$P_HL" --lighter-rh "$P_RH" --lighter "$P_LM"
    apps
    echo "ready: api http://127.0.0.1:$P_API/v1, web http://127.0.0.1:$P_WEB, RPC http://127.0.0.1:$P_ANVIL (chain 4663)"
    ;;
  apps) payto; apps ;;
  web) stop_one web; web ;;
  status) status ;;
  *) echo "usage: up.sh [all|apps|status]"; exit 2 ;;
esac
