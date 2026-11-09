#!/bin/bash
# Probe every monitor in ops/uptime/monitors.json the way the outside monitor does, and print PASS or FAIL per
# monitor plus one summary line. Exit 0 when all pass, 1 when any fails, 2 on a usage or setup error.
#   ops/uptime/check.sh            probe the public URLs (https://get-capstan.com, https://api.get-capstan.com)
#   ops/uptime/check.sh --list     print "<id> <url>" per monitor, no network
# Environment:
#   CAPSTAN_UPTIME_SITE_BASE, CAPSTAN_UPTIME_API_BASE   replace the site and api bases (a local stack, for tests)
#   CAPSTAN_UPTIME_LOCAL_ONLY=1    refuse any URL that is not 127.0.0.1 or localhost (tests set it: no outside calls)
#   CAPSTAN_UPTIME_TIMEOUT         seconds per request (default 10)
#   CAPSTAN_UPTIME_MONITORS        another monitors.json (default the one next to this script)
# A monitor passes when the status matches, the keyword is in the body, the time is under maxMs, and (when
# expectNoStore) the answer carries Cache-Control: no-store. Read-only: GET requests only.
set -u
here="$(cd "$(dirname "$0")" && pwd -P)"
file="${CAPSTAN_UPTIME_MONITORS:-$here/monitors.json}"
timeout="${CAPSTAN_UPTIME_TIMEOUT:-10}"
mode="${1:-probe}"
case "$mode" in probe | --list) ;; *) echo "usage: check.sh [--list]" >&2; exit 2 ;; esac
[ -f "$file" ] || { echo "no monitors file: $file" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 2; }
BUN="${CAPSTAN_BUN:-$(command -v bun || echo /usr/local/bin/bun)}"
[ -x "$BUN" ] || { echo "bun is required to read $file" >&2; exit 2; }

# one tab-separated line per monitor: id url status keyword maxMs noStore
rows="$("$BUN" -e '
const m = JSON.parse(await Bun.file(process.argv[1]).text());
const bases = { ...m.bases };
if (process.env.CAPSTAN_UPTIME_SITE_BASE) bases.site = process.env.CAPSTAN_UPTIME_SITE_BASE;
if (process.env.CAPSTAN_UPTIME_API_BASE) bases.api = process.env.CAPSTAN_UPTIME_API_BASE;
for (const x of m.monitors) {
  const base = bases[x.base];
  if (!base) throw new Error(`monitor ${x.id}: unknown base ${x.base}`);
  if (x.method !== "GET") throw new Error(`monitor ${x.id}: only GET monitors are supported`);
  const url = base.replace(/\/+$/, "") + x.path;
  console.log([x.id, url, x.expectStatus, Buffer.from(x.keyword).toString("base64"), x.maxMs, x.expectNoStore ? 1 : 0].join("\t"));
}' "$file")" || { echo "cannot read $file" >&2; exit 2; }

if [ "$mode" = "--list" ]; then
  printf '%s\n' "$rows" | while IFS="$(printf '\t')" read -r id url _; do echo "$id $url"; done
  exit 0
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/capstan-uptime.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
total=0
failed=0
tab="$(printf '\t')"
while IFS="$tab" read -r id url want kw64 maxms nostore; do
  [ -n "$id" ] || continue
  total=$((total + 1))
  why=""
  if [ "${CAPSTAN_UPTIME_LOCAL_ONLY:-}" = "1" ]; then
    case "$url" in http://127.0.0.1:* | http://localhost:* | http://127.0.0.1/* | http://localhost/*) ;; *) why="not a local URL (CAPSTAN_UPTIME_LOCAL_ONLY=1)" ;; esac
  fi
  code="000"
  ms=0
  if [ -z "$why" ]; then
    out="$(curl -sS -m "$timeout" -o "$tmp/body" -D "$tmp/head" -H 'Cache-Control: no-cache' -w '%{http_code} %{time_total}' "$url" 2>"$tmp/err")"
    rc=$?
    code="${out%% *}"
    secs="${out#* }"
    ms="$(awk -v s="$secs" 'BEGIN { printf "%d", s * 1000 }')"
    if [ $rc -ne 0 ]; then
      why="request failed: $(head -c 200 "$tmp/err" | tr '\n' ' ')"
    elif [ "$code" != "$want" ]; then
      why="status $code, want $want"
    else
      kw="$(printf '%s' "$kw64" | base64 -d 2>/dev/null || printf '%s' "$kw64" | base64 -D)"
      if ! grep -qF -- "$kw" "$tmp/body"; then
        why="keyword $kw not in the body: $(head -c 200 "$tmp/body" | tr '\n' ' ')"
      elif [ "$ms" -gt "$maxms" ]; then
        why="slow: ${ms}ms, limit ${maxms}ms"
      elif [ "$nostore" = "1" ] && ! grep -i '^cache-control:' "$tmp/head" | grep -qi 'no-store'; then
        why="no Cache-Control: no-store header"
      fi
    fi
  fi
  if [ -z "$why" ]; then
    echo "PASS $id $url $code ${ms}ms"
  else
    failed=$((failed + 1))
    echo "FAIL $id $url $why"
  fi
done <<EOF
$rows
EOF

if [ "$failed" -eq 0 ]; then
  echo "PASS $total/$total monitors"
  exit 0
fi
echo "FAIL $failed of $total monitors"
exit 1
