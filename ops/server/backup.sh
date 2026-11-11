#!/bin/bash
# Daily encrypted database backup (installed as /usr/local/sbin/capstan-backup, run by capstan-backup.timer).
#   sudo capstan-backup            daily file; Sundays also go to weekly/
#   sudo capstan-backup --final    one extra file named final-<UTC time> (shutdown runbook)
# pg_dump custom format (compressed) piped into `age` for the public recipient in server.conf (AGE_RECIPIENT). The
# private age identity never lives on the server: the owner keeps it, and restore-test.sh asks for its path.
# Keeps 14 daily and 8 weekly files. Optional off-box copy to BACKUP_OFFBOX (an rsync target) when set.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
if [ -f "$here/lib.sh" ]; then . "$here/lib.sh"; else . /usr/local/lib/capstan/lib.sh; fi
AGE="${CAPSTAN_AGE:-/usr/bin/age}"
DUMP="${CAPSTAN_PG_DUMP_CMD:-/usr/bin/docker exec capstan-db-postgres pg_dump -U capstan -d capstan --format=custom --compress=6}"
PSQL="${CAPSTAN_PSQL_CMD:-/usr/bin/docker exec -i capstan-db-postgres psql -U capstan -v ON_ERROR_STOP=1 -qAt}"
SOURCE_DB="${CAPSTAN_SOURCE_DB:-capstan}"
TODAY="${CAPSTAN_BACKUP_DATE:-$(/bin/date -u '+%Y-%m-%d')}"
WEEKDAY="${CAPSTAN_BACKUP_WEEKDAY:-$(/bin/date -u '+%u')}"
KEEP_DAILY=14
KEEP_WEEKLY=8

require_root
rcpt="$(conf_get AGE_RECIPIENT)"
printf '%s' "$rcpt" | /bin/grep -qE '^age1[0-9a-z]{58}$' || die "AGE_RECIPIENT is not an age public key (sudo capstan-config set AGE_RECIPIENT age1...)"
/bin/mkdir -p "$CAPSTAN_BACKUPS/daily" "$CAPSTAN_BACKUPS/weekly"
/bin/chmod 700 "$CAPSTAN_BACKUPS" "$CAPSTAN_BACKUPS/daily" "$CAPSTAN_BACKUPS/weekly"
umask 077

fail() {
  ev="{\"kind\":\"backup.failed\",\"detail\":{\"step\":\"$1\"},\"ts\":\"$(utc_now)\"}"
  if [ -n "${CAPSTAN_ALERT_CMD:-}" ]; then "$CAPSTAN_ALERT_CMD" "$ev" || true
  elif [ -x /usr/bin/docker ]; then /usr/bin/docker exec capstan-db-redis redis-cli RPUSH capstan:ops-alert:queue "$ev" >/dev/null 2>&1 || true
  fi
  die "backup failed at $1"
}

if [ "${1:-}" = "--final" ]; then name="final-$(/bin/date -u '+%Y%m%dT%H%M%SZ')"; out="$CAPSTAN_BACKUPS/$name.dump.age"
else name="capstan-$TODAY"; out="$CAPSTAN_BACKUPS/daily/$name.dump.age"; fi
tmp="$out.partial"
# Row counts before and after the dump go into <file>.counts ("table min max"): restore-test.sh checks every
# restored table against it (min = max unless rows were written while the dump ran).
# shellcheck disable=SC2086
counts() {
  for t in $(printf '%s\n' "SELECT schemaname || '.' || tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE '\_timescaledb%' ORDER BY 1;" | $PSQL -d "$SOURCE_DB"); do
    printf '%s %s\n' "$t" "$(printf '%s\n' "SELECT count(*) FROM $t;" | $PSQL -d "$SOURCE_DB")"
  done
}
c1="$(counts)" || fail counts
# shellcheck disable=SC2086
if ! { $DUMP | "$AGE" -r "$rcpt" -o "$tmp"; }; then /bin/rm -f "$tmp"; fail dump; fi
[ -s "$tmp" ] || { /bin/rm -f "$tmp"; fail empty; }
c2="$(counts)" || fail counts
printf '%s\n' "$c1" | LC_ALL=C /usr/bin/sort > "$tmp.c1"; printf '%s\n' "$c2" | LC_ALL=C /usr/bin/sort > "$tmp.c2"
LC_ALL=C /usr/bin/join "$tmp.c1" "$tmp.c2" | /usr/bin/awk '{ lo = ($2 < $3) ? $2 : $3; hi = ($2 < $3) ? $3 : $2; print $1, lo, hi }' > "$out.counts"
/bin/rm -f "$tmp.c1" "$tmp.c2"
/bin/mv -f "$tmp" "$out"
say "backup: wrote $out ($(/usr/bin/wc -c < "$out" | /usr/bin/tr -d ' ') bytes)"
[ "${1:-}" = "--final" ] && exit 0

if [ "$WEEKDAY" = "7" ]; then /bin/cp -f "$out" "$CAPSTAN_BACKUPS/weekly/$name.dump.age"; /bin/cp -f "$out.counts" "$CAPSTAN_BACKUPS/weekly/$name.dump.age.counts"; fi
prune() { # dir keep
  # "|| true": an empty folder (weekly/ before the first Sunday) is not an error under pipefail
  /bin/ls -1 "$1" | { /bin/grep -E '^capstan-[0-9]{4}-[0-9]{2}-[0-9]{2}\.dump\.age$' || true; } | /usr/bin/sort -r | /usr/bin/tail -n +"$(($2 + 1))" | while IFS= read -r f; do /bin/rm -f "$1/$f" "$1/$f.counts"; done
}
prune "$CAPSTAN_BACKUPS/daily" "$KEEP_DAILY"
prune "$CAPSTAN_BACKUPS/weekly" "$KEEP_WEEKLY"

off="$(conf_get BACKUP_OFFBOX)"
if [ -n "$off" ]; then
  /usr/bin/rsync -a "$out" "$out.counts" "$off/" || fail offbox
  say "backup: copied to off-box target"
fi
