#!/bin/bash
# Shared helpers for the server scripts. Sourced, never run. bash 3.2 compatible (macOS) and bash 5 (Debian).
# Every path is overridable by an env var so the tests can run the scripts in a scratch root.
# shellcheck disable=SC2034 # the lists below are used by the scripts that source this file

CAPSTAN_ETC="${CAPSTAN_ETC:-/etc/capstan}"
CAPSTAN_OPT="${CAPSTAN_OPT:-/opt/capstan}"
CAPSTAN_LOG="${CAPSTAN_LOG:-/var/log/capstan}"
CAPSTAN_BACKUPS="${CAPSTAN_BACKUPS:-/var/backups/capstan}"
CAPSTAN_SERVER_CONF="${CAPSTAN_SERVER_CONF:-$CAPSTAN_ETC/server.conf}"

# Services with their own Unix user, env file and /etc/capstan/<svc> folder (DECISIONS #20, PRIV-5).
CAPSTAN_SERVICES="api ws relay mcp workers facilitator anchor receipts"
# Restart order on deploy (workers first so migrations and jobs settle, edge services last).
CAPSTAN_RESTART_ORDER="workers anchor receipts relay api ws mcp facilitator"
# Services that hold a keystore.
CAPSTAN_KEY_SERVICES="receipts anchor facilitator"
# Relay flags (todo 30): global and per venue.
CAPSTAN_RELAY_FLAGS="RELAY_ENABLED HL_ENABLED LIGHTER_304_ENABLED LIGHTER_RH_ENABLED ASTER_ENABLED"

say() { printf '%s\n' "$*"; }
stage_skip() { say "skip: $*"; }
stage_done() { say "done: $*"; }
die() { printf '%s\n' "error: $*" >&2; exit 1; }

in_list() { # in_list word "a b c"
  case " $2 " in *" $1 "*) return 0 ;; esac
  return 1
}

require_root() {
  [ "${CAPSTAN_ALLOW_NONROOT:-0}" = "1" ] && return 0
  [ "$(id -u)" = "0" ] || die "run as root (sudo)"
}

# conf_get KEY [file]: value of KEY=value from a simple env file (no eval).
conf_get() {
  f="${2:-$CAPSTAN_SERVER_CONF}"
  [ -f "$f" ] || return 0
  /usr/bin/awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); v = $0 } END { if (v != "") print v }' "$f"
}

# conf_set KEY VALUE file: replace or append KEY=VALUE, keeping mode and owner. Prints nothing.
conf_set() {
  k="$1"; v="$2"; f="$3"
  [ -f "$f" ] || : > "$f"
  tmp="$f.tmp.$$"
  /usr/bin/awk -F= -v k="$k" -v v="$v" 'BEGIN { done = 0 } $1 == k { print k "=" v; done = 1; next } { print } END { if (!done) print k "=" v }' "$f" > "$tmp"
  /bin/cat "$tmp" > "$f"
  /bin/rm -f "$tmp"
}

# same_content src dst: true when dst exists and equals src byte for byte
same_content() { [ -f "$2" ] && /usr/bin/cmp -s "$1" "$2"; }

# install_file src dst mode owner:group label: copies only when the content or mode differs
install_file() {
  src="$1"; dst="$2"; mode="$3"; owner="$4"; label="$5"
  if same_content "$src" "$dst" && [ "$(stat_mode "$dst")" = "$mode" ] && [ "$(stat_owner "$dst")" = "$owner" ]; then
    stage_skip "$label"
    return 0
  fi
  /bin/mkdir -p "$(dirname "$dst")"
  /bin/cp "$src" "$dst.new.$$"
  /bin/chmod "$mode" "$dst.new.$$"
  chown_maybe "$owner" "$dst.new.$$"
  /bin/mv -f "$dst.new.$$" "$dst"
  stage_done "$label"
}

stat_mode() { /usr/bin/stat -c '%a' "$1" 2>/dev/null || /usr/bin/stat -f '%Lp' "$1"; }
stat_owner() { /usr/bin/stat -c '%U:%G' "$1" 2>/dev/null || /usr/bin/stat -f '%Su:%Sg' "$1"; }

chown_maybe() {
  [ "${CAPSTAN_NO_CHOWN:-0}" = "1" ] && return 0
  /bin/chown "$1" "$2"
}

# ensure_dir path mode owner:group label
ensure_dir() {
  d="$1"; mode="$2"; owner="$3"; label="$4"
  if [ -d "$d" ] && [ "$(stat_mode "$d")" = "$mode" ] && { [ "${CAPSTAN_NO_CHOWN:-0}" = "1" ] || [ "$(stat_owner "$d")" = "$owner" ]; }; then
    stage_skip "$label"
    return 0
  fi
  /bin/mkdir -p "$d"
  /bin/chmod "$mode" "$d"
  chown_maybe "$owner" "$d"
  stage_done "$label"
}

utc_now() { /bin/date -u '+%Y-%m-%dT%H:%M:%SZ'; }
