#!/bin/bash
# Post one released update to the internal team group: its poster with the plain-text notes as the caption
# (sendPhoto), and the text past Telegram's 1,024-character caption limit as follow-up messages (sendMessage, at most
# 4,000 each). Each call is retried with backoff (Telegram's retry_after on a 429). When no poster is staged, or the
# upload keeps failing, the post goes out as text only with a "Poster missing" line. Exit 0 only when every part
# reached the group, so the runner never marks a release announced before the post went out.
#
# Usage: announce-telegram.sh [--dry-run] <tag> "<title>" < notes
#   Poster: $RR_HOME/posters/<tag>.png, staged by the runner (the same file ghrelease.sh attaches).
#   Progress: $RR_HOME/announce/<tag>.{txt,parts,done}. The text is saved on the first try and reused, and a part that
#   went out is never sent twice, so a retry after a crash or a 5xx posts only what is still missing.
#   --dry-run sends nothing and needs no token: it writes the parts it would send to $RR_HOME/announce/<tag>.dry/
#   and prints the plan (methods and lengths only).
# Exit: 0 posted (or already posted), 1 a part failed after its retries (try again later), 2 bad arguments,
#   3 no token or chat id, 4 not armed (no flag file: nothing sent).
# The token is read from the root-only env file and goes to curl in a config on stdin: never on a command line, never
# in a log. Logs carry the tag, method, lengths and answer codes, never the text.
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
export LC_ALL=C # lengths and cuts in bytes: a byte count is never under Telegram's character count
CAPTION_MAX=1024
MESSAGE_MAX=$(rr_conf_get ANNOUNCE_MESSAGE_MAX 4000)
tries=$(rr_conf_get ANNOUNCE_TRIES 4)
backoff=$(rr_conf_get ANNOUNCE_BACKOFF_S 2)
maxwait=$(rr_conf_get ANNOUNCE_BACKOFF_MAX_S 60)
maxt=$(rr_conf_get ANNOUNCE_MAX_TIME_S 60)
envf=$(rr_conf_get TELEGRAM_ENV /etc/capstan-release/telegram.env)
curl_bin=$(rr_conf_get CURL /usr/bin/curl)
api=$(rr_conf_get TELEGRAM_API https://api.telegram.org); api="${api%/}"
nl='
'
read_env() { grep -E "^$1=" "$envf" 2>/dev/null | tail -n 1 | sed -E "s/^$1=//; s/^['\"]//; s/['\"]\$//"; }
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'; }

dry=0
[ "${1:-}" = "--dry-run" ] && { dry=1; shift; }
tag="${1:-}"; title="${2:-}"
case "$tag" in update-[0-9][0-9]|bonus-[0-9][0-9]|fix-20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]-*) ;; *) echo "announce: bad tag" >&2; exit 2 ;; esac
case "$tag" in *[!A-Za-z0-9-]*) echo "announce: bad tag" >&2; exit 2 ;; esac
[ -n "$title" ] || { echo "usage: announce-telegram.sh [--dry-run] <tag> <title> < notes" >&2; exit 2; }

A="$RR_HOME/announce"; mkdir -p "$A"
poster="$RR_HOME/posters/$tag.png"
text_f="$A/$tag.txt"; parts_f="$A/$tag.parts"; done_f="$A/$tag.done"
if [ -f "$done_f" ]; then echo "announce: $tag already posted"; exit 0; fi

notes=""; [ -t 0 ] || notes=$(head -c 60000)
if [ -f "$text_f" ]; then text=$(cat "$text_f") # a retry posts the text of the first try, byte for byte
else
  text="$title"; [ -n "$notes" ] && text="$title

$notes"
  [ "$dry" = "1" ] || printf '%s' "$text" > "$text_f"
fi

