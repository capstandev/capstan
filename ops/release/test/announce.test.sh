#!/bin/bash
# How the release pass drives the team post (a fake announcer here; announce-standin.test.sh runs the real one):
# after the GitHub Release, owed until it succeeds, retried one per pass, given up with one alert, dry run, and the
# old text-only post when no announcer is set.
. "$(dirname "$0")/lib.sh"
ann() { awk -F '\t' -v n="$1" '$1==n { s=$2 } END { print s }' "$T/home/announce.tsv"; }

t_posts_after_the_github_release() {
  sandbox; pass_at "$LAUNCH"
  assert_eq "$(ann 1)" announced; assert_eq "$(cat "$T/announce.log")" "update-01 Update 1 is live: update number 1"
  j=$(awk '$2==1 { print $4 }' "$T/home/journal.log" | tr '\n' ' ')
  assert_contains "$j" "published released announced" "order: public copy and Release, then the post"
  assert_file "$T/ghrel.log"
}

t_notes_file_is_the_body() {
  sandbox; mkdir -p "$T/home/notes"; printf 'Plain notes for the team.' > "$T/home/notes/update-01.txt"
  pass_at "$LAUNCH"; assert_contains "$(notes)" "The post for X is in the kit."; assert_contains "$(notes)" "Plain notes for the team."
}

t_failed_post_is_owed_and_retried_once_per_pass() {
  sandbox; : > "$T/fail-announce"; pass_at "$LAUNCH"
  assert_eq "$(st 1)" released; assert_eq "$(ann 1)" owed
  rm -f "$T/fail-announce"; pass_at $((LAUNCH + 60))
  assert_eq "$(ann 1)" announced; assert_eq "$(lines "$T/announce.log")" 1
  pass_at $((LAUNCH + 120)); assert_eq "$(lines "$T/announce.log")" 1 "never posted twice"
}

t_gives_up_with_one_alert() {
  sandbox; : > "$T/fail-announce"; printf 'ANNOUNCE_MAX_PASSES=2\n' >> "$T/release.conf"
  pass_at "$LAUNCH"; pass_at $((LAUNCH + 60)); assert_eq "$(ann 1)" gave_up
  pass_at $((LAUNCH + 120)); assert_eq "$(grep -c 'TEAM POST FAILED Update 1' "$T/notify.log")" 1
  assert_eq "$(st 2)" pending "a failed post never blocks the next update"
  pass_at $((LAUNCH + 3600)); assert_eq "$(st 2)" released
}

t_crash_before_the_post_leaves_it_owed() {
  sandbox; : > "$T/crash-publish"; pass_at "$LAUNCH" 2> /dev/null || true
  assert_eq "$(ann 1)" owed "owed is written before the public copy"
  rm -rf "$T/home/run.lock"; pass_at $((LAUNCH + 60))
  assert_eq "$(st 1)" released; assert_eq "$(ann 1)" announced; assert_eq "$(lines "$T/announce.log")" 1
}

t_dry_run_flag_is_passed_and_not_retried() {
  sandbox; printf 'ANNOUNCE_DRY_RUN=1\n' >> "$T/release.conf"; pass_at "$LAUNCH"
  assert_eq "$(ann 1)" dry_run; assert_contains "$(cat "$T/announce.log")" "dry update-01"
  pass_at $((LAUNCH + 60)); assert_eq "$(lines "$T/announce.log")" 1
}

t_no_announcer_keeps_the_text_post() {
  sandbox; printf 'ANNOUNCE_CMD=\n' >> "$T/release.conf"; pass_at "$LAUNCH"
  assert_no_file "$T/announce.log"; assert_contains "$(notes)" "Update 1 is live: update number 1|Update 1 is live"
  assert_eq "$(ann 1)" "" "not tracked"
}

t_announcer_refuses_bad_arguments() {
  sandbox
  for tag in v1 update-1 "update-01/../x" "fix-2026-11-08-a/b"; do
    rc=0; "$BIN/announce-telegram.sh" "$tag" "t" < /dev/null 2> /dev/null || rc=$?; assert_eq "$rc" 2 "tag $tag"
  done
  rc=0; "$BIN/announce-telegram.sh" update-01 < /dev/null 2> /dev/null || rc=$?; assert_eq "$rc" 2 "no title"
  printf 'TELEGRAM_ENV=%s\n' "$T/none.env" >> "$T/release.conf"
  rc=0; "$BIN/announce-telegram.sh" update-01 "t" < /dev/null || rc=$?; assert_eq "$rc" 3 "no token"
}

t_status_counts_team_posts() {
  sandbox; : > "$T/fail-announce"; pass_at "$LAUNCH"
  assert_contains "$(RR_NOW=$LAUNCH "$BIN/status.sh")" "team posts: announced 0; owed 1; dry run 0; given up 0"
  rm -f "$T/fail-announce"; pass_at $((LAUNCH + 60))
  assert_contains "$(RR_NOW=$LAUNCH "$BIN/status.sh")" "team posts: announced 1; owed 0"
}

t_sudoers_and_config_name_the_announcer() {
  assert_contains "$(cat "$T_ROOT/sudoers/capstan-release")" "/usr/local/sbin/capstan-release-announce"
  assert_contains "$(cat "$T_ROOT/etc/release.conf.example")" "ANNOUNCE_CMD=sudo -n /usr/local/sbin/capstan-release-announce"
}

run_tests "$0"
