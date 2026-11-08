#!/bin/bash
# Disarm without stopping anything: remove the real-deploy flag. Passes then do nothing until arm.sh runs again.
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
rm -f "$RR_FLAG"; rr_log "disarm: flag removed"; echo "disarm: flag removed; no release will run"
