#!/bin/bash
# One pass of the release runner: release at most one due update, then exit. The systemd timer starts a pass every
# minute. Order of one release: gate -> apply on private main -> push private -> deploy (auto-rollback) -> post-release
# checks -> public copy -> GitHub Release -> team post (poster and notes). Nothing public happens before the deploy
# is healthy.
#
# Rules this file proves (tests in ../test):
# - Not armed (flag file plus CAPSTAN_RELEASE_RUNNER=1) or paused: nothing runs, nothing is posted.
# - A failed gate holds that one update; the next one still releases at its slot (no cascade).
# - Exit 75 from gate, push or deploy means "nothing switched": the update stays pending and is retried.
# - A failed deploy or check rolls back and holds; a failed rollback writes PAUSE and alerts.
# - A crash mid-release is adopted from the journal by the next pass; the public copy is never made twice. An update
#   that crashes its pass more than CRASH_MAX (3) times pauses the runner with one alert (no endless redeploys).
# - The public copy and the Release are side channels: their failure never blocks the next update.
# - The team post (ANNOUNCE_CMD: poster plus notes) is marked announced only when it went out; until then it is owed
#   and retried one per pass, never blocking the next update. ANNOUNCE_DRY_RUN=1 renders it and sends nothing.
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init

TRANSIENT_MAX=$(rr_conf_get TRANSIENT_MAX 30)
MIN_GAP_MINUTES=$(rr_conf_get MIN_GAP_MINUTES 2)
PUBLIC_CI_EVERY_S=$(rr_conf_get PUBLIC_CI_EVERY_S 300)
CRASH_MAX=$(rr_conf_get CRASH_MAX 3)

git_w() { git -C "$RR_WORK" "$@"; }

# Bring the work checkout to private main; never leaves a half-applied cherry-pick behind.
sync_main() {
  git_w cherry-pick --abort >/dev/null 2>&1 || true
  git_w fetch -q origin main || return 75
  git_w fetch -q queue || return 75
  git_w checkout -q -B main origin/main || return 75
  git_w reset -q --hard origin/main || return 75
}

# Apply update sha on main. Prints the sha now at HEAD. 0 ok, 3 conflict.
apply_update() {
  local sha="$1" parent
  # on main already (rr_carries: not taken out by a rollback revert since; a retried update after a rollback used to
  # be marked released with nothing shipped)
  if rr_carries "$RR_WORK" "$sha"; then git_w rev-parse HEAD; return 0; fi
  parent=$(git_w rev-parse "$sha^" 2>/dev/null || true)
  if [ "$parent" = "$(git_w rev-parse HEAD)" ]; then
    git_w merge -q --ff-only "$sha" >/dev/null || return 3
  else
    if [ "$(rr_conf_get SIGN_CHERRY_PICKS 1)" = "1" ]; then
      git_w cherry-pick -S "$sha" >/dev/null 2>&1 || { git_w cherry-pick --abort >/dev/null 2>&1; return 3; }
    else
      git_w cherry-pick "$sha" >/dev/null 2>&1 || { git_w cherry-pick --abort >/dev/null 2>&1; return 3; }
    fi
  fi
  git_w rev-parse HEAD
}

hold() { # hold n attempts title reason alert_title
  rr_state_set "$1" held "$2" "$4"
  rr_journal "$1" - held
  rr_notify "" 0 "$5" "Update $1 ($3) was not released: $4. Users are not affected and nothing changed on the live service. The next update continues at its own time. The log is $RR_LOG."
}

retry_later() { # retry_later n attempts title what
  local n="$1" att=$(( $2 + 1 ))
  if [ "$att" -ge "$TRANSIENT_MAX" ]; then
    hold "$n" "$att" "$3" "$4 failed $att times in a row" "HELD Update $n"
  else
    rr_state_set "$n" pending "$att" "retry: $4"
    rr_log "update $n: $4 failed (transient, attempt $att of $TRANSIENT_MAX); retried next pass"
  fi
}

