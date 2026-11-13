#!/bin/bash
# bin/public-sync.sh (PUBLIC_SYNC_CMD): the public copy of one update through sync-public.py. A LOCAL bare repo stands
# in for capstandev/capstan and a throwaway key signs; nothing reaches the network.
. "$(dirname "$0")/lib.sh"
SYNC="$BIN/public-sync.sh"
WORD=zebracorn # the forbidden word of these tests (stands in for the owner's names)

# pub_world [changelog]: sandbox + a bootstrapped public repo (one signed empty base) + the template and key
pub_world() {
  sandbox 3
  ssh-keygen -q -t ed25519 -N '' -C public-sync-test -f "$T/signkey"
  g init -q --bare "$T/public.git"
  local empty base
  empty=$(g -C "$T/work" hash-object -t tree /dev/null)
  base=$(GIT_AUTHOR_NAME=capstandev GIT_AUTHOR_EMAIL=1+capstandev@users.noreply.github.com GIT_COMMITTER_NAME=capstandev \
    GIT_COMMITTER_EMAIL=1+capstandev@users.noreply.github.com g -C "$T/work" -c gpg.format=ssh -c user.signingkey="$T/signkey" \
    commit-tree -S "$empty" -m "chore: start the public repository")
  g -C "$T/work" push -q "$T/public.git" "$base:refs/heads/main"
  mkdir -p "$T/etc"
  python3 - "$T/etc/state.json" "$BASE" "$base" "$T/public.git" "${1:-}" "$WORD" <<'PY'
import json, sys
p, priv, pub, url, cl, word = sys.argv[1:7]
s = {"privateSha": priv, "publicSha": pub, "name": "capstandev", "email": "1+capstandev@users.noreply.github.com",
     "signingKey": "/nonexistent.pub", "publicRemote": "public", "branch": "main", "projectName": "Capstan",
     "scrub": {}, "forbidden": word, "publicUrl": url}
if cl:
    s["changelog"] = {"entries": "/nonexistent/entries.json", "commitUrl": "https://example.invalid/commit/{sha}"}
json.dump(s, open(p, "w"), indent=1)
PY
  chmod 0640 "$T/etc/state.json"
  printf 'PUBLIC_STATE=%s\nPUBLIC_SIGNING_KEY=%s\nPUBLIC_SYNC_CMD=%s\n' "$T/etc/state.json" "$T/signkey" "$SYNC" >> "$T/release.conf"
  printf '1+capstandev@users.noreply.github.com %s\n' "$(cat "$T/signkey.pub")" > "$T/allowed"
}
qsha() { g -C "$T/work" rev-parse "queue/tu-queue~$((3 - $1))"; }
advance() { g -C "$T/work" merge -q --ff-only "$(qsha "$1")"; } # private main takes update n (as the runner does)
pubcount() { g --git-dir="$T/public.git" rev-list --count main; }
pubtip() { g --git-dir="$T/public.git" rev-parse main; }

t_copies_one_update_signed_and_returns_its_sha() {
  pub_world; advance 1
  out=$("$SYNC" --update 1 --private-sha "$(qsha 1)" 2>"$T/err")
  assert_eq "$out" "$(pubtip)" "stdout is the public sha"
  assert_eq "$(pubcount)" 2 "base + one copy"
  assert_eq "$(g --git-dir="$T/public.git" rev-parse main^{tree})" "$(g -C "$T/work" rev-parse "$(qsha 1)^{tree}")" "same tree"
  assert_eq "$(g --git-dir="$T/public.git" log -1 --format='%an|%cn|%s' main)" "capstandev|capstandev|feat(api): update number 1"
  v=$(g --git-dir="$T/public.git" -c gpg.ssh.allowedSignersFile="$T/allowed" log -1 --format=%G? main)
  assert_eq "$v" G "signed with the capstandev key"
  assert_not_contains "$(cat "$T/err")$out" "PRIVATE KEY" "never prints a key"
  assert_eq "$(stat -f %Lp "$T/home/public" 2>/dev/null || stat -c %a "$T/home/public")" 700 "work dir is runner-only"
}

t_rerun_copies_nothing_twice() {
  pub_world; advance 1
  a=$("$SYNC" --update 1 --private-sha "$(qsha 1)" 2>/dev/null)
  b=$("$SYNC" --update 1 --private-sha "$(qsha 1)" 2>"$T/err")
  assert_eq "$b" "$a" "same public sha"; assert_eq "$(pubcount)" 2 "no second copy"
  assert_contains "$(cat "$T/err")" "already public"
}

t_two_updates_at_once_and_an_older_retry() {
  pub_world; advance 1; advance 2
  two=$("$SYNC" --update 2 --private-sha "$(qsha 2)" 2>/dev/null)
  assert_eq "$(pubcount)" 3 "both commits copied"
  one=$("$SYNC" --update 1 --private-sha "$(qsha 1)" 2>/dev/null)
  assert_eq "$one" "$(g --git-dir="$T/public.git" rev-parse main~1)" "an older update prints its own public sha"
  assert_eq "$two" "$(pubtip)"; assert_eq "$(pubcount)" 3 "nothing copied for the retry"
}

