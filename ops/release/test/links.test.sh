#!/bin/bash
# r3d-01: sudo runs the announce, ghrelease, notify and pause wrappers as root, but RR_HOME belongs to the runner user.
# A symlink the runner plants there must never make the wrapper write to another file (sudoers.d, nologin) or send
# another file (the token env) as the poster. On the server the helpers also drop to the runner user (runuser); the
# sandbox proves that part as root. Here every planted link must be refused and its target left untouched.
. "$(dirname "$0")/lib.sh"

fake_curl() { # answers with the next code in $T/codes (default 200); copies every uploaded file into $T/uploaded.log
  cat > "$T/fake/curl" <<EOF2
#!/bin/bash
cfg=\$(cat); printf '%s\n' "\$cfg" >> "$T/curl-stdin.log"
code=200; if [ -s "$T/codes" ]; then code=\$(head -n 1 "$T/codes"); sed -i.bak 1d "$T/codes"; fi
for f in \$(printf '%s\n' "\$cfg" | sed -n -e 's/^form = "photo=@\\\\"\(.*\)\\\\";type=image\/png"\$/\1/p' -e 's/^data-binary = "@\(.*\)"\$/\1/p'); do
  printf 'upload %s: %s\n' "\$f" "\$(cat "\$f" 2>/dev/null)" >> "$T/uploaded.log"
done
printf '%s\n' "\$cfg" | grep -q 'write-out' && printf '%s' "\$code"
o=""; prev=""; for a in "\$@"; do [ "\$prev" = "-o" ] && o="\$a"; prev="\$a"; done
[ -n "\$o" ] && [ "\$o" != /dev/null ] && printf '{"id": 42}' > "\$o"
exit 0
EOF2
  chmod +x "$T/fake/curl"; printf 'CURL=%s\n' "$T/fake/curl" >> "$T/release.conf"
  printf 'TELEGRAM_BOT_TOKEN=1:SECRETtg\nTELEGRAM_CHAT_ID=-100\n' > "$T/tg.env"
  printf 'GITHUB_RELEASE_TOKEN=SECRETgh\nGITHUB_RELEASE_REPO=example/repo\n' > "$T/gh.env"
  printf 'TELEGRAM_ENV=%s\nGITHUB_RELEASE_ENV=%s\n' "$T/tg.env" "$T/gh.env" >> "$T/release.conf"
}

t_announce_progress_links_are_not_followed() {
  sandbox; fake_curl
  mkdir -p "$T/home/announce"
  ln -s "$T/victim-text" "$T/home/announce/update-01.txt"
  rc=0; printf 'notes' | "$BIN/announce-telegram.sh" update-01 "Update 1: x" > /dev/null 2>&1 || rc=$?
  assert_no_file "$T/victim-text"
  [ "$rc" -ne 0 ] || fail "announce went on past a planted text link"
  rm -f "$T/home/announce/update-01.txt"; ln -s "$T/victim-done" "$T/home/announce/update-01.done"
  ln -s "$T/victim-parts" "$T/home/announce/update-01.parts"
  rc=0; printf 'notes' | "$BIN/announce-telegram.sh" update-01 "Update 1: x" > /dev/null 2>&1 || rc=$?
  assert_no_file "$T/victim-done"; assert_no_file "$T/victim-parts"
}

t_announce_poster_link_is_not_uploaded() {
  sandbox; fake_curl
  mkdir -p "$T/home/posters"; ln -s "$T/tg.env" "$T/home/posters/update-01.png"
  printf 'notes' | "$BIN/announce-telegram.sh" update-01 "Update 1: x" > /dev/null 2>&1 || true
  assert_not_contains "$(cat "$T/uploaded.log" 2>/dev/null)" "SECRETtg" "the token file went out as the poster"
  assert_not_contains "$(cat "$T/curl-stdin.log")" "posters/update-01.png" "root curl opened the runner's poster path"
}

t_announce_real_poster_still_posts() {
  sandbox; fake_curl
  mkdir -p "$T/home/posters"; printf 'PNGBYTES' > "$T/home/posters/update-01.png"
  out=$(printf 'notes' | "$BIN/announce-telegram.sh" update-01 "Update 1: x")
  assert_contains "$out" "posted (photo"; assert_contains "$(cat "$T/uploaded.log")" "PNGBYTES"
  assert_file "$T/home/announce/update-01.done"; assert_eq "$(cat "$T/home/announce/update-01.txt")" "Update 1: x

notes"
}

t_ghrelease_work_files_and_poster_links() {
  sandbox; fake_curl
  ln -s "$T/victim-req" "$T/home/ghrel.req"; ln -s "$T/victim-body" "$T/home/ghrel.body"; ln -s "$T/victim-code" "$T/home/ghrel.code"
  mkdir -p "$T/home/posters"; ln -s "$T/gh.env" "$T/home/posters/update-01.png"
  printf '404\n201\n' > "$T/codes"
  "$BIN/ghrelease.sh" create update-01 "$BASE" "Update 1: x" < /dev/null > /dev/null 2>&1 || true
  assert_no_file "$T/victim-req"; assert_no_file "$T/victim-body"; assert_no_file "$T/victim-code"
  assert_not_contains "$(cat "$T/uploaded.log" 2>/dev/null)" "SECRETgh" "the token file went out as a release asset"
}

t_runner_log_and_pause_links_are_not_followed() {
  sandbox
  rm -f "$T/home/log/runner.log"; ln -s "$T/victim-log" "$T/home/log/runner.log"
  printf 'TELEGRAM_ENV=%s\n' "$T/none.env" >> "$T/release.conf"
  "$BIN/notify-telegram.sh" "planted line" < /dev/null > /dev/null 2>&1 || true
  assert_no_file "$T/victim-log"
  ln -s "$T/victim-pause" "$T/home/PAUSE"; rm -f "$T/flag"
  "$BIN/pause.sh" "x" > /dev/null 2>&1 || true
  assert_no_file "$T/victim-pause"
}

run_tests "$0"