# Undo a deployed update: production back to prev, private main reverted. Returns 0 when the rollback worked.
rollback() { # rollback n applied_sha prev_sha
  local n="$1" applied="$2" prev="$3"
  if ! rr_run ROLLBACK_CMD "$prev"; then
    printf 'rollback of update %s failed at %s\n' "$n" "$(rr_epoch_to_iso "$(rr_now)")" > "$RR_PAUSE"
    rr_log "update $n: ROLLBACK FAILED; runner paused"
    rr_notify "" 0 "ROLLBACK FAILED Update $n" "Update $n failed its checks and the automatic rollback also failed. The runner is paused. The owner must look now: run the status command, then the rollback command by hand."
    return 1
  fi
  git_w revert --no-edit "$applied" >/dev/null 2>&1 && rr_run PRIVATE_PUSH_CMD "$RR_WORK" >/dev/null 2>&1 || rr_log "update $n: revert on private main not pushed; fix by hand before the next update"
  return 0
}

# GitHub Release for update n. A failure (GitHub down, token refused) leaves it owed in the journal (ghrel_owed);
# retry_owed_ghrel makes it on a later pass (stress 2026-11-11: a GitHub outage at the slot used to lose the page).
ghrel() { # ghrel n sha title
  local n="$1" sha="$2" title="$3" rc
  rr_run GHREL_CMD create "$(rr_tag_of "$n")" "$sha" "Update $n: $title"; rc=$?
  if [ "$rc" -eq 0 ]; then
    [ "$(ghrel_stage "$n")" = ghrel_owed ] && rr_journal "$n" "$sha" ghrel_done
    rr_notify_clear ghrel-auth; rr_notify_clear "ghrel-$n"; return 0
  fi
  case $rc in
    127) rr_notify ghrel-off 21600 "GitHub releases are OFF" "No release command or token is set. Updates are live; Release pages are not made until the owner saves the token."; return 1 ;;
    3) rr_notify ghrel-auth 21600 "GITHUB RELEASES BLOCKED (token permission)" "The release token is missing or lacks Contents read and write. Updates are live; only the Release pages wait. The owner saves the token, then the next pass fills them in." ;;
    *) rr_notify "ghrel-$n" 3600 "GITHUB RELEASE FAILED $(rr_tag_of "$n")" "The Release page for update $n failed. The update itself is live. The next pass tries again." ;;
  esac
  [ "$(ghrel_stage "$n")" = ghrel_owed ] || rr_journal "$n" "$sha" ghrel_owed
  return 1
}
ghrel_stage() { awk -v n="$1" '$2==n && ($4=="ghrel_owed" || $4=="ghrel_done") { s=$4 } END { print s }' "$RR_JOURNAL" 2>/dev/null; }
# One owed GitHub Release per pass, oldest first.
retry_owed_ghrel() {
  local n sha
  for n in $(awk '$4=="ghrel_owed" || $4=="ghrel_done" { s[$2]=$4 } END { for (k in s) if (s[k]=="ghrel_owed") print k }' "$RR_JOURNAL" 2>/dev/null | sort -n); do
    case "$(rr_state_get "$n" 2)" in released|publish_pending) ;; *) continue ;; esac
    sha=$(awk -v n="$n" '$2==n && $4=="ghrel_owed" { s=$3 } END { print s }' "$RR_JOURNAL")
    ghrel "$n" "$sha" "$(rr_title_of "$n")" && rr_log "update $n: owed GitHub Release made"
    return 0
  done
}

publish() { # publish n sha title: side channel, never blocks a release
  local n="$1" sha="$2" title="$3"
  rr_journal "$n" "$sha" publishing
  if rr_run PUBLISH_CMD "$n" "$sha"; then
    rr_journal "$n" "$sha" published
    rr_notify_clear "publish-fail"
    ghrel "$n" "$sha" "$title"
    return 0
  fi
  rr_journal "$n" "$sha" publish_failed
  rr_notify publish-fail 3600 "PUBLIC COPY FAILED Update $n" "Update $n is live on the service but its public copy did not go out. The next pass tries again; later updates are not blocked."
  return 1
}

# ---------- team post: announce.tsv rows "n<TAB>status<TAB>tries<TAB>at"; owed, announced, dry_run, gave_up ----------
ANN="$RR_HOME/announce.tsv"
[ -f "$ANN" ] || : > "$ANN"
ann_get() { awk -F '\t' -v n="$1" -v c="$2" '$1==n { v=$c } END { print v }' "$ANN"; }
ann_set() { # ann_set n status tries
  awk -F '\t' -v n="$1" '$1!=n' "$ANN" > "$ANN.tmp.$$"
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$(rr_now)" >> "$ANN.tmp.$$"
  mv "$ANN.tmp.$$" "$ANN"
}

