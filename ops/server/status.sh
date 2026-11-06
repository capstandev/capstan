#!/bin/bash
# One line per Capstan unit and health endpoint (installed as /usr/local/sbin/capstan-status). Read-only.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
if [ -f "$here/lib.sh" ]; then . "$here/lib.sh"; else . /usr/local/lib/capstan/lib.sh; fi
SYSTEMCTL="${CAPSTAN_SYSTEMCTL:-/bin/systemctl}"
for s in db $CAPSTAN_SERVICES; do
  printf '%-22s %s\n' "capstan-$s" "$("$SYSTEMCTL" is-active "capstan-$s.service" 2>/dev/null || true)"
done
for hp in api:8710/v1/health ws:8711/health relay:8712/health mcp:8713/health facilitator:8714/health; do
  name="${hp%%:*}"; url="http://127.0.0.1:${hp#*:}"
  if /usr/bin/curl -fsS -m 3 "$url" >/dev/null 2>&1; then r="ok"; else r="FAIL"; fi
  printf '%-22s %s\n' "health $name" "$r"
done
printf '%-22s %s\n' "release" "$(/usr/bin/readlink "$CAPSTAN_OPT/current" 2>/dev/null | /usr/bin/xargs -r basename 2>/dev/null || echo none)"
