#!/bin/bash
# Send one message to the internal team group. Title as $1, body on stdin. The token is read from a root-only env file
# and goes to curl in a config on stdin: never on a command line, never in a log. On failure only the title and length
# are logged (a wrapper that logged message text could leak invite codes).
# Usage: notify-telegram.sh "<title>" < body      |   notify-telegram.sh --test (writes NOTIFY_PROOF on success)
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
envf=$(rr_conf_get TELEGRAM_ENV /etc/capstan-release/telegram.env)
curl_bin=$(rr_conf_get CURL /usr/bin/curl)
api=$(rr_conf_get TELEGRAM_API https://api.telegram.org) # tests point it at a local stand-in Bot API
api="${api%/}"
read_env() { grep -E "^$1=" "$envf" 2>/dev/null | tail -n 1 | sed -E "s/^$1=//; s/^['\"]//; s/['\"]\$//"; }
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'; }
test_mode=0
if [ "${1:-}" = "--test" ]; then test_mode=1; title="Alert test"; body="This is how release alerts will look. Nothing is wrong."
else title="${1:?usage: notify-telegram.sh <title> < body}"; body=$(cat); fi
token=$(read_env TELEGRAM_BOT_TOKEN); chat=$(read_env TELEGRAM_CHAT_ID)
if [ -z "$token" ] || [ -z "$chat" ]; then rr_log "notify-telegram: no token or chat id in $envf ('$title' not sent)"; exit 3; fi
text="$title

$body"
text="${text:0:3800}"
if printf 'url = "%s/bot%s/sendMessage"\ndata-urlencode = "chat_id=%s"\ndata-urlencode = "text=%s"\nsilent\nshow-error\nfail\nmax-time = 20\n' \
  "$api" "$token" "$(esc "$chat")" "$(esc "$text")" | "$curl_bin" -K - -o /dev/null; then
  [ "$test_mode" = "1" ] && : > "$(rr_conf_get NOTIFY_PROOF "$RR_HOME/notify.proof")"
  exit 0
fi
rr_log "notify-telegram: send failed for '$title' (${#text} chars)"
exit 1