# announce n sha title: post the update's poster and notes; marked announced only when the post went out.
announce() {
  local n="$1" sha="$2" title="$3" tag head body notes_f tries rc
  tag=$(rr_tag_of "$n"); head="Update $n is live: $title"
  if [ -z "$(rr_conf_get ANNOUNCE_CMD)" ]; then # no announcer configured: the old text-only post, not tracked
    rr_notify "" 0 "$head" "$head. Released $(rr_epoch_to_iso "$(rr_now)"). The post for X is in the kit."
    return 0
  fi
  [ -n "$(ann_get "$n" 2)" ] || ann_set "$n" owed 0
  case "$(ann_get "$n" 2)" in announced|dry_run|gave_up) return 0 ;; esac
  body="Released $(rr_epoch_to_iso "$(rr_now)"). The post for X is in the kit."
  notes_f="$RR_HOME/notes/$tag.txt"
  if [ -s "$notes_f" ]; then body="$body

$(cat "$notes_f")"; fi
  tries=$(( $(ann_get "$n" 3) + 1 ))
  if [ "$(rr_conf_get ANNOUNCE_DRY_RUN 0)" = "1" ]; then
    printf '%s' "$body" | rr_run ANNOUNCE_CMD --dry-run "$tag" "$head" >> "$RR_LOG" 2>&1; rc=$?
    if [ "$rc" -eq 0 ]; then ann_set "$n" dry_run "$tries"; rr_journal "$n" "$sha" announce_dry_run; else ann_set "$n" owed "$tries"; fi
    rr_log "update $n: team post dry run (rc $rc); nothing sent"
    return 0
  fi
  printf '%s' "$body" | rr_run ANNOUNCE_CMD "$tag" "$head" >> "$RR_LOG" 2>&1; rc=$?
  if [ "$rc" -eq 0 ]; then
    ann_set "$n" announced "$tries"; rr_journal "$n" "$sha" announced; rr_log "update $n: announced"
  elif [ "$tries" -ge "$(rr_conf_get ANNOUNCE_MAX_PASSES 30)" ]; then
    ann_set "$n" gave_up "$tries"; rr_journal "$n" "$sha" announce_gave_up
    rr_log "update $n: team post failed $tries passes in a row (rc $rc); given up"
    rr_notify "announce-$n" 86400 "TEAM POST FAILED Update $n" "Update $n is live, but its post with the poster did not reach this group after $tries tries. Repost it by hand from the kit."
  else
    ann_set "$n" owed "$tries"; rr_journal "$n" "$sha" announce_failed
    rr_log "update $n: team post not sent (rc $rc, try $tries); owed, retried next pass"
  fi
  return 0
}

# Retry a team post that a failed send or a crash left owed (one per pass).
retry_owed_announce() {
  local n
  for n in $(awk -F '\t' '$2=="owed" { print $1 }' "$ANN"); do
    case "$(rr_state_get "$n" 2)" in released|publish_pending) ;; *) continue ;; esac
    announce "$n" "$(rr_state_get "$n" 5)" "$(rr_title_of "$n")"
    return 0
  done
}

finish_release() { # finish_release n applied_sha title attempts
  local n="$1" sha="$2" title="$3" att="$4"
  # owed before anything else: a crash between here and the post still leaves it to retry_owed_announce
  [ -z "$(rr_conf_get ANNOUNCE_CMD)" ] || [ -n "$(ann_get "$n" 2)" ] || ann_set "$n" owed 0
  if publish "$n" "$sha" "$title"; then rr_state_set "$n" released "$att" "$sha"
  else rr_state_set "$n" publish_pending "$att" "$sha"; fi
  rr_journal "$n" "$sha" released
  announce "$n" "$sha" "$title" # after the public copy and the GitHub Release
  rr_log "update $n: released ($sha)"
}

# Retry public copies that a failed side channel left owed (one per pass).
retry_owed_publish() {
  local n sha
  for n in $(rr_sched_rows | cut -f1); do
    [ "$(rr_state_get "$n" 2)" = "publish_pending" ] || continue
    sha=$(rr_state_get "$n" 5)
    if publish "$n" "$sha" "$(rr_title_of "$n")"; then rr_state_set "$n" released "$(rr_state_get "$n" 3)" "$sha"; fi
    return 0
  done
}

