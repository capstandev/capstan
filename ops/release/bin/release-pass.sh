#!/bin/bash
# One pass of the release runner: release at most one due update, then exit. The systemd timer starts a pass every
# minute. Order of one release: gate -> apply on private main -> push private -> deploy (auto-rollback) -> post-release
# checks -> public copy -> GitHub Release -> team post. Nothing public happens before the deploy is healthy.
#
# Rules this file proves (tests in ../test):
# - Not armed (flag file plus CAPSTAN_RELEASE_RUNNER=1) or paused: nothing runs, nothing is posted.
# - A failed gate holds that one update; the next one still releases at its slot (no cascade).
# - Exit 75 from gate, push or deploy means "nothing switched": the update stays pending and is retried.
# - A failed deploy or check rolls back and holds; a failed rollback writes PAUSE and alerts.
# - A crash mid-release is adopted from the journal by the next pass; the public copy is never made twice.
# - The public copy and the Release are side channels: their failure never blocks the next update.
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init

TRANSIENT_MAX=$(rr_conf_get TRANSIENT_MAX 30)
MIN_GAP_MINUTES=$(rr_conf_get MIN_GAP_MINUTES 2)
PUBLIC_CI_EVERY_S=$(rr_conf_get PUBLIC_CI_EVERY_S 300)

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
  if git_w merge-base --is-ancestor "$sha" HEAD 2>/dev/null; then git_w rev-parse HEAD; return 0; fi
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

publish() { # publish n sha title: side channel, never blocks a release
  local n="$1" sha="$2" title="$3"
  rr_journal "$n" "$sha" publishing
  if rr_run PUBLISH_CMD "$n" "$sha"; then
    rr_journal "$n" "$sha" published
    rr_notify_clear "publish-fail"
    if rr_run GHREL_CMD create "$(rr_tag_of "$n")" "$sha" "Update $n: $title"; then rr_notify_clear ghrel-auth
    else
      case $? in
        127) rr_notify ghrel-off 21600 "GitHub releases are OFF" "No release command or token is set. Updates are live; Release pages are not made until the owner saves the token." ;;
        3) rr_notify ghrel-auth 21600 "GITHUB RELEASES BLOCKED (token permission)" "The release token is missing or lacks Contents read and write. Updates are live; only the Release pages wait. The owner saves the token, then the next pass fills them in." ;;
        *) rr_notify "ghrel-$n" 3600 "GITHUB RELEASE FAILED $(rr_tag_of "$n")" "The Release page for update $n failed. The update itself is live. The next pass tries again." ;;
      esac
    fi
    return 0
  fi
  rr_journal "$n" "$sha" publish_failed
  rr_notify publish-fail 3600 "PUBLIC COPY FAILED Update $n" "Update $n is live on the service but its public copy did not go out. The next pass tries again; later updates are not blocked."
  return 1
}

finish_release() { # finish_release n applied_sha title attempts
  local n="$1" sha="$2" title="$3" att="$4"
  if publish "$n" "$sha" "$title"; then rr_state_set "$n" released "$att" "$sha"
  else rr_state_set "$n" publish_pending "$att" "$sha"; fi
  rr_journal "$n" "$sha" released
  rr_notify "" 0 "Update $n is live: $title" "Update $n is live: $title. Released $(rr_epoch_to_iso "$(rr_now)"). The post for X is in the kit."
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
adopt_crashed() {
  local n stage sha
  for n in $(rr_sched_rows | cut -f1); do
    [ "$(rr_state_get "$n" 2)" = "in_progress" ] || continue
    stage=$(rr_journal_last "$n")
    sha=$(awk -v n="$n" '$2==n && $3!="-" { s=$3 } END { print s }' "$RR_JOURNAL")
    rr_log "update $n: adopting a crashed release (last stage: ${stage:-none})"
    case "$stage" in
      checked|publishing|published|publish_failed)
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
  adopt_crashed
  retry_owed_publish
  n=$(next_due)
  if [ -n "$n" ]; then release_one "$n"; else rr_log "pass: nothing due"; fi
  public_ci_tick
  if [ -n "$(rr_conf_get HEALTHCHECK_CMD)" ]; then rr_run HEALTHCHECK_CMD >/dev/null 2>&1 || true; fi
}
main "$@"
