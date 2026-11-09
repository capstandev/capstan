#!/bin/bash
# Prove the Telegram alerts end to end against the local stand-in Bot API (ops/alerts/telegram-standin.ts).
#   1. Worker ops alerts, twice: without Redis, then through a real Redis (the durable list and the Redis dedupe).
#      Every glossary cause once, dedupe, long text split, 429 retry_after, failure isolation, nothing when unarmed.
#   2. Release runner alerts (ops/release/bin/notify-telegram.sh, real curl) to a stand-in process: every release
#      alert title once, the keyed dedupe of rr_notify, the --test proof file, and no sendPhoto.
# ALERTS_ARMED is set only inside the tests. Nothing leaves this machine: every URL is 127.0.0.1.
# Ports (default 24740 to 24749): Redis STANDIN_REDIS_PORT (24741), stand-in in the tests STANDIN_TEST_PORT (24742),
# stand-in process for the release runner STANDIN_RELEASE_PORT (24743). Compose project STANDIN_PROJECT
# (capstan-telegram), started and removed by this script only. NO_DOCKER=1 skips the Redis pass.
# Usage (from backend/): ops/alerts/standin-proof.sh     exit 0 = every check passed
set -u
cd "$(dirname "$0")/../.." || exit 2
ROOT=$(pwd -P)
REDIS_PORT="${STANDIN_REDIS_PORT:-24741}"
TEST_PORT="${STANDIN_TEST_PORT:-24742}"
REL_PORT="${STANDIN_RELEASE_PORT:-24743}"
PROJECT="${STANDIN_PROJECT:-capstan-telegram}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/capstan-tg-proof.XXXXXX")
fails=0
started_compose=0
standin_pid=""

cleanup() {
  [ -n "$standin_pid" ] && kill "$standin_pid" 2>/dev/null
  if [ "$started_compose" = "1" ]; then
    CAPSTAN_PG_PORT=24740 CAPSTAN_REDIS_PORT="$REDIS_PORT" docker compose -p "$PROJECT" down -v >/dev/null 2>&1
  fi
  case "$WORK" in */capstan-tg-proof.*) rm -rf "$WORK" ;; esac
}
trap cleanup EXIT

ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

# ---------- 1. worker ops alerts ----------
if TELEGRAM_STANDIN_PORT="$TEST_PORT" bun test apps/workers/test/telegram-standin.test.ts > "$WORK/test-noredis.log" 2>&1; then
  ok "worker alerts without Redis ($(grep -E '^ *[0-9]+ pass' "$WORK/test-noredis.log" | tr -s ' '))"
else
  bad "worker alerts without Redis"; tail -n 30 "$WORK/test-noredis.log"
fi

if [ "${NO_DOCKER:-0}" != "1" ]; then
  if CAPSTAN_PG_PORT=24740 CAPSTAN_REDIS_PORT="$REDIS_PORT" docker compose -p "$PROJECT" up -d --wait redis > "$WORK/compose.log" 2>&1; then
    started_compose=1
    if REDIS_URL="redis://127.0.0.1:$REDIS_PORT" TELEGRAM_STANDIN_PORT="$TEST_PORT" bun test apps/workers/test/telegram-standin.test.ts > "$WORK/test-redis.log" 2>&1; then
      ok "worker alerts through Redis ($(grep -E '^ *[0-9]+ pass' "$WORK/test-redis.log" | tr -s ' '))"
    else
      bad "worker alerts through Redis"; tail -n 30 "$WORK/test-redis.log"
    fi
  else
    bad "Redis did not start (compose project $PROJECT)"; tail -n 10 "$WORK/compose.log"
  fi
fi

# ---------- 2. release runner alerts ----------
REC="$WORK/release-calls.jsonl"
: > "$REC"
bun ops/alerts/telegram-standin.ts --port "$REL_PORT" --record "$REC" > "$WORK/standin.log" 2>&1 &
standin_pid=$!
for _ in $(seq 1 50); do grep -q listening "$WORK/standin.log" 2>/dev/null && break; sleep 0.1; done
grep -q listening "$WORK/standin.log" || { bad "stand-in process did not start on $REL_PORT"; cat "$WORK/standin.log"; exit 1; }

RH="$WORK/rr-home"
mkdir -p "$RH/log" "$RH/notify"
printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=-1009876543210\n' "123456789:StandinOnlyTokenNotRealAAAAAAAA" > "$WORK/telegram.env"
chmod 600 "$WORK/telegram.env"
cat > "$WORK/release.conf" <<EOF
RR_HOME=$RH
TELEGRAM_ENV=$WORK/telegram.env
TELEGRAM_API=http://127.0.0.1:$REL_PORT
CURL=$(command -v curl)
NOTIFY_CMD=$ROOT/ops/release/bin/notify-telegram.sh
NOTIFY_PROOF=$RH/notify.proof
EOF
export RR_CONF="$WORK/release.conf"

# every release runner alert in the team glossary (marketing/telegram/GLOSSARY.md, release runner table)
titles=(
  "Update 7 is live: Faster quotes"
  "HELD Update 7"
  "Update 7 ROLLED BACK"
  "ROLLBACK FAILED Update 7"
  "queue needs a rebase"
  "paused"
  "resumed"
  "PUBLIC COPY FAILED Update 7"
  "PUBLIC CI RED"
  "public CI green again"
  "GITHUB RELEASES BLOCKED (token permission)"
  "GITHUB RELEASE FAILED update-07"
  "GitHub releases are OFF"
  "PREFLIGHT FAIL"
)
for t in "${titles[@]}"; do
  printf 'Body for %s. Nothing is wrong; this is the stand-in proof.' "$t" | ops/release/bin/notify-telegram.sh "$t" || bad "notify-telegram.sh failed for '$t'"
done
ops/release/bin/notify-telegram.sh --test || bad "notify-telegram.sh --test failed"
[ -f "$RH/notify.proof" ] && ok "--test reached the stand-in and wrote the notify proof" || bad "--test wrote no notify proof"

# rr_notify keyed dedupe: the same key twice inside its interval sends once
(
  # shellcheck disable=SC1091
  . ops/release/lib/common.sh
  rr_init
  RR_NOW=1762600000 rr_notify public-ci 3600 "PUBLIC CI RED (dedupe check)" "first"
  RR_NOW=1762600600 rr_notify public-ci 3600 "PUBLIC CI RED (dedupe check)" "second, 10 min later"
)
sleep 0.3

count() { grep -c "$1" "$REC" 2>/dev/null || true; }
for t in "${titles[@]}"; do
  n=$(grep -F "\"text\":\"$t\\n" "$REC" | grep -c '"method":"sendMessage"')
  [ "$n" = "1" ] && ok "release alert once: $t" || bad "release alert '$t' reached the stand-in $n times"
done
n=$(grep -cF '"text":"PUBLIC CI RED (dedupe check)' "$REC")
[ "$n" = "1" ] && ok "rr_notify dedupe: same key twice in 1 h sent once" || bad "rr_notify dedupe sent $n times"
n=$(count '"method":"sendPhoto"')
[ "$n" = "0" ] && ok "no sendPhoto from any release path" || bad "unexpected sendPhoto calls: $n"
grep -q "StandinOnlyTokenNotReal" "$REC" "$RH/log/runner.log" 2>/dev/null && bad "the token reached a record or a log" || ok "the token is in no record and no log"
total=$(wc -l < "$REC" | tr -d ' ')
printf 'release stand-in calls recorded: %s\n' "$total"

if [ "$fails" -eq 0 ]; then echo "standin-proof: PASS"; exit 0; fi
echo "standin-proof: FAIL ($fails)"
exit 1
