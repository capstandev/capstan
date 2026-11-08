#!/bin/bash
# Pause: write the PAUSE file (a release in progress finishes first) and tell the team, plainly, before anything else.
# Usage: pause.sh "<what is being shipped or why>"
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
why="${1:?usage: pause.sh \"<reason>\"}"
printf 'paused at %s: %s\n' "$(rr_epoch_to_iso "$(rr_now)")" "$why" > "$RR_PAUSE"
rr_log "pause: $why"
rr_fix_owner
rr_armed && rr_notify "" 0 "paused" "Short planned pause: $why. Nothing is broken and nobody is affected."
echo "pause: paused"