# Adopt a release a crash left in_progress: continue from the stage after the last journal line.
adopt_crashed() { # returns 1 when it paused the runner (an update that keeps crashing its pass)
  local n stage sha crashes
  for n in $(rr_sched_rows | cut -f1); do
    [ "$(rr_state_get "$n" 2)" = "in_progress" ] || continue
    stage=$(awk -v n="$n" '$2==n && $4!="adopted" { s=$4 } END { print s }' "$RR_JOURNAL") # last real stage
    sha=$(awk -v n="$n" '$2==n && $3!="-" { s=$3 } END { print s }' "$RR_JOURNAL")
    crashes=$(( $(awk -v n="$n" '$4=="resumed" { c=0 } $2==n && $4=="adopted" { c++ } END { print c+0 }' "$RR_JOURNAL") + 1 ))
    if [ "$crashes" -gt "$CRASH_MAX" ]; then
      # the same update killed its pass again and again (an OOM kill, a check that hangs the unit): stop redeploying
      printf 'update %s crashed its pass %s times (last stage %s) at %s\n' "$n" "$crashes" "${stage:-start}" "$(rr_epoch_to_iso "$(rr_now)")" > "$RR_PAUSE"
      rr_log "update $n: crashed $crashes times; runner paused"
      rr_notify "" 0 "PAUSED: Update $n keeps crashing" "Update $n crashed the release pass $crashes times in a row (last stage: ${stage:-start}). The runner is paused so it stops redeploying. Production may run update $n or the one before it. The owner reads the log and the status command, rolls back by hand if needed, then resumes."
      return 1
    fi
    rr_journal "$n" - adopted
    rr_log "update $n: adopting a crashed release (last stage: ${stage:-none}, crash $crashes of at most $CRASH_MAX)"
    case "$stage" in
      checked|publishing|published|publish_failed|ghrel_owed|ghrel_done)
        finish_release "$n" "$sha" "$(rr_title_of "$n")" "$(rr_state_get "$n" 3)" ;;
      *) # before the checks passed: production may run it, may not; redo from the start (deploy is idempotent)
        rr_state_set "$n" pending "$(rr_state_get "$n" 3)" "adopted after a crash at stage ${stage:-start}" ;;
    esac
  done
}

next_due() { # prints the number of the first due update, or nothing
  local now last_rel row n slot st
  now=$(rr_now)
  last_rel=$(awk -F '\t' '$2=="released" || $2=="publish_pending" { if ($4>m) m=$4 } END { print m+0 }' "$RR_STATE")
  if [ $((last_rel + MIN_GAP_MINUTES * 60)) -gt "$now" ]; then return 0; fi
  rr_sched_rows | while IFS="$(printf '\t')" read -r n slot _sha _title; do
    st=$(rr_state_get "$n" 2)
    case "$st" in pending) ;; *) continue ;; esac
    [ "$slot" -le "$now" ] && { printf '%s' "$n"; break; }
  done
}

