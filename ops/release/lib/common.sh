# Shared helpers for the release runner. Sourced, never run. Works with macOS bash 3.2 and Linux bash 5:
# no associative arrays, no mapfile, no negative array index, no empty-array expansion under set -u.
#
# Config: RR_CONF names a KEY=VALUE file. Values are read as text, never sourced, and one pair of surrounding quotes
# is stripped (a sourced file loses values with spaces; a quoted value broke a regex on an earlier runner).
# Command values (GATE_CMD, DEPLOY_CMD, ...) are split on spaces with globbing off: no quotes inside them.

RR_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RR_ROOT="$(cd "$RR_LIB_DIR/.." && pwd -P)"

# ---------- config ----------
rr_conf_get() { # rr_conf_get KEY [default]; the environment wins over the file (tests and the unit set some)
  local key="$1" def="${2:-}" envval line val
  eval "envval=\${$key-__unset__}"
  if [ "$envval" != "__unset__" ]; then printf '%s' "$envval"; return 0; fi
  if [ -n "${RR_CONF:-}" ] && [ -f "$RR_CONF" ]; then
    line=$(grep -E "^[[:space:]]*${key}=" "$RR_CONF" | tail -n 1 || true)
    if [ -n "$line" ]; then
      val="${line#*=}"
      val="${val%"${val##*[![:space:]]}"}"
      case "$val" in
        \"*\") val="${val#\"}"; val="${val%\"}" ;;
        \'*\') val="${val#\'}"; val="${val%\'}" ;;
      esac
      printf '%s' "$val"; return 0
    fi
  fi
  printf '%s' "$def"
}

rr_init() { # sets the paths every command uses
  RR_HOME=$(rr_conf_get RR_HOME /var/lib/capstan-release)
  RR_STATE="$RR_HOME/state.tsv"
  RR_JOURNAL="$RR_HOME/journal.log"
  RR_LOG="$RR_HOME/log/runner.log"
  RR_LOCK="$RR_HOME/run.lock"
  RR_SCHEDULE=$(rr_conf_get SCHEDULE "$RR_HOME/schedule.tsv")
  RR_PAUSE=$(rr_conf_get PAUSE_FILE "$RR_HOME/PAUSE")
  RR_FLAG=$(rr_conf_get FLAG_FILE /etc/capstan-release/ALLOW_REAL_DEPLOY)
  RR_WORK=$(rr_conf_get WORK_DIR "$RR_HOME/backend")
  umask 022
  rr_git_as_runner
  rr_mkdir "$RR_HOME/log"; rr_mkdir "$RR_HOME/notify"
  rr_exists "$RR_STATE" || : | rr_write "$RR_STATE"
  rr_exists "$RR_JOURNAL" || : | rr_write "$RR_JOURNAL"
}

# ---------- files in the runner-owned home (r3d-01) ----------
# RR_HOME belongs to the runner user, but sudo runs some wrappers as root (announce, ghrelease, notify, pause, status).
# A link the runner plants there (announce/update-05.txt -> /etc/sudoers.d/x, posters/x.png -> the token file) must
# never make root write or read another file. So every open of a path under RR_HOME goes through these helpers: as
# root they run as RUNNER_USER (runuser), so the kernel applies the runner's rights, and on every account they refuse a
# path that is, or sits under, a symlink inside RR_HOME. Root keeps its own work files in a root-owned mktemp dir.
rr_in_home() { case "$1" in "$RR_HOME"/*) return 0 ;; *) return 1 ;; esac; }
rr_nolink() { # 0 when no part of the path below RR_HOME is a symlink (paths outside RR_HOME pass)
  local p="$1"
  rr_in_home "$p" || return 0
  while [ "$p" != "$RR_HOME" ] && [ -n "$p" ]; do
    [ -L "$p" ] && return 1
    p="${p%/*}"
  done
  return 0
}
rr_home_op() { # rr_home_op path cmd args...: refuse links, then run cmd as the runner when root and path in RR_HOME
  local p="$1"; shift
  if ! rr_nolink "$p"; then echo "release: refused $p: a symlink in $RR_HOME" >&2; return 1; fi
  if [ "${RR_DROP:-0}" = "1" ] && rr_in_home "$p"; then command runuser -u "$RR_RUNNER" -- "$@"; else "$@"; fi
}
rr_write() { rr_home_op "$1" /bin/sh -c 'cat > "$1"' sh "$1"; }    # stdin -> file (truncate)
rr_append() { rr_home_op "$1" /bin/sh -c 'cat >> "$1"' sh "$1"; }  # stdin -> file (append)
rr_read() { # file -> stdout; only a regular file (a fifo or device is refused)
  rr_home_op "$1" /bin/sh -c '[ -f "$1" ] && [ ! -L "$1" ] && cat "$1"' sh "$1"
}
rr_exists() { rr_home_op "$1" /bin/sh -c '[ -f "$1" ] && [ ! -L "$1" ]' sh "$1" 2>/dev/null; }
rr_mkdir() { rr_home_op "$1" mkdir -p "$1"; }
rr_rm() { rr_home_op "$1" rm -rf "$1"; }

# Owner commands run as root (arm, set-times, build-schedule). git refuses a repository another user owns ("dubious
# ownership"): as root every git call on the work checkout failed, so arm.sh refused the schedule and its origins
# guard read no remotes at all (a stand-in origin passed). As root, git runs as the runner user instead; that also
# keeps root-owned files out of the checkout. Found by the container sandbox (ops/release/test/sandbox).
rr_git_as_runner() {
  RR_RUNNER=$(rr_conf_get RUNNER_USER "")
  if [ "$(id -u)" = "0" ] && [ -n "$RR_RUNNER" ] && id "$RR_RUNNER" >/dev/null 2>&1 && command -v runuser >/dev/null 2>&1; then
    git() { command runuser -u "$RR_RUNNER" -- git "$@"; }
    RR_DROP=1
  else
    RR_DROP=0
  fi
  return 0
}

# ---------- time (UTC only; no GNU or BSD date flags needed for the maths) ----------
rr_now() { if [ -n "${RR_NOW:-}" ]; then printf '%s' "$RR_NOW"; else date -u +%s; fi; }

rr_iso_to_epoch() { # 2026-11-20T01:30:00Z -> epoch; refuses anything that is not UTC with a Z
  local s="$1" y m d H M S era yoe doy doe days
  case "$s" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
    *) return 1 ;;
  esac
  y=$((10#${s:0:4})); m=$((10#${s:5:2})); d=$((10#${s:8:2}))
  H=$((10#${s:11:2})); M=$((10#${s:14:2})); S=$((10#${s:17:2}))
  if [ "$m" -lt 1 ] || [ "$m" -gt 12 ] || [ "$d" -lt 1 ] || [ "$d" -gt 31 ] || [ "$H" -gt 23 ] || [ "$M" -gt 59 ] || [ "$S" -gt 59 ]; then
    return 1
  fi
  [ "$m" -le 2 ] && y=$((y - 1))
  era=$(( (y >= 0 ? y : y - 399) / 400 ))
  yoe=$(( y - era * 400 ))
  doy=$(( (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1 ))
  doe=$(( yoe * 365 + yoe / 4 - yoe / 100 + doy ))
  days=$(( era * 146097 + doe - 719468 ))
  printf '%s' $(( days * 86400 + H * 3600 + M * 60 + S ))
}

rr_epoch_to_iso() { # epoch -> 2026-11-20T01:30:00Z
  local e="$1" z era doe yoe y doy mp d m sod
  z=$(( e / 86400 + 719468 )); sod=$(( e % 86400 ))
  era=$(( (z >= 0 ? z : z - 146096) / 146097 ))
  doe=$(( z - era * 146097 ))
  yoe=$(( (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365 ))
  y=$(( yoe + era * 400 ))
  doy=$(( doe - (365 * yoe + yoe / 4 - yoe / 100) ))
  mp=$(( (5 * doy + 2) / 153 ))
  d=$(( doy - (153 * mp + 2) / 5 + 1 ))
  m=$(( mp < 10 ? mp + 3 : mp - 9 ))
  [ "$m" -le 2 ] && y=$((y + 1))
  printf '%04d-%02d-%02dT%02d:%02d:%02dZ' "$y" "$m" "$d" $((sod / 3600)) $((sod % 3600 / 60)) $((sod % 60))
}

rr_local_time() { # rr_local_time epoch zone -> "2026-11-19 20:30 EST" in that zone (display only, never maths)
  local e="$1" zone="$2"
  if date -u -r 0 +%s >/dev/null 2>&1; then TZ="$zone" date -r "$e" '+%Y-%m-%d %H:%M %Z'
  else TZ="$zone" date -d "@$e" '+%Y-%m-%d %H:%M %Z'; fi
}

# ---------- log ----------
rr_log() { # one line per stage, UTC, to the runner log (and stderr when RR_VERBOSE=1)
  local line
  line="$(rr_epoch_to_iso "$(rr_now)") $*"
  printf '%s\n' "$line" | rr_append "$RR_LOG" 2>/dev/null || printf '%s\n' "$line" >&2
  [ "${RR_VERBOSE:-0}" = "1" ] && printf '%s\n' "$line" >&2
  return 0
}

# ---------- schedule.tsv: header lines "# key value", rows "n<TAB>slot_epoch<TAB>sha<TAB>title" ----------
rr_sched_header() { rr_read "$RR_SCHEDULE" | awk -v k="$1" '$1=="#" && $2==k { print $3; exit }'; }
rr_sched_rows() { rr_read "$RR_SCHEDULE" | grep -v '^#' | grep -v '^[[:space:]]*$' || true; }
rr_sched_field() { # rr_sched_field n col (1=n 2=slot 3=sha 4=title)
  rr_read "$RR_SCHEDULE" | awk -F '\t' -v n="$1" -v c="$2" '$1!~/^#/ && $1==n { print $c; exit }'
}

# ---------- state.tsv: "n<TAB>status<TAB>attempts<TAB>at<TAB>note"; a missing row means pending ----------
rr_state_get() { # rr_state_get n col (2=status 3=attempts 4=at 5=note)
  local v
  v=$(rr_read "$RR_STATE" | awk -F '\t' -v n="$1" -v c="$2" '$1==n { v=$c } END { print v }')
  if [ -z "$v" ] && [ "$2" = "2" ]; then v=pending; fi
  if [ -z "$v" ] && [ "$2" = "3" ]; then v=0; fi
  printf '%s' "$v"
}

rr_state_set() { # rr_state_set n status attempts note (atomic: temp file then mv)
  local n="$1" st="$2" att="$3" note="${4:-}" tmp
  tmp="$RR_STATE.tmp.$$"
  { rr_read "$RR_STATE" | awk -F '\t' -v n="$n" '$1!=n'
    printf '%s\t%s\t%s\t%s\t%s\n' "$n" "$st" "$att" "$(rr_now)" "$note"; } | sort -n -k1,1 | rr_write "$tmp" \
    && rr_home_op "$tmp" mv -f "$tmp" "$RR_STATE"
}

rr_count_status() { # how many schedule rows have this status
  local want="$1" n c=0
  for n in $(rr_sched_rows | cut -f1); do
    [ "$(rr_state_get "$n" 2)" = "$want" ] && c=$((c + 1))
  done
  printf '%s' "$c"
}

# ---------- journal: "epoch n sha stage" (lets the next pass adopt work a crash left half done) ----------
rr_journal() { printf '%s %s %s %s\n' "$(rr_now)" "$1" "$2" "$3" | rr_append "$RR_JOURNAL"; }
rr_journal_last() { rr_read "$RR_JOURNAL" | awk -v n="$1" '$2==n { s=$4 } END { print s }'; }

# ---------- commands from config ----------
rr_run() { # rr_run VAR args...: runs the configured command (split on spaces, no glob); 127 when unset
  local var="$1" cmd rc
  shift
  cmd=$(rr_conf_get "$var")
  if [ -z "$cmd" ]; then rr_log "config $var is not set"; return 127; fi
  set -f
  # shellcheck disable=SC2086
  $cmd "$@"
  rc=$?
  set +f
  return $rc
}

# ---------- real-deploy guard: the flag file AND the unit's environment, both, or nothing deploys ----------
rr_armed() { [ -f "$RR_FLAG" ] && [ "${CAPSTAN_RELEASE_RUNNER:-0}" = "1" ]; }

# ---------- lock: mkdir is atomic everywhere (no flock on macOS); a dead holder's lock is taken over ----------
rr_lock() {
  local holder
  if rr_home_op "$RR_LOCK" mkdir "$RR_LOCK" 2>/dev/null; then printf '%s\n' "$$" | rr_write "$RR_LOCK/pid"; return 0; fi
  holder=$(rr_read "$RR_LOCK/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then return 1; fi
  rr_log "lock: taking over a stale lock (holder ${holder:-unknown} is gone)"
  rr_rm "$RR_LOCK"
  rr_home_op "$RR_LOCK" mkdir "$RR_LOCK" 2>/dev/null || return 1
  printf '%s\n' "$$" | rr_write "$RR_LOCK/pid"
}
rr_unlock() { rr_rm "$RR_LOCK"; }

# ---------- notify: title as $1, body on stdin; log title and length only, never the text ----------
rr_notify() { # rr_notify key min_interval_s title body ; key "" = always send
  local key="$1" every="$2" title="$3" body="$4" stamp last now rc
  now=$(rr_now)
  if [ -n "$key" ]; then
    stamp="$RR_HOME/notify/$key"
    last=$(rr_read "$stamp" 2>/dev/null || true)
    if [ -n "$last" ] && [ $((now - last)) -lt "$every" ]; then rr_log "notify: '$title' skipped (key $key sent $((now - last)) s ago)"; return 0; fi
  fi
  rc=0; printf '%s' "$body" | rr_run NOTIFY_CMD "$title" || rc=$? # also safe under set -e
  if [ "$rc" -eq 0 ]; then
    [ -n "$key" ] && printf '%s\n' "$now" | rr_write "$stamp"
    [ -n "$key" ] && rr_exists "$RR_HOME/notify/owed/k-$key" && rr_rm "$RR_HOME/notify/owed/k-$key" # sent now: not owed
    rr_log "notify: sent '$title' (${#body} chars)"
  else
    rr_log "notify: FAILED '$title' (${#body} chars, rc $rc)"
    rr_notify_owe "$key" "$now" "$title" "$body"
  fi
  return 0
}
rr_notify_clear() { rr_home_op "$RR_HOME/notify/$1" rm -f "$RR_HOME/notify/$1"; }

# ---------- owed alerts: an alert NOTIFY_CMD could not send (Telegram down) is resent on a later pass ----------
# Stress 2026-11-11: such alerts were logged "notify: FAILED" and lost. Now each one is kept in notify/owed/ (line 1
# epoch, line 2 title, then the body; runner-owned files through the rr_* helpers) and rr_notify_retry_owed sends it
# once, oldest first, on the next pass that reaches Telegram. A keyed alert is owed at most once per key (the newest
# wins, and a later successful send of the same key clears it). At most RR_OWED_MAX are kept; the oldest go first.
RR_OWED_MAX=50
rr_notify_owe() { # rr_notify_owe key epoch title body
  local key="$1" at="$2" title="$3" body="$4" dir="$RR_HOME/notify/owed" f
  rr_mkdir "$dir" || return 0
  if [ -n "$key" ]; then f="$dir/k-$key"; else f="$dir/a-$at-$$-$RANDOM"; fi
  printf '%s\n%s\n%s' "$at" "$(printf '%s' "$title" | tr '\n' ' ')" "$body" | rr_write "$f" || return 0
  rr_log "notify: owed '$title' (resent on a later pass)"
  rr_notify_owed_list | sed -n "$((RR_OWED_MAX + 1)),\$p" | while IFS=' ' read -r _ old; do
    rr_rm "$dir/$old"; rr_log "notify: dropped owed alert $old (more than $RR_OWED_MAX owed)"
  done
}
rr_notify_owed_list() { # "epoch file" per owed alert, newest first
  local dir="$RR_HOME/notify/owed" f at
  [ -d "$dir" ] || return 0
  for f in $(rr_home_op "$dir" ls "$dir" 2>/dev/null); do
    case "$f" in k-*|a-*) ;; *) continue ;; esac
    at=$(rr_read "$dir/$f" 2>/dev/null | sed -n 1p)
    case "$at" in ''|*[!0-9]*) continue ;; esac
    printf '%s %s\n' "$at" "$f"
  done | sort -rn
}
rr_notify_retry_owed() { # oldest first; stops at the first failure (Telegram still down) and keeps the rest owed
  local dir="$RR_HOME/notify/owed" at f text title body key
  for f in $(rr_notify_owed_list | sort -n | awk '{ print $2 }'); do
    text=$(rr_read "$dir/$f" 2>/dev/null) || continue
    at=$(printf '%s\n' "$text" | sed -n 1p); title=$(printf '%s\n' "$text" | sed -n 2p); body=$(printf '%s\n' "$text" | sed '1,2d')
    body="$body

(Sent late: Telegram could not be reached at $(rr_epoch_to_iso "$at").)"
    if printf '%s' "$body" | rr_run NOTIFY_CMD "$title"; then
      rr_rm "$dir/$f"
      case "$f" in k-*) key=${f#k-}; printf '%s\n' "$(rr_now)" | rr_write "$RR_HOME/notify/$key" ;; esac
      rr_log "notify: resent owed '$title' (from $(rr_epoch_to_iso "$at"))"
    else
      rr_log "notify: owed '$title' still not sent (next pass tries again)"; return 0
    fi
  done
  return 0
}

# rr_carries dir sha: 0 when HEAD in dir carries the update: sha is an ancestor and no later revert took it out (a
# rollback reverts a fast-forwarded update, which leaves its sha an ancestor of main with its changes gone).
rr_carries() {
  local dir="$1" sha="$2"
  git -C "$dir" merge-base --is-ancestor "$sha" HEAD 2>/dev/null || return 1
  [ -n "$(git -C "$dir" log --format=%H --grep="This reverts commit $sha" "$sha..HEAD" 2>/dev/null)" ] || return 0
  git -C "$dir" diff "$sha^" "$sha" | git -C "$dir" apply --check -R --cached >/dev/null 2>&1
}

rr_title_of() { rr_sched_field "$1" 4; }
rr_tag_of() { printf 'update-%02d' "$((10#$1))"; }

# When an owner command runs as root (arm, set-times, retry), hand the runner's files back to the runner user, or the
# next pass (as that user) could not write the files root just made.
rr_fix_owner() {
  local user
  user=$(rr_conf_get RUNNER_USER "")
  if [ -n "$user" ] && [ "$(id -u)" = "0" ]; then chown -R "$user:" "$RR_HOME"; fi
  return 0
}
