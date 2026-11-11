#!/bin/bash
# OWNER-RUN, once: publish the public copy of Capstan as capstandev/capstan (never run by an agent).
#   bash ops/public/publish-public.sh
# Creates the repo PRIVATE with the About text, bootstraps it with one signed empty commit, copies every private main
# commit (first-parent) as a signed capstandev commit, checks the copy, and only then flips it to public and applies the
# settings. gh is switched to capstandev for the run and back to the previous account on exit. Safe to rerun: a stage
# that is already done says so. Settings that fail print FAILED with the URL; publish-public-update.sh retries them.
TAG=publish
STAGES=9
. "$(cd "$(dirname "$0")" && pwd -P)/lib.sh"

say "preflight"
load_state
about

say "gh account"
use_gh_owner

say "private main"
fetch_private

say "create $OWNER/$REPO (private first)"
if "$GH" repo view "$OWNER/$REPO" >/dev/null 2>&1; then note "exists"
else "$GH" repo create "$OWNER/$REPO" --private --description "$DESC" --homepage "$WEBSITE" --disable-wiki >/dev/null; note "created private"; fi

say "bootstrap"
if [ -z "$(sgit ls-remote "$REMOTE" "refs/heads/$BRANCH")" ]; then
  empty="$(sgit hash-object -t tree /dev/null)"
  base="$(GIT_AUTHOR_NAME="$PUB_NAME" GIT_AUTHOR_EMAIL="$PUB_EMAIL" GIT_COMMITTER_NAME="$PUB_NAME" GIT_COMMITTER_EMAIL="$PUB_EMAIL" \
          sgit -c gpg.format=ssh -c user.signingkey="$KEY" commit-tree -S "$empty" -m "chore: start the public repository")"
  sgit push -q "$REMOTE" "$base:refs/heads/$BRANCH"
  jset privateSha "$base"; jset publicSha "$base"; rm -f "$STATE.map.jsonl" "$STATE.pending.json"
  note "pushed signed empty base ${base:0:12}"
else
  case "$(jget publicSha)" in SET-*|"") die "public $BRANCH already has commits but the state was never set: stop, check $OWNER/$REPO by hand";; esac
  note "already bootstrapped (public $BRANCH exists)"
fi
base="$(jget privateSha)"
if ! sgit merge-base --is-ancestor "$base" "$BRANCH" 2>/dev/null; then
  for root in $(sgit rev-list --max-parents=0 "$BRANCH"); do sgit replace -f --graft "$root" "$base" 2>/dev/null; done
  note "grafted the private root(s) onto the base for the first copy"
fi

say "sync"
run_sync
grafts="$(sgit replace -l)"
if [ -n "$grafts" ]; then sgit replace -d $grafts >/dev/null; note "grafts removed"; fi

say "verify the copy"
verify_public

say "flip to public"
if [ "$("$GH" repo view "$OWNER/$REPO" --json visibility --jq .visibility 2>/dev/null)" = PUBLIC ]; then note "already public"
else "$GH" repo edit "$OWNER/$REPO" --visibility public --accept-visibility-change-consequences >/dev/null; note "public: https://github.com/$OWNER/$REPO"; fi

say "settings"
apply_settings
echo "[$TAG] done: https://github.com/$OWNER/$REPO"
