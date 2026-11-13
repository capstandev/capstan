#!/bin/bash
# Public copy of update N: the signed public commit plus its CHANGELOG commit, through the project's public sync tool
# (PUBLIC_SYNC_CMD = bin/public-sync.sh, idempotent: an update already copied is a no-op). Runs only after the deploy
# passed its checks. Its stdout (the public sha) goes to the pass, which makes the GitHub Release on that commit.
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
rr_run PUBLIC_SYNC_CMD --update "$1" --private-sha "$2"
