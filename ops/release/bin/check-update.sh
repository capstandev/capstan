#!/bin/bash
# Post-release checks for update N: runs $RR_HOME/checks/NN.sh (from the update plan). Each check reads production by
# CONTENT (JSON fields, bundle text), never a bare status code, and was recorded as FAIL against production before
# the release. A missing check file fails: an update without a check that can fail is not released.
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
n="${1:?usage: check-update.sh <n> <sha>}"
f="$RR_HOME/checks/$(printf '%02d' "$((10#$n))").sh"
[ -f "$f" ] || { echo "check: no check file $f"; exit 1; }
RR_SHA="${2:-}" /bin/bash "$f"