t_crash_after_push_is_adopted() {
  pub_world; advance 1
  rc=0; SANDBOX=1 SYNC_CRASH_AFTER_PUSH=1 "$SYNC" --update 1 --private-sha "$(qsha 1)" >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || fail "the injected crash did not fail the run"
  assert_eq "$(pubcount)" 2 "the push happened"
  out=$("$SYNC" --update 1 --private-sha "$(qsha 1)" 2>"$T/err")
  assert_eq "$out" "$(pubtip)"; assert_eq "$(pubcount)" 2 "rerun copied nothing twice"
  assert_contains "$(cat "$T/err")" "adopted the journalled push"
  advance 2; "$SYNC" --update 2 --private-sha "$(qsha 2)" >/dev/null 2>&1
  assert_eq "$(pubcount)" 3 "the next update copies once"
}

t_forbidden_word_refuses_and_pushes_nothing() {
  pub_world
  g -C "$T/work" checkout -q main
  echo "made by $WORD" > "$T/work/leak.txt"; g -C "$T/work" add -A; g -C "$T/work" commit -q -m "feat(api): a leak"
  before=$(pubtip); rc=0
  out=$("$SYNC" --update 1 --private-sha "$(g -C "$T/work" rev-parse HEAD)" 2>"$T/err") || rc=$?
  assert_eq "$rc" 1 "refused"; assert_eq "$out" "" "no sha printed"
  assert_eq "$(pubtip)" "$before" "nothing pushed"
  assert_contains "$(cat "$T/err")" "Refusing to publish"
  assert_not_contains "$(cat "$T/err")" "$WORD" "the word itself is never printed"
}

t_refuses_bad_input_and_missing_setup() {
  pub_world; advance 1
  rc=0; "$SYNC" --update x --private-sha "$(qsha 1)" >/dev/null 2>&1 || rc=$?; assert_eq "$rc" 2 "bad update"
  rc=0; "$SYNC" --update 1 --private-sha abc >/dev/null 2>&1 || rc=$?; assert_eq "$rc" 2 "short sha"
  rc=0; PUBLIC_SIGNING_KEY="$T/none" "$SYNC" --update 1 --private-sha "$(qsha 1)" >/dev/null 2>&1 || rc=$?; assert_eq "$rc" 2 "no key"
  rc=0; PUBLIC_STATE="$T/none" "$SYNC" --update 1 --private-sha "$(qsha 1)" >/dev/null 2>&1 || rc=$?; assert_eq "$rc" 2 "no template"
  rc=0; "$SYNC" --update 1 --private-sha 0123456789012345678901234567890123456789 >/dev/null 2>&1 || rc=$?; assert_eq "$rc" 1 "unknown sha"
  assert_eq "$(pubcount)" 1 "nothing pushed"
}

t_unbootstrapped_template_is_refused() {
  pub_world; advance 1
  python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); s["publicSha"]="SET-BY-BOOTSTRAP"; json.dump(s,open(sys.argv[1],"w"))' "$T/etc/state.json"
  rc=0; "$SYNC" --update 1 --private-sha "$(qsha 1)" >/dev/null 2>"$T/err" || rc=$?
  assert_eq "$rc" 2; assert_contains "$(cat "$T/err")" "never published"
}

t_check_mode_pushes_nothing() {
  pub_world
  out=$("$SYNC" --check 2>&1); assert_contains "$out" "ready"; assert_eq "$(pubcount)" 1
}

t_changelog_entry_from_the_staged_notes() {
  pub_world changelog; advance 1
  mkdir -p "$T/home/notes"; printf 'Plain notes for update one.\n' > "$T/home/notes/update-01.txt"
  out=$("$SYNC" --update 1 --private-sha "$(qsha 1)" 2>/dev/null)
  assert_eq "$(pubcount)" 3 "the update commit plus its changelog commit"
  assert_eq "$out" "$(pubtip)" "the sha after the changelog commit"
  cl=$(g --git-dir="$T/public.git" show main:CHANGELOG.md)
  assert_contains "$cl" "Plain notes for update one."; assert_contains "$cl" "## Update 1: update number 1"
  "$SYNC" --update 1 --private-sha "$(qsha 1)" >/dev/null 2>&1; assert_eq "$(pubcount)" 3 "rerun adds nothing"
}

# through the runner: publish-public.sh -> PUBLIC_SYNC_CMD; the GitHub Release targets the PUBLIC sha
t_runner_pass_publishes_and_releases_the_public_sha() {
  pub_world
  sed -i.bak "s#^PUBLISH_CMD=.*#PUBLISH_CMD=$BIN/publish-public.sh#" "$T/release.conf"
  pass_at "$LAUNCH"
  assert_eq "$(st 1)" released
  assert_eq "$(pubcount)" 2 "one public copy"
  assert_contains "$(cat "$T/ghrel.log")" "create update-01 $(pubtip) " "Release targets the public commit"
  pass_at $((LAUNCH + 60)); assert_eq "$(pubcount)" 2 "no second copy on the next pass"
}

run_tests "$0"
