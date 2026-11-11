#!/bin/bash
# OWNER-RUN (or the release runner later): copy new private main commits to capstandev/capstan. Safe to rerun:
# prints "nothing to sync" when the copy is current, and retries any setting that failed before.
#   bash ops/public/publish-public-update.sh
TAG=update
STAGES=6
. "$(cd "$(dirname "$0")" && pwd -P)/lib.sh"

say "preflight"
load_state
about
case "$(jget publicSha)" in SET-*|"") die "the public copy was never published: run publish-public.sh first";; esac

say "gh account"
use_gh_owner

say "private main"
fetch_private

say "sync"
run_sync

say "verify the copy"
verify_public

say "settings"
apply_settings
echo "[$TAG] done: https://github.com/$OWNER/$REPO"
