#!/bin/bash
# Secrets never reach a command line or a log; alerts are keyed by cause; the Release wrapper's exit codes.
. "$(dirname "$0")/lib.sh"

fake_curl() { # records argv and stdin; answers with the next code in $T/codes (default 200) and body $T/body
  cat > "$T/fake/curl" <<EOF2
#!/bin/bash
printf '%s\n' "\$*" >> "$T/curl-argv.log"; cat >> "$T/curl-stdin.log"
code=200; if [ -s "$T/codes" ]; then code=\$(head -n 1 "$T/codes"); sed -i.bak 1d "$T/codes"; fi
grep -q 'write-out' "$T/curl-stdin.log" && printf '%s' "\$code"
o=""; prev=""; for a in "\$@"; do [ "\$prev" = "-o" ] && o="\$a"; prev="\$a"; done
[ -n "\$o" ] && [ "\$o" != /dev/null ] && cat "$T/body" > "\$o" 2>/dev/null
case "\$code" in 2*) exit 0 ;; *) [ -f "$T/curl-fail-exit" ] && exit 22; exit 0 ;; esac
EOF2
  chmod +x "$T/fake/curl"; printf 'CURL=%s\n' "$T/fake/curl" >> "$T/release.conf"
  echo '{"id": 42}' > "$T/body"
}

t_token_never_on_argv_or_in_logs() {
  sandbox; fake_curl
  printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=-100123\n' "123456:SECRETvalue" > "$T/tg.env"
  printf 'TELEGRAM_ENV=%s\n' "$T/tg.env" >> "$T/release.conf"
  printf 'invite codes: ABC-123' | "$BIN/notify-telegram.sh" "Invite codes"
  assert_not_contains "$(cat "$T/curl-argv.log")" "SECRETvalue" "token on a command line"
  assert_contains "$(cat "$T/curl-stdin.log")" "bot123456:SECRETvalue/sendMessage"
  assert_not_contains "$(cat "$T/home/log/runner.log" 2>/dev/null)" "ABC-123" "message text in a log"
  touch "$T/curl-fail-exit"; echo 500 > "$T/codes"
  rc=0; printf 'invite codes: ABC-123' | "$BIN/notify-telegram.sh" "Invite codes" || rc=$?
  assert_eq "$rc" 1; assert_not_contains "$(cat "$T/home/log/runner.log")" "ABC-123" "failure log has title and length only"
}

t_notify_test_writes_proof() {
  sandbox; fake_curl
  printf 'TELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_CHAT_ID=1\n' > "$T/tg.env"; printf 'TELEGRAM_ENV=%s\n' "$T/tg.env" >> "$T/release.conf"
  "$BIN/notify-telegram.sh" --test; assert_file "$T/home/notify.proof"
}

t_alerts_keyed_by_cause() {
  sandbox
  RR_NOW=1000 rr_notify cause-x 3600 "SAME CAUSE" "body"; RR_NOW=2000 rr_notify cause-x 3600 "SAME CAUSE" "body"
  assert_eq "$(grep -c 'SAME CAUSE' "$T/notify.log")" 1 "inside the interval"
  RR_NOW=5000 rr_notify cause-x 3600 "SAME CAUSE" "body"; assert_eq "$(grep -c 'SAME CAUSE' "$T/notify.log")" 2
}

# Stress 2026-11-11: an alert sent while Telegram was down was logged "notify: FAILED" and never resent.
t_alert_while_telegram_down_is_resent_once() {
  sandbox; : > "$T/fail-notify"; echo 1 > "$T/fail-gate-1"; pass_at "$LAUNCH"
  assert_eq "$(st 1)" held; assert_not_contains "$(notes)" "HELD Update 1" "Telegram was down"
  assert_contains "$(cat "$T/home/log/runner.log")" "notify: owed"
  rm -f "$T/fail-notify"; pass_at $((LAUNCH + 60))
  assert_eq "$(grep -c 'HELD Update 1' "$T/notify.log")" 1 "resent on the next pass"
  assert_contains "$(notes)" "Sent late: Telegram could not be reached at"
  pass_at $((LAUNCH + 120)); assert_eq "$(grep -c 'HELD Update 1' "$T/notify.log")" 1 "resent once, not every pass"
  assert_eq "$(ls "$T/home/notify/owed" | wc -l | tr -d ' ')" 0 "nothing left owed"
}

