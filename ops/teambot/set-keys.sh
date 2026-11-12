#!/usr/bin/env bash
# Owner script: saves OWNER_TELEGRAM_ID into /etc/capstan-teambot/teambot.env on the server (root:capstan-teambot 0640), then restarts
# the team bot. The prompt is hidden (nothing echoes on screen) and the value goes over ssh stdin, never on a command
# line or in shell history. Other lines in the file are kept.
# Your id: send /whoami in the team group once the bot runs (it answers "Your Telegram id is N").
# Usage: bash set-keys.sh user@host
#        TEAMBOT_SET_KEYS_DRY=<dir> bash set-keys.sh   (test: writes <dir>/teambot.env, no ssh, no restart)
set -euo pipefail
HOST="${1:-}"
DRY="${TEAMBOT_SET_KEYS_DRY:-}"
[[ -n "$HOST" || -n "$DRY" ]] || { echo "usage: bash set-keys.sh user@host"; exit 2; }
ask() { # ask VAR "label": hidden prompt, typed twice
  local a b
  read -r -s -p "$2: " a; echo
  read -r -s -p "$2 again: " b; echo
  [[ "$a" == "$b" ]] || { echo "FAIL the two entries differ; nothing saved"; exit 1; }
  printf -v "$1" '%s' "$a"
}
ask OWNER "OWNER_TELEGRAM_ID (digits, from /whoami; hidden)"
OWNER="$(printf '%s' "$OWNER" | tr -d ' \r')"
[[ "$OWNER" =~ ^[0-9]{3,20}$ ]] || { echo "FAIL that is not a Telegram user id (digits only); nothing saved"; exit 1; }
REMOTE='set -e
umask 077
d="${TEAMBOT_DIR:-/etc/capstan-teambot}"
# the bot runs as capstan-teambot (G4-02): on the server it reads this file through its group, nobody else can
g=""; [ "$(id -u)" = 0 ] && getent group capstan-teambot >/dev/null 2>&1 && g=capstan-teambot
if [ -n "$g" ]; then install -d -m 0750 -o root -g "$g" "$d"; else install -d -m 0700 "$d"; fi
f="$d/teambot.env"
touch "$f"
IFS= read -r line
{ grep -v "^OWNER_TELEGRAM_ID=" "$f" || true; printf "%s\n" "$line"; } > "$f.new"
if [ -n "$g" ]; then chown "root:$g" "$f.new"; chmod 0640 "$f.new"; else chmod 0600 "$f.new"; [ "$(id -u)" = 0 ] && chown root:root "$f.new"; fi
mv -f "$f.new" "$f"
if [ -z "${TEAMBOT_DIR:-}" ]; then systemctl restart capstan-teambot.service; sleep 3; systemctl is-active --quiet capstan-teambot.service; fi'
if [[ -n "$DRY" ]]; then
  printf 'OWNER_TELEGRAM_ID=%s\n' "$OWNER" | TEAMBOT_DIR="$DRY" bash -c "$REMOTE"
  echo "PASS OWNER_TELEGRAM_ID saved in $DRY/teambot.env (0600, dry run)"
  exit 0
fi
printf 'OWNER_TELEGRAM_ID=%s\n' "$OWNER" | ssh "$HOST" "$REMOTE"
echo "PASS OWNER_TELEGRAM_ID saved on $HOST (root:capstan-teambot 0640) and the bot restarted"
ssh "$HOST" '/usr/local/sbin/teambot check' | grep -E "OWNER_TELEGRAM_ID" || true
