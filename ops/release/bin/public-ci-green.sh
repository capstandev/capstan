#!/bin/bash
# Is public CI green on the public main tip? Anonymous GitHub API, one call per run. Exit 0 green, 1 red, 2 unknown
# (in progress, API error: never an alert). A cancelled job counts as red only when no newer run on the same commit
# replaced it: the API's check-runs list already keeps the newest run per check name, so a "cancelled" left there is red.
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
repo=$(rr_conf_get PUBLIC_REPO ""); [ -n "$repo" ] || exit 2
curl_bin=$(rr_conf_get CURL /usr/bin/curl)
j=$("$curl_bin" -fsS --max-time 20 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/commits/main/check-runs?per_page=100" 2>/dev/null) || exit 2
st=$(printf '%s' "$j" | grep -o '"status": *"[a-z_]*"' | sed 's/.*"\([a-z_]*\)"$/\1/' | sort -u)
co=$(printf '%s' "$j" | grep -o '"conclusion": *[a-z"_]*' | sed 's/.*: *//; s/"//g' | sort -u)
[ -n "$st" ] || exit 2
printf '%s\n' "$st" | grep -qv '^completed$' && exit 2
for c in $co; do case "$c" in success|skipped|neutral) ;; *) exit 1 ;; esac; done
exit 0
