#!/bin/bash
# Preflight: run the release gate on every pending and held update, in release order, on top of current private main,
# ahead of their slots. Writes $RR_HOME/preflight/results.tsv ("n<TAB>PASS|FAIL|NOAPPLY<TAB>sha") and one summary line.
# It NEVER takes the release lock (a side job that did made real passes exit and delayed releases), runs at nice 19,
# in its own worktree, and asserts the schedule first so a stale schedule fails with one clear line.
# Unarmed failures go to the log only; armed failures post one keyed alert.
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
out="$RR_HOME/preflight"; mkdir -p "$out"
"$RR_ROOT/bin/verify-schedule.sh" > "$out/verify.txt" 2>&1 || { cat "$out/verify.txt"; echo "preflight: stopped, the schedule does not match the checkouts"; exit 2; }
wt="$out/tree"
git -C "$RR_WORK" worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"
git -C "$RR_WORK" worktree prune
git -C "$RR_WORK" worktree add -q --detach "$wt" origin/main || { echo "preflight: could not make a worktree"; exit 2; }
nice_cmd=""; command -v nice >/dev/null 2>&1 && nice_cmd="nice -n 19"
: > "$out/results.tsv"; pass=0; total=0
for n in $(rr_sched_rows | cut -f1); do
  case "$(rr_state_get "$n" 2)" in pending|held) ;; *) continue ;; esac
  sha=$(rr_sched_field "$n" 3); total=$((total + 1)); before=$(git -C "$wt" rev-parse HEAD)
  if rr_carries "$wt" "$sha"; then :
  elif [ "$(git -C "$wt" rev-parse "$sha^")" = "$before" ]; then git -C "$wt" merge -q --ff-only "$sha" >/dev/null 2>&1
  elif ! git -C "$wt" -c commit.gpgsign=false cherry-pick "$sha" >/dev/null 2>&1; then
    git -C "$wt" cherry-pick --abort >/dev/null 2>&1; printf '%s\tNOAPPLY\t%s\n' "$n" "$sha" >> "$out/results.tsv"; continue
  fi
  if ( cd "$wt" && RR_PREFLIGHT=1 RR_UPDATE_N="$n" $nice_cmd $(rr_conf_get GATE_CMD) "$n" "$(git rev-parse HEAD)" ) > "$out/gate-$n.log" 2>&1; then
    printf '%s\tPASS\t%s\n' "$n" "$sha" >> "$out/results.tsv"; pass=$((pass + 1))
  else
    printf '%s\tFAIL\t%s\n' "$n" "$sha" >> "$out/results.tsv"
  fi
done
git -C "$RR_WORK" worktree remove --force "$wt" >/dev/null 2>&1 || true
line="preflight: $pass of $total PASS"
rr_log "$line"; echo "$line"
if [ "$pass" -ne "$total" ]; then
  bad=$(awk -F '\t' '$2!="PASS" { printf "%s %s, ", $1, $2 }' "$out/results.tsv")
  [ -f "$RR_FLAG" ] && rr_notify preflight 3600 "PREFLIGHT FAIL" "$line. Not ready: ${bad%, }. Those updates would be held at their slot; nothing is live yet. Logs: $out."
  exit 1
fi