# cut_text limit: CUT_HEAD gets at most <limit> bytes from the front of CUT_REST, cut at a line end (or a space) in
# the second half of the window when there is one; CUT_REST keeps the rest without its leading blanks.
cut_text() {
  local lim="$1" s="$CUT_REST" head c
  if [ "${#s}" -le "$lim" ]; then CUT_HEAD="$s"; CUT_REST=""; return 0; fi
  head="${s:0:$lim}"
  c="${head%"$nl"*}"
  if [ "$c" = "$head" ] || [ "${#c}" -lt $((lim / 2)) ]; then c="${head% *}"; fi
  if [ "$c" = "$head" ] || [ "${#c}" -lt $((lim / 2)) ]; then c="$head"; fi
  CUT_REST="${s:${#c}}"
  CUT_REST="${CUT_REST#"${CUT_REST%%[![:space:]]*}"}"
  CUT_HEAD="${c%"${c##*[![:space:]]}"}"
}

# plan mode reason: fills CAPTION (photo mode) and MSG_1..MSG_<MSG_N> from the saved text.
plan() {
  local i=0
  CAPTION=""; CUT_REST="$text"
  if [ "$1" = "photo" ]; then cut_text "$CAPTION_MAX"; CAPTION="$CUT_HEAD"
  else CUT_REST="$text

Poster missing: $2. This post is text only."; fi
  while [ -n "$CUT_REST" ]; do
    cut_text "$MESSAGE_MAX"; i=$((i + 1)); eval "MSG_$i=\$CUT_HEAD"
  done
  MSG_N=$i
}

# Where an earlier try stopped: "photo" once the poster went out, "text <reason>" once a text-only part went out.
mode=""; reason=""
if grep -qx photo "$parts_f" 2>/dev/null; then mode=photo
elif grep -q '^text ' "$parts_f" 2>/dev/null; then mode=text; reason=$(sed -n 's/^text //p' "$parts_f" | head -n 1)
elif [ -s "$poster" ]; then mode=photo
else mode=text; reason="no poster was staged for $tag"; fi

if [ "$dry" = "1" ]; then
  D="$A/$tag.dry"; rm -rf "$D"; mkdir -p "$D"
  plan "$mode" "$reason"
  if [ -n "$(read_env TELEGRAM_BOT_TOKEN)" ] && [ -n "$(read_env TELEGRAM_CHAT_ID)" ]; then tk=set; else tk=missing; fi
  if [ "$mode" = "photo" ]; then
    printf '%s' "$CAPTION" > "$D/caption.txt"
    out="dry run: $tag: sendPhoto posters/$tag.png ($(wc -c < "$poster" | tr -d ' ') bytes) with a ${#CAPTION}-char caption"
  else out="dry run: $tag: poster missing ($reason), text only"; fi
  i=1; lens=""
  while [ "$i" -le "$MSG_N" ]; do eval "m=\$MSG_$i"; printf '%s' "$m" > "$D/message-$i.txt"; lens="$lens ${#m}"; i=$((i + 1)); done
  echo "$out, then $MSG_N sendMessage (lengths:${lens:- none}); token $tk; nothing sent"
  rr_log "announce: dry run for $tag ($mode, $MSG_N messages); nothing sent"
  exit 0
fi

# The pass checks both guards before it calls this; sudo drops the unit's environment, so here the flag file decides.
if [ ! -f "$RR_FLAG" ]; then rr_log "announce: $tag not armed (no flag file); nothing sent"; echo "announce: not armed; nothing sent" >&2; exit 4; fi
token=$(read_env TELEGRAM_BOT_TOKEN); chat=$(read_env TELEGRAM_CHAT_ID)
if [ -z "$token" ] || [ -z "$chat" ]; then rr_log "announce: no token or chat id in $envf ($tag not posted)"; exit 3; fi
W=$(mktemp -d "${TMPDIR:-/tmp}/rr-announce.XXXXXX"); trap 'case "$W" in */rr-announce.*) rm -rf "$W" ;; esac' EXIT

post() { # post method text: one call; prints the HTTP code (000 when nothing answered)
  { printf 'url = "%s/bot%s/%s"\nsilent\nmax-time = %s\nwrite-out = "%%{http_code}"\n' "$api" "$token" "$1" "$maxt"
    if [ "$1" = "sendPhoto" ]; then
      printf 'form-string = "chat_id=%s"\nform-string = "caption=%s"\nform = "photo=@\\"%s\\";type=image/png"\n' "$(esc "$chat")" "$(esc "$2")" "$(esc "$poster")"
    else
      printf 'data-urlencode = "chat_id=%s"\ndata-urlencode = "text=%s"\n' "$(esc "$chat")" "$(esc "$2")"
    fi
  } | "$curl_bin" -K - -o "$W/resp" 2>/dev/null
}

send() { # send method text label: 0 delivered, 1 failed after its tries, 2 refused (a 4xx other than 429: no retry)
  local i=1 code wait k
  while :; do
    : > "$W/resp"
    code=$(post "$1" "$2") || true
    case "$code" in [0-9][0-9][0-9]) ;; *) code=000 ;; esac
    LAST_CODE="$code"
    case "$code" in 2??) rr_log "announce: $tag $3 sent ($1, ${#2} chars, try $i)"; return 0 ;; esac
    if [ "$code" = "429" ]; then
      wait=$(grep -o '"retry_after": *[0-9]*' "$W/resp" | head -n 1 | tr -dc '0-9'); [ -n "$wait" ] || wait="$backoff"
    elif [ "$code" -ge 400 ] && [ "$code" -lt 500 ]; then
      rr_log "announce: $tag $3 refused ($1, answer $code); not retried"; return 2
    else
      wait="$backoff"; k=1; while [ "$k" -lt "$i" ]; do wait=$((wait * 2)); k=$((k + 1)); done
    fi
    [ "$wait" -gt "$maxwait" ] && wait="$maxwait"
    if [ "$i" -ge "$tries" ]; then rr_log "announce: $tag $3 failed after $i tries ($1, last answer $code)"; return 1; fi
    rr_log "announce: $tag $3 answer $code (try $i of $tries); waiting $wait s"
    sleep "$wait"; i=$((i + 1))
  done
}

if [ "$mode" = "photo" ] && ! grep -qx photo "$parts_f" 2>/dev/null; then
  plan photo ""
  if send sendPhoto "$CAPTION" poster; then echo photo >> "$parts_f"
  else
    mode=text; reason="the poster upload failed (answer $LAST_CODE)"
    rr_log "announce: $tag poster not posted; falling back to text only"
  fi
fi
plan "$mode" "$reason"
i=1
while [ "$i" -le "$MSG_N" ]; do
  if ! grep -qx "msg $i" "$parts_f" 2>/dev/null; then
    eval "m=\$MSG_$i"
    send sendMessage "$m" "message $i of $MSG_N" || { echo "announce: $tag message $i of $MSG_N not posted" >&2; exit 1; }
    if [ "$mode" = "text" ] && ! grep -q '^text ' "$parts_f" 2>/dev/null; then printf 'text %s\n' "$reason" >> "$parts_f"; fi
    echo "msg $i" >> "$parts_f"
  fi
  i=$((i + 1))
done
: > "$done_f"
rr_log "announce: $tag posted ($mode, $MSG_N follow-up messages)"
echo "announce: $tag posted ($mode, $MSG_N messages)"
exit 0
