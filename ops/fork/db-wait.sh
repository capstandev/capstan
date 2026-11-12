#!/bin/bash
# Sourced by ops/fork/up.sh (macOS bash 3.2 safe). `docker compose up --wait` returns as soon as the Postgres health
# check passes once, and the server can still answer "the database system is starting up" for a few seconds after
# that. So the first database call (the migration) runs in a bounded retry loop, never once.
# retry_cmd <tries> <seconds between tries> <log file> <command...>
# Returns 0 on the first try that succeeds, 1 when every try failed. Each try's output is appended to the log.
retry_cmd() {
  _rc_tries="$1"; _rc_sleep="$2"; _rc_log="$3"; shift 3
  case "$_rc_tries" in ''|*[!0-9]*|0) echo "fail: retry_cmd needs a positive try count, got '$_rc_tries'"; return 2 ;; esac
  : > "$_rc_log"
  _rc_i=1
  while :; do
    echo "--- try $_rc_i of $_rc_tries" >> "$_rc_log"
    if "$@" >> "$_rc_log" 2>&1; then
      [ "$_rc_i" -gt 1 ] && echo "note: succeeded on try $_rc_i of $_rc_tries"
      return 0
    fi
    [ "$_rc_i" -ge "$_rc_tries" ] && return 1
    echo "wait: try $_rc_i of $_rc_tries failed ($(grep -v '^--- try ' "$_rc_log" | tail -1 | cut -c1-160)); next try in ${_rc_sleep}s"
    _rc_i=$((_rc_i + 1))
    sleep "$_rc_sleep"
  done
}
