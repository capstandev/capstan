#!/usr/bin/env bash
# Installs the Capstan team bot on the server from this Mac. Idempotent: run it again after any change.
# It copies the program, the unit file, the captions, contracts.json (from web/public) and any demo videos found in
# VIDEOS_DIR (only the ones that changed), keeps an existing known.md and teambot.env, then enables and restarts
# capstan-teambot.service. It never reads or prints a token or key: the server-side check only says whether they
# are present. The bot reads the runner's token file /etc/capstan-release/telegram.env (install the runner first).
# Usage: bash install.sh user@host [--known] [--skip-tests]
#        --known       also replace the server's /etc/capstan-teambot/known.md with the local one
#        --skip-tests  do not run the local tests first
#        VIDEOS_DIR=<dir with desktop/ and phone/ capstan-NN-*.mp4>  (optional; none is fine before the videos exist)
set -euo pipefail
HOST=""; KNOWN=0; TESTS=1
for a in "$@"; do
  case "$a" in
    --known) KNOWN=1 ;;
    --skip-tests) TESTS=0 ;;
    -*) echo "unknown option $a"; exit 2 ;;
    *) HOST="$a" ;;
  esac
done
[[ -n "$HOST" ]] || { echo "usage: bash install.sh user@host [--known] [--skip-tests]"; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VIDEOS="${VIDEOS_DIR:-}"
SOCK="$(mktemp -u "${TMPDIR:-/tmp}/teambot-ssh.XXXXXX")"
SSH=(ssh -o ControlMaster=auto -o ControlPath="$SOCK" -o ControlPersist=120)
SCP=(scp -q -o ControlMaster=auto -o ControlPath="$SOCK" -o ControlPersist=120)
trap '"${SSH[@]}" -O exit "$HOST" >/dev/null 2>&1 || true' EXIT
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }

# 1. local checks
python3 -m py_compile "$HERE/teambot.py" && pass "teambot.py compiles"
if [[ $TESTS == 1 ]]; then
  if out="$(cd "$ROOT" && python3 -m unittest discover -s ops/teambot/tests -t . 2>&1)"; then
    pass "local tests ($(grep -oE '^Ran [0-9]+ tests' <<<"$out"))"
  else
    fail "local tests (run: cd $ROOT && python3 -m unittest discover -s ops/teambot/tests -t .)"
  fi
fi
[[ -f "$ROOT/web/public/contracts.json" ]] || fail "web/public/contracts.json missing"

# 2. folders
"${SSH[@]}" "$HOST" 'set -e
install -d -m 0700 /etc/capstan-teambot
install -d -m 0700 /var/lib/capstan-teambot /var/lib/capstan-teambot/videos /var/lib/capstan-teambot/videos/desktop /var/lib/capstan-teambot/videos/phone
[ -e /etc/capstan-teambot/teambot.env ] || install -m 0600 /dev/null /etc/capstan-teambot/teambot.env
chmod 0600 /etc/capstan-teambot/teambot.env
command -v curl >/dev/null && command -v python3 >/dev/null' || fail "server folders (or curl/python3 missing)"
pass "server folders ready on $HOST"

# 3. program, unit, captions, contracts, known.md
"${SCP[@]}" "$HERE/teambot.py" "$HOST:/usr/local/sbin/teambot.new"
"${SSH[@]}" "$HOST" 'set -e; chown root:root /usr/local/sbin/teambot.new; chmod 0755 /usr/local/sbin/teambot.new
mv -f /usr/local/sbin/teambot.new /usr/local/sbin/teambot'
pass "program at /usr/local/sbin/teambot"
"${SCP[@]}" "$HERE/capstan-teambot.service" "$HOST:/etc/systemd/system/capstan-teambot.service"
"${SCP[@]}" "$HERE/captions.json" "$HOST:/var/lib/capstan-teambot/captions.json"
"${SCP[@]}" "$ROOT/web/public/contracts.json" "$HOST:/var/lib/capstan-teambot/contracts.json"
"${SSH[@]}" "$HOST" 'chmod 0644 /etc/systemd/system/capstan-teambot.service; chmod 0600 /var/lib/capstan-teambot/captions.json /var/lib/capstan-teambot/contracts.json'
pass "unit file, captions and contracts.json"
if [[ $KNOWN == 1 ]] || ! "${SSH[@]}" "$HOST" 'test -e /etc/capstan-teambot/known.md'; then
  "${SCP[@]}" "$HERE/known.md" "$HOST:/etc/capstan-teambot/known.md"
  "${SSH[@]}" "$HOST" 'chmod 0644 /etc/capstan-teambot/known.md'
  pass "known.md copied"
else
  pass "known.md kept as it is on the server (pass --known to replace it)"
fi

# 4. videos (only the changed ones)
if [[ -n "$VIDEOS" ]]; then
  remote_sums="$("${SSH[@]}" "$HOST" 'cd /var/lib/capstan-teambot/videos && find . -name "*.mp4" -type f -exec sha256sum {} + 2>/dev/null || true')"
  copied=0; same=0
  for kind in desktop phone; do
    for f in "$VIDEOS/$kind"/capstan-[0-9][0-9]-*.mp4; do
      [[ -e "$f" ]] || continue
      b="$(basename "$f")"; sum="$(shasum -a 256 "$f" | cut -d' ' -f1)"
      if grep -q "^$sum  ./$kind/$b\$" <<<"$remote_sums"; then same=$((same + 1)); continue; fi
      "${SCP[@]}" "$f" "$HOST:/var/lib/capstan-teambot/videos/$kind/$b"
      copied=$((copied + 1))
    done
  done
  "${SSH[@]}" "$HOST" 'chmod 0600 /var/lib/capstan-teambot/videos/*/*.mp4 2>/dev/null || true'
  pass "videos: $copied copied, $same already there"
else
  echo "INFO no VIDEOS_DIR given: /videos answers that the videos are not on the server yet"
fi

# 5. service
"${SSH[@]}" "$HOST" 'set -e; systemctl daemon-reload; systemctl enable capstan-teambot.service >/dev/null 2>&1; systemctl restart capstan-teambot.service'
sleep 6
"${SSH[@]}" "$HOST" 'systemctl is-active --quiet capstan-teambot.service' && pass "capstan-teambot.service is active" \
  || fail "service not active (look: journalctl -u capstan-teambot -n 30)"
"${SSH[@]}" "$HOST" 'systemctl is-enabled --quiet capstan-teambot.service' && pass "capstan-teambot.service starts at boot"
if "${SSH[@]}" "$HOST" 'journalctl -u capstan-teambot --since "-2 min" --no-pager -o cat | grep -q "event=started"'; then
  pass "bot started and is polling"
else
  echo "WARN no 'started' line yet (journalctl -u capstan-teambot -n 30)"
fi
"${SSH[@]}" "$HOST" 'journalctl -u capstan-teambot --since "-2 min" --no-pager -o cat | grep -q Traceback' \
  && fail "a Python error is in the log (journalctl -u capstan-teambot -n 50)" || pass "no Python errors in the log"

# 6. setup check on the server (PASS/FAIL lines only, no secrets)
"${SSH[@]}" "$HOST" '/usr/local/sbin/teambot check --live' || echo "WARN some checks failed (see the FAIL lines above)"
echo "done. Owner id: bash $HERE/set-keys.sh $HOST"
