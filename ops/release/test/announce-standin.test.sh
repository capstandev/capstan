#!/bin/bash
# The release announcer (bin/announce-telegram.sh, real curl) against the local stand-in Bot API from the alerts lane
# (ops/alerts/telegram-standin.ts): poster present, poster missing, long caption, 429 retry, a failing upload, a
# partial post resumed, a release not marked announced until its post went out, dry run, and an unarmed runner that
# sends nothing. Every URL is 127.0.0.1; the bot token is a stand-in value. Port ANNOUNCE_STANDIN_PORT (25021).
. "$(dirname "$0")/lib.sh"
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
PORT="${ANNOUNCE_STANDIN_PORT:-25021}"
STANDIN="$T_ROOT/../alerts/telegram-standin.ts"
TOKEN="123456789:StandinOnlyTokenNotRealBBBBBBBB"

# standin [script]: start the stand-in for this test (killed with its sandbox); every call goes to $REC
standin() {
  [ -x "$BUN" ] || fail "bun not found (the stand-in needs it)"
  REC="$T/calls.jsonl"; : > "$REC"
  "$BUN" "$STANDIN" --port "$PORT" --record "$REC" --script "${1:-}" > "$T/standin.log" 2>&1 &
  SPID=$!
  trap 'kill "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null; case "$T" in */rr-test.*) rm -rf "$T" ;; esac' EXIT
  local i=0
  while [ "$i" -lt 100 ]; do grep -q listening "$T/standin.log" 2>/dev/null && break; sleep 0.1; i=$((i + 1)); done
  grep -q listening "$T/standin.log" || fail "stand-in did not start on $PORT: $(cat "$T/standin.log")"
  printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=-1009876543210\n' "$TOKEN" > "$T/tg.env"; chmod 600 "$T/tg.env"
  cat >> "$T/release.conf" <<EOF
ANNOUNCE_CMD=$BIN/announce-telegram.sh
TELEGRAM_ENV=$T/tg.env
TELEGRAM_API=http://127.0.0.1:$PORT
CURL=$(command -v curl)
ANNOUNCE_TRIES=2
ANNOUNCE_BACKOFF_S=0
EOF
}
poster() { mkdir -p "$T/home/posters"; head -c "${2:-2048}" /dev/zero > "$T/home/posters/$1.png"; }
notes_for() { mkdir -p "$T/home/notes"; cat > "$T/home/notes/$1.txt"; }
# one line per call: method status text-length photo-size
calls() { REC="$REC" "$BUN" -e 'const t=require("fs").readFileSync(process.env.REC,"utf8").trim(); if (t) for (const l of t.split("\n")) { const c=JSON.parse(l); console.log([c.method, c.status, c.text.length, c.photo ?? "-"].join(" ")) }'; }
count() { calls | grep -c "$1" || true; }
texts() { REC="$REC" "$BUN" -e 'const t=require("fs").readFileSync(process.env.REC,"utf8").trim(); if (t) for (const l of t.split("\n")) { const c=JSON.parse(l); if (c.status===200) console.log(c.text) }'; }
ann() { awk -F '\t' -v n="$1" '$1==n { s=$2 } END { print s }' "$T/home/announce.tsv"; }
announce() { "$BIN/announce-telegram.sh" "$@"; }

t_poster_present_posts_photo_with_notes() {
  sandbox; standin; poster update-01 4096
  printf 'Faster quotes on every venue.\nNothing changes for users.' | notes_for update-01
  pass_at "$LAUNCH"
  assert_eq "$(st 1)" released; assert_eq "$(ann 1)" announced "marked announced after the post"
  assert_eq "$(count '^sendPhoto 200 .* 4096$')" 1 "one sendPhoto with the 4096-byte poster"
  assert_eq "$(count '^sendMessage')" 0 "short notes fit in the caption"
  assert_contains "$(texts)" "Update 1 is live: update number 1"; assert_contains "$(texts)" "Faster quotes on every venue."
  assert_contains "$(cat "$T/home/journal.log")" " announced"
  pass_at $((LAUNCH + 60)); assert_eq "$(count sendPhoto)" 1 "a later pass never posts it again"
}

t_poster_missing_posts_text_with_a_clear_line() {
  sandbox; standin
  pass_at "$LAUNCH"
  assert_eq "$(ann 1)" announced; assert_eq "$(count sendPhoto)" 0 "no photo without a poster"
  assert_eq "$(count '^sendMessage 200')" 1
  assert_contains "$(texts)" "Update 1 is live: update number 1"
  assert_contains "$(texts)" "Poster missing: no poster was staged for update-01. This post is text only."
}

t_long_caption_overflows_into_messages() {
  sandbox; standin; poster update-01
  i=1; while [ "$i" -le 120 ]; do printf 'Line %03d of the release notes, plain words only.\n' "$i"; i=$((i + 1)); done | notes_for update-01
  pass_at "$LAUNCH"; assert_eq "$(ann 1)" announced
  cap=$(calls | awk '$1=="sendPhoto" && $2==200 { print $3 }')
  [ "$cap" -le 1024 ] || fail "caption is $cap chars"; [ "$cap" -gt 900 ] || fail "caption only $cap chars (cut too early)"
  assert_eq "$(count '^sendMessage 200')" 2 "6 KB of notes: caption plus two messages"
  calls | awk '$1=="sendMessage" && $3 > 4096 { exit 1 }' || fail "a message is over 4096 chars"
  i=1; while [ "$i" -le 120 ]; do
    n=$(texts | grep -c "^Line $(printf '%03d' "$i") of" || true); assert_eq "$n" 1 "line $i posted exactly once"; i=$((i + 1))
  done
}

