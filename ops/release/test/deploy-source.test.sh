#!/bin/bash
# Launch blocker (stress 2026-11-12): capstan-deploy fetches only the server's bare repo (/srv/capstan-src.git), which
# only the Mac updated, so every released sha failed "not found in the repo". The runner now pushes the sha there
# (LOCAL_DEPLOY_REMOTE, fast-forward only) before the deploy, and refuses to deploy when that push fails.
. "$(dirname "$0")/lib.sh"

src_main() { git --git-dir="$T/deploy-src.git" rev-parse refs/heads/main; }

t_released_sha_reaches_the_deploy_source() {
  sandbox; pass_at "$LAUNCH"
  assert_eq "$(st 1)" released "update 1 deploys from the server's own repo"
  assert_eq "$(src_main)" "$(cat "$T/prod")" "deploy source main is the released sha"
  pass_at $((LAUNCH + 3600)); assert_eq "$(st 2)" released
  assert_eq "$(src_main)" "$(cat "$T/prod")"
  assert_not_contains "$(notes)" "ROLLED BACK"
}

t_failed_push_never_deploys() {
  sandbox; chmod -R a-w "$T/deploy-src.git/objects" "$T/deploy-src.git/refs"
  trap 'chmod -R u+w "$T" 2>/dev/null; case "$T" in */rr-test.*) rm -rf "$T" ;; esac' EXIT
  pass_at "$LAUNCH"
  assert_no_file "$T/prod"; assert_no_file "$T/deploys.log"
  assert_eq "$(st 1)" pending "retried, not held, on the first failure"
  assert_contains "$(cat "$RR_LOG")" "deploy source: push of"
  pass_at $((LAUNCH + 60)); pass_at $((LAUNCH + 120))
  assert_eq "$(st 1)" held "held after TRANSIENT_MAX failed pushes"
  assert_no_file "$T/deploys.log"; assert_contains "$(notes)" "deploy source push"
}

t_a_moved_deploy_source_is_never_forced() {
  sandbox
  g init -q "$T/other"; echo other > "$T/other/o.txt"; g -C "$T/other" add -A; g -C "$T/other" commit -q -m "chore: elsewhere"
  g -C "$T/other" push -q --force "$T/deploy-src.git" main:main
  moved=$(src_main)
  pass_at "$LAUNCH"
  assert_eq "$(src_main)" "$moved" "a non-fast-forward is refused, never forced"
  assert_no_file "$T/deploys.log"; assert_eq "$(st 1)" pending
}

t_unset_remote_refuses_to_deploy() {
  sandbox; grep -v '^LOCAL_DEPLOY_REMOTE=' "$T/release.conf" > "$T/c" && mv "$T/c" "$T/release.conf"
  pass_at "$LAUNCH"
  assert_no_file "$T/deploys.log"; assert_contains "$(cat "$RR_LOG")" "LOCAL_DEPLOY_REMOTE is not set"
}

t_retry_after_a_failed_push_deploys_once() {
  sandbox; chmod -R a-w "$T/deploy-src.git/objects" "$T/deploy-src.git/refs"
  trap 'chmod -R u+w "$T" 2>/dev/null; case "$T" in */rr-test.*) rm -rf "$T" ;; esac' EXIT
  pass_at "$LAUNCH"; assert_eq "$(st 1)" pending
  chmod -R u+w "$T/deploy-src.git"
  pass_at $((LAUNCH + 60))
  assert_eq "$(st 1)" released; assert_eq "$(lines "$T/deploys.log")" 1 "one deploy"
  assert_eq "$(src_main)" "$(cat "$T/prod")"
  g -C "$T/work" fetch -q origin main
  assert_eq "$(g -C "$T/work" rev-list --count origin/main)" 2 "update applied once on private main"
}

run_tests "$0"