t_owed_alerts_keyed_once_and_kept_while_down() {
  sandbox; : > "$T/fail-notify"
  RR_NOW=1000 rr_notify cause-y 3600 "CAUSE Y" "first"; RR_NOW=1100 rr_notify cause-y 3600 "CAUSE Y" "second"
  RR_NOW=1200 rr_notify "" 0 "PLAIN" "plain body"
  assert_eq "$(ls "$T/home/notify/owed" | wc -l | tr -d ' ')" 2 "one per key, plus the unkeyed one"
  RR_NOW=1300 rr_notify_retry_owed; assert_eq "$(lines "$T/notify.log")" 0 "still down: nothing sent"
  assert_eq "$(ls "$T/home/notify/owed" | wc -l | tr -d ' ')" 2 "still down: still owed"
  rm -f "$T/fail-notify"; RR_NOW=1400 rr_notify_retry_owed
  assert_eq "$(grep -c 'CAUSE Y' "$T/notify.log")" 1; assert_contains "$(notes)" "second"; assert_not_contains "$(notes)" "first"
  assert_eq "$(grep -c 'PLAIN' "$T/notify.log")" 1
  RR_NOW=1500 rr_notify cause-y 3600 "CAUSE Y" "again"; assert_eq "$(grep -c 'CAUSE Y' "$T/notify.log")" 1 "resend set the key stamp"
  : > "$T/fail-notify"; RR_NOW=9000 rr_notify cause-z 60 "CAUSE Z" "z"; rm -f "$T/fail-notify"
  RR_NOW=9100 rr_notify cause-z 60 "CAUSE Z" "z"; assert_no_file "$T/home/notify/owed/k-cause-z" "a later send clears the owed copy"
}

t_owed_alert_refuses_a_planted_link() {
  sandbox; : > "$T/fail-notify"; mkdir -p "$T/home/notify"; ln -s "$T/elsewhere" "$T/home/notify/owed"
  RR_NOW=1000 rr_notify cause-l 60 "LINKED" "body" 2>/dev/null
  assert_no_file "$T/elsewhere/k-cause-l" "wrote through a link in the runner home"
}

t_ghrelease_exit_codes() {
  sandbox; fake_curl; printf 'GITHUB_RELEASE_ENV=%s\n' "$T/gh.env" >> "$T/release.conf"
  rc=0; "$BIN/ghrelease.sh" create update-01 "$BASE" "Update 1: x" < /dev/null > /dev/null || rc=$?; assert_eq "$rc" 3 "no token"
  printf 'GITHUB_RELEASE_TOKEN=github_pat_SECRET\nGITHUB_RELEASE_REPO=example/repo\n' > "$T/gh.env"
  rc=0; "$BIN/ghrelease.sh" create v1 "$BASE" "x" < /dev/null > /dev/null 2>&1 || rc=$?; assert_eq "$rc" 2 "bad tag"
  rc=0; "$BIN/ghrelease.sh" create update-01 abc "x" < /dev/null > /dev/null 2>&1 || rc=$?; assert_eq "$rc" 2 "short sha"
  printf '404\n403\n' > "$T/codes"
  rc=0; "$BIN/ghrelease.sh" create update-01 "$BASE" "Update 1: x" < /dev/null > /dev/null || rc=$?; assert_eq "$rc" 3 "403 is an auth cause"
  printf '200\n' > "$T/codes"
  out=$("$BIN/ghrelease.sh" create update-01 "$BASE" "Update 1: x" < /dev/null); assert_contains "$out" "exists"
  assert_not_contains "$(cat "$T/curl-argv.log")" "github_pat_SECRET" "token on a command line"
}

t_ghrelease_draft_test_proves_the_token() {
  sandbox; fake_curl; printf 'GITHUB_RELEASE_ENV=%s\n' "$T/gh.env" >> "$T/release.conf"
  printf 'GITHUB_RELEASE_TOKEN=t\nGITHUB_RELEASE_REPO=example/repo\n' > "$T/gh.env"
  printf '201\n204\n' > "$T/codes"; "$BIN/ghrelease.sh" draft-test > /dev/null
  assert_file "$T/home/release-token.proof"; assert_contains "$(cat "$T/curl-stdin.log")" 'request = "DELETE"'
}

run_tests "$0"