t_429_is_retried_after_retry_after() {
  sandbox; standin "429:1"; poster update-01
  start=$(date +%s); pass_at "$LAUNCH"; took=$(( $(date +%s) - start ))
  assert_eq "$(ann 1)" announced
  assert_eq "$(count '^sendPhoto 429')" 1; assert_eq "$(count '^sendPhoto 200')" 1 "delivered once after the 429"
  assert_contains "$(cat "$T/home/log/runner.log")" "update-01 poster answer 429 (try 1 of 2); waiting 1 s"
  [ "$took" -ge 1 ] || fail "did not wait retry_after"
}

t_failed_upload_falls_back_to_text_only() {
  sandbox; standin "500,500"; poster update-01
  pass_at "$LAUNCH"; assert_eq "$(ann 1)" announced
  assert_eq "$(count '^sendPhoto 500')" 2 "two tries with backoff"; assert_eq "$(count '^sendPhoto 200')" 0
  assert_contains "$(texts)" "Poster missing: the poster upload failed (answer 500). This post is text only."
  assert_contains "$(cat "$T/home/log/runner.log")" "falling back to text only"
}

t_not_marked_announced_until_the_post_went_out() {
  sandbox; standin "500,500,500,500"; poster update-01
  pass_at "$LAUNCH"
  assert_eq "$(st 1)" released "the update itself is live"; assert_eq "$(ann 1)" owed "post failed: owed, not announced"
  assert_not_contains "$(cat "$T/home/journal.log")" " announced"
  assert_eq "$(count ' 200 ')" 0 "nothing reached the group"
  pass_at $((LAUNCH + 60)); assert_eq "$(ann 1)" announced "retried next pass"
  assert_eq "$(count '^sendPhoto 200')" 1; assert_eq "$(st 2)" pending "the retry did not release update 2 early"
}

t_partial_post_resumes_without_duplicates() {
  sandbox; standin "200,500,500"; poster update-01
  i=1; while [ "$i" -le 60 ]; do printf 'Line %03d of the notes.\n' "$i"; i=$((i + 1)); done | notes_for update-01
  : > "$T/flag"
  rc=0; announce update-01 "Update 1 is live: x" < "$T/home/notes/update-01.txt" > /dev/null 2>&1 || rc=$?
  assert_eq "$rc" 1 "a follow-up failed"; assert_no_file "$T/home/announce/update-01.done"
  rc=0; announce update-01 "Update 1 is live: x" < /dev/null > /dev/null || rc=$?
  assert_eq "$rc" 0; assert_file "$T/home/announce/update-01.done"
  assert_eq "$(count '^sendPhoto 200')" 1 "the poster went out once"; assert_eq "$(count '^sendMessage 200')" 1
  assert_contains "$(texts)" "Line 060 of the notes."
  assert_eq "$(announce update-01 "Update 1 is live: x" < /dev/null)" "announce: update-01 already posted"
}

t_dry_run_sends_nothing() {
  sandbox; standin; poster update-01
  i=1; while [ "$i" -le 60 ]; do printf 'Line %03d of the notes.\n' "$i"; i=$((i + 1)); done | notes_for update-01
  printf 'ANNOUNCE_DRY_RUN=1\n' >> "$T/release.conf"
  pass_at "$LAUNCH"; sleep 0.2
  assert_eq "$(lines "$REC")" 0 "dry run reached the stand-in"; assert_eq "$(ann 1)" dry_run
  assert_file "$T/home/announce/update-01.dry/caption.txt"; assert_file "$T/home/announce/update-01.dry/message-1.txt"
  assert_contains "$(cat "$T/home/log/runner.log")" "dry run: update-01: sendPhoto posters/update-01.png (2048 bytes)"
  out=$(announce --dry-run update-02 "Update 2 is live: y" < /dev/null)
  assert_contains "$out" "poster missing (no poster was staged for update-02), text only, then 1 sendMessage"
  assert_contains "$out" "token set; nothing sent"; assert_eq "$(lines "$REC")" 0
}

t_armed_off_sends_nothing() {
  sandbox; standin; poster update-01
  rm -f "$T/flag"; pass_at "$LAUNCH"
  : > "$T/flag"; CAPSTAN_RELEASE_RUNNER=0 pass_at "$LAUNCH"
  rm -f "$T/flag"; rc=0; announce update-01 "Update 1 is live: x" < /dev/null 2> /dev/null || rc=$?
  assert_eq "$rc" 4 "the announcer refuses without the flag file"
  sleep 0.2; assert_eq "$(lines "$REC")" 0 "an unarmed runner sent something"; assert_no_file "$T/prod"
}

t_token_never_in_a_log_or_record() {
  sandbox; standin "429:1"; poster update-01
  printf 'invite code ZX-9917' | notes_for update-01
  pass_at "$LAUNCH"
  assert_not_contains "$(cat "$REC" "$T/home/log/runner.log")" "StandinOnlyTokenNotReal" "token leaked"
  assert_not_contains "$(cat "$T/home/log/runner.log")" "ZX-9917" "message text in the runner log"
}

run_tests "$0"