release_one() {
  local n="$1" sha title att prev applied rc prior
  sha=$(rr_sched_field "$n" 3); title=$(rr_title_of "$n"); att=$(rr_state_get "$n" 3)
  rr_state_set "$n" in_progress "$att" "$sha"
  rr_journal "$n" "$sha" start
  rr_log "update $n: start ($title, $sha)"

  sync_main; rc=$?
  if [ "$rc" -ne 0 ]; then retry_later "$n" "$att" "$title" "fetch"; return 0; fi
  prev=$(git_w rev-parse HEAD)
  prior=$(awk -v n="$n" '$2==n && $4=="applied" { s=$3 } END { print s }' "$RR_JOURNAL")
  if [ -n "$prior" ] && [ "$prior" = "$prev" ]; then
    # a retry after "nothing switched": main already carries this update, so roll back to its parent
    applied="$prior"; prev=$(git_w rev-parse "$prior^"); rc=0
  else
    applied=$(apply_update "$sha"); rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    git_w reset -q --hard "$prev"
    rr_state_set "$n" held "$att" "does not apply on current main"
    rr_journal "$n" "$sha" held
    rr_notify queue-rebase 3600 "queue needs a rebase" "Update $n does not apply on the current private main (main moved). It is held; later updates are tried at their slots. The owner rebuilds the queue on the new main, then retries."
    return 0
  fi
  rr_journal "$n" "$applied" applied

  ( cd "$RR_WORK" && RR_UPDATE_N="$n" RR_SHA="$applied" rr_run GATE_CMD "$n" "$applied" ) >> "$RR_HOME/log/gate-$n.log" 2>&1; rc=$?
  if [ "$rc" -eq 75 ]; then git_w reset -q --hard "$prev"; retry_later "$n" "$att" "$title" "gate (tool or network)"; return 0; fi
  if [ "$rc" -ne 0 ]; then git_w reset -q --hard "$prev"; hold "$n" "$att" "$title" "its tests failed (log gate-$n.log)" "HELD Update $n"; return 0; fi

  rr_run PRIVATE_PUSH_CMD "$RR_WORK" >> "$RR_LOG" 2>&1; rc=$?
  if [ "$rc" -ne 0 ]; then git_w reset -q --hard "$prev"; retry_later "$n" "$att" "$title" "private push"; return 0; fi
  rr_journal "$n" "$applied" pushed

  rr_run DEPLOY_CMD "$applied" >> "$RR_LOG" 2>&1; rc=$?
  if [ "$rc" -eq 75 ]; then retry_later "$n" "$att" "$title" "deploy (nothing switched)"; return 0; fi
  if [ "$rc" -ne 0 ]; then
    if rollback "$n" "$applied" "$prev"; then
      hold "$n" "$att" "$title" "the deploy failed and was rolled back" "Update $n ROLLED BACK"
    else rr_state_set "$n" held "$att" "deploy failed, rollback failed"; fi
    return 0
  fi
  rr_journal "$n" "$applied" deployed

  rr_run CHECK_CMD "$n" "$applied" >> "$RR_HOME/log/check-$n.log" 2>&1; rc=$?
  if [ "$rc" -ne 0 ]; then
    if rollback "$n" "$applied" "$prev"; then
      hold "$n" "$att" "$title" "a post-release check failed and the previous version was restored (log check-$n.log)" "Update $n ROLLED BACK"
    else rr_state_set "$n" held "$att" "check failed, rollback failed"; fi
    return 0
  fi
  rr_journal "$n" "$applied" checked

  finish_release "$n" "$applied" "$title" "$att"
}

public_ci_tick() {
  local stamp="$RR_HOME/notify/.public-ci-last" last now
  [ -n "$(rr_conf_get PUBLIC_CI_CHECK_CMD)" ] || return 0
  now=$(rr_now); last=$(cat "$stamp" 2>/dev/null || echo 0)
  [ $((now - last)) -ge "$PUBLIC_CI_EVERY_S" ] || return 0
  printf '%s\n' "$now" > "$stamp"
  rr_run PUBLIC_CI_CHECK_CMD >> "$RR_LOG" 2>&1
  case $? in
    0) if [ -f "$RR_HOME/notify/public-ci" ]; then rr_notify_clear public-ci; rr_notify "" 0 "public CI green again" "Every public check passes again."; fi ;;
    1) rr_notify public-ci 3600 "PUBLIC CI RED" "A public CI check failed on the latest public commit. Users are not affected. The owner reads the failing jobs." ;;
    *) rr_log "public CI: could not read (no alert)" ;;
  esac
}

main() {
  if ! rr_armed; then rr_log "pass: not armed (no release, no alert)"; exit 0; fi
  if [ -f "$RR_PAUSE" ]; then rr_log "pass: paused"; exit 0; fi
  if ! rr_lock; then rr_log "pass: another pass is running"; exit 0; fi
  trap 'rr_unlock' EXIT
  local launch n
  launch=$(rr_iso_to_epoch "$(rr_sched_header launch_at)") || { rr_log "pass: the schedule has no launch_at (run arm.sh)"; exit 1; }
  if [ "$(rr_now)" -lt "$launch" ]; then rr_log "pass: before launch"; exit 0; fi
  rr_notify_retry_owed # alerts Telegram missed on an earlier pass, before any new one
  adopt_crashed || exit 0
  retry_owed_publish
  retry_owed_announce
  retry_owed_ghrel
  n=$(next_due)
  if [ -n "$n" ]; then release_one "$n"; else rr_log "pass: nothing due"; fi
  public_ci_tick
  if [ -n "$(rr_conf_get HEALTHCHECK_CMD)" ]; then rr_run HEALTHCHECK_CMD >/dev/null 2>&1 || true; fi
}
main "$@"
