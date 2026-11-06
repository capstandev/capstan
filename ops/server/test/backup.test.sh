#!/bin/bash
# R6: backup then restore-test restores into a scratch database with the same row counts.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
T_NAME=roundtrip
dir="$(stage_copy)"
pg_ctlcluster 15 main start 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do runuser -u postgres -- pg_isready -q && break; sleep 1; done
P="runuser -u postgres -- psql -v ON_ERROR_STOP=1 -qAt"
$P -d postgres -c "DROP DATABASE IF EXISTS capstan;" -c "CREATE DATABASE capstan;" >/dev/null || fail "create db"
$P -d capstan >/dev/null <<'SQL' || fail "seed"
CREATE TABLE receipts (id text PRIMARY KEY, body jsonb NOT NULL);
CREATE TABLE usage_daily (day text, metric text, value numeric, PRIMARY KEY (day, metric));
CREATE TABLE empty_one (x int);
INSERT INTO receipts SELECT 'r' || g, jsonb_build_object('n', g) FROM generate_series(1, 1234) g;
INSERT INTO usage_daily SELECT '2026-11-0' || (g % 9 + 1), 'm' || g, g FROM generate_series(1, 77) g;
SQL
rm -rf /tmp/age && mkdir -p /tmp/age && age-keygen -o /tmp/age/id.txt 2>/dev/null
rcpt="$(grep -o 'age1[0-9a-z]*' /tmp/age/id.txt | head -n 1)"
/usr/local/sbin/capstan-config set AGE_RECIPIENT "$rcpt" >/dev/null || fail "set recipient"
export CAPSTAN_PG_DUMP_CMD="runuser -u postgres -- pg_dump -d capstan --format=custom --compress=6"
export CAPSTAN_PSQL_CMD="$P" CAPSTAN_PG_RESTORE_CMD="runuser -u postgres -- pg_restore --no-owner" CAPSTAN_ALERT_CMD="$SRC/test/fake-alert.sh"
rm -rf /var/backups/capstan/daily /var/backups/capstan/weekly
out="$(CAPSTAN_BACKUP_DATE=2026-11-08 CAPSTAN_BACKUP_WEEKDAY=7 /bin/bash "$dir/backup.sh" 2>&1)" || fail "backup: $out"
f=/var/backups/capstan/daily/capstan-2026-11-08.dump.age
[ -s "$f" ] || fail "no backup file"
assert_eq "$(stat -c '%a' "$f")" "600" "backup file mode"
head -c 21 "$f" | grep -q 'age-encryption.org/v1' || fail "backup is not age encrypted"
grep -q 'receipts' "$f" && fail "plaintext table name inside the encrypted file"
[ -f /var/backups/capstan/weekly/capstan-2026-11-08.dump.age ] || fail "Sunday copy missing in weekly/"
assert_contains "$(cat "$f.counts")" "public.receipts 1234 1234"
res="$(/bin/bash "$dir/restore-test.sh" --identity /tmp/age/id.txt 2>&1)" || fail "restore-test: $res"
assert_contains "$res" "restore-test: ok (3 tables, 1311 rows, same counts)"
assert_not_contains "$res" "AGE-SECRET-KEY"
# a restore that does not match the recorded counts fails
sed -i 's/public.receipts 1234 1234/public.receipts 1235 1235/' "$f.counts"
if /bin/bash "$dir/restore-test.sh" --identity /tmp/age/id.txt --file "$f" > /tmp/rt.out 2>&1; then fail "a count difference passed"; fi
assert_contains "$(cat /tmp/rt.out)" "DIFF public.receipts"
# the scratch database is always dropped
assert_eq "$($P -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = 'capstan_restore_test';")" "0" "scratch db dropped"
# retention: 14 daily files kept
for d in 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19; do : > "/var/backups/capstan/daily/capstan-2026-10-$d.dump.age"; done
CAPSTAN_BACKUP_DATE=2026-11-09 CAPSTAN_BACKUP_WEEKDAY=1 /bin/bash "$dir/backup.sh" >/dev/null 2>&1 || fail "second backup"
assert_eq "$(ls /var/backups/capstan/daily | grep -cE '\.dump\.age$')" "14" "daily files kept"
[ -f /var/backups/capstan/daily/capstan-2026-11-09.dump.age ] || fail "newest file pruned"
# a missing recipient refuses before dumping anything
/usr/local/sbin/capstan-config set AGE_RECIPIENT age1notakey >/dev/null 2>&1
if CAPSTAN_BACKUP_DATE=2026-11-10 /bin/bash "$dir/backup.sh" >/dev/null 2>&1; then fail "backup ran with a bad recipient"; fi
/usr/local/sbin/capstan-config set AGE_RECIPIENT "$rcpt" >/dev/null
pass
