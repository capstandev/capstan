#!/bin/bash
# Write the schedule from the queue: every commit in base..tip, in order, one slot each.
# Usage: build-schedule.sh <base-sha> <tip-ref> [launch-at ISO UTC]
# Refuses a queue that is not one straight line on top of base (a merge or a gap would release the wrong tree),
# and a count other than EXPECTED_COUNT when that is set. Without a launch time, slots are written relative to 0 and
# arm.sh dates them.
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
base="${1:?usage: build-schedule.sh <base-sha> <tip-ref> [launch-at]}"; tip_ref="${2:?tip ref}"; launch_iso="${3:-}"
cadence=$(rr_conf_get CADENCE_MINUTES 60); expected=$(rr_conf_get EXPECTED_COUNT "")
base=$(git -C "$RR_WORK" rev-parse --verify "$base^{commit}") || { echo "build-schedule: base not found" >&2; exit 2; }
tip=$(git -C "$RR_WORK" rev-parse --verify "$tip_ref^{commit}") || { echo "build-schedule: tip not found" >&2; exit 2; }
git -C "$RR_WORK" merge-base --is-ancestor "$base" "$tip" || { echo "build-schedule: tip is not on top of base" >&2; exit 2; }
if [ -n "$(git -C "$RR_WORK" rev-list --merges "$base..$tip")" ]; then echo "build-schedule: the queue has merge commits" >&2; exit 2; fi
launch=0
if [ -n "$launch_iso" ]; then launch=$(rr_iso_to_epoch "$launch_iso") || { echo "build-schedule: launch time must look like 2026-11-20T01:30:00Z" >&2; exit 2; }; fi
W=$(mktemp -d "${TMPDIR:-/tmp}/rr-schedule.XXXXXX"); trap 'case "$W" in */rr-schedule.*) rm -rf "$W" ;; esac' EXIT
tmp="$W/schedule.tsv" # root-owned work file; the runner's copy is written through rr_write (r3d-01)
{
  printf '# base %s\n# tip %s\n' "$base" "$tip"
  [ -n "$launch_iso" ] && printf '# launch_at %s\n' "$launch_iso"
  printf '# cadence_minutes %s\n' "$cadence"
} > "$tmp"
i=0; prev="$base"
for sha in $(git -C "$RR_WORK" rev-list --reverse "$base..$tip"); do
  parent=$(git -C "$RR_WORK" rev-parse "$sha^")
  [ "$parent" = "$prev" ] || { rm -f "$tmp"; echo "build-schedule: $sha does not sit on the previous update" >&2; exit 2; }
  i=$((i + 1))
  subject=$(git -C "$RR_WORK" log -1 --format=%s "$sha" | sed -E 's/^[a-z]+(\([^)]*\))?!?: //' | tr '\t' ' ')
  printf '%s\t%s\t%s\t%s\n' "$i" $(( launch + (i - 1) * cadence * 60 )) "$sha" "$subject" >> "$tmp"
  prev="$sha"
done
if [ "$i" -eq 0 ]; then rm -f "$tmp"; echo "build-schedule: no commits in base..tip" >&2; exit 2; fi
if [ -n "$expected" ] && [ "$i" -ne "$expected" ]; then rm -f "$tmp"; echo "build-schedule: $i updates, expected $expected" >&2; exit 2; fi
rr_write "$RR_SCHEDULE.tmp.$$" < "$tmp" && rr_home_op "$RR_SCHEDULE" mv -f "$RR_SCHEDULE.tmp.$$" "$RR_SCHEDULE" || { echo "build-schedule: could not write $RR_SCHEDULE" >&2; exit 2; }
rr_fix_owner
echo "build-schedule: $i updates, base ${base:0:12}, tip ${tip:0:12}"
