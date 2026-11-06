#!/bin/bash
# Prove a backup restores (installed as /usr/local/sbin/capstan-restore-test). Owner-run:
#   sudo capstan-restore-test --identity <path to the age identity file> [--file <backup .dump.age>]
# Decrypts the newest daily backup (or --file) into a scratch database, compares the row count of every table with
# the counts recorded when the backup was made (<file>.counts), drops the scratch database, and prints one line per stage. Exit 1 on any difference.
# The identity file is read by age only; this script never prints it. Bring it on a USB stick or scp it for the
# test and delete it afterwards.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
if [ -f "$here/lib.sh" ]; then . "$here/lib.sh"; else . /usr/local/lib/capstan/lib.sh; fi
AGE="${CAPSTAN_AGE:-/usr/bin/age}"
PSQL="${CAPSTAN_PSQL_CMD:-/usr/bin/docker exec -i capstan-db-postgres psql -U capstan -v ON_ERROR_STOP=1 -qAt}"
RESTORE="${CAPSTAN_PG_RESTORE_CMD:-/usr/bin/docker exec -i capstan-db-postgres pg_restore -U capstan --no-owner}"
SOURCE_DB="${CAPSTAN_SOURCE_DB:-capstan}"
SCRATCH="capstan_restore_test"

idf=""; file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --identity) idf="${2:-}"; shift 2 ;;
    --file) file="${2:-}"; shift 2 ;;
    *) die "usage: capstan-restore-test --identity <file> [--file <backup>]" ;;
  esac
done
require_root
[ -f "$idf" ] || die "identity file not found"
if [ -z "$file" ]; then file="$(/bin/ls -1 "$CAPSTAN_BACKUPS"/daily/capstan-*.dump.age 2>/dev/null | /usr/bin/sort | /usr/bin/tail -n 1)"; fi
[ -f "$file" ] || die "no backup file found"
say "restore-test: file $(basename "$file")"

# shellcheck disable=SC2086
q() { printf '%s\n' "$2" | $PSQL -d "$1"; }
q postgres "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null
q postgres "CREATE DATABASE $SCRATCH;" >/dev/null
cleanup() { q postgres "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null 2>&1 || true; }
trap cleanup EXIT
ts="$(q "$SOURCE_DB" "SELECT count(*) FROM pg_extension WHERE extname = 'timescaledb';")"
if [ "$ts" = "1" ]; then q "$SCRATCH" "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();" >/dev/null; fi
# shellcheck disable=SC2086
"$AGE" -d -i "$idf" "$file" | $RESTORE -d "$SCRATCH"
if [ "$ts" = "1" ]; then q "$SCRATCH" "SELECT timescaledb_post_restore();" >/dev/null; fi
say "restore-test: restored into $SCRATCH"

# compare with the counts recorded at backup time (<file>.counts: "table min max")
[ -f "$file.counts" ] || die "no $file.counts next to the backup"
n=0; rows=0; bad=0
while read -r t lo hi; do
  [ -n "$t" ] || continue
  b="$(q "$SCRATCH" "SELECT count(*) FROM $t;" 2>/dev/null || echo missing)"
  n=$((n + 1))
  if [ "$b" = "missing" ] || [ "$b" -lt "$lo" ] || [ "$b" -gt "$hi" ]; then say "restore-test: DIFF $t backup=$lo..$hi restored=$b"; bad=$((bad + 1)); else rows=$((rows + b)); fi
done < "$file.counts"
[ "$n" -gt 0 ] || die "no tables in $file.counts"
if [ "$bad" -gt 0 ]; then say "restore-test: FAILED ($bad of $n tables differ)"; exit 1; fi
say "restore-test: ok ($n tables, $rows rows, same counts)"
