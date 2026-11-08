#!/bin/bash
# GitHub Release for one released update, on the PUBLIC repo, best effort (the runner never waits on it).
#   ghrelease.sh create <tag> <40-hex public sha> "<title>" < notes.md   (idempotent: an existing tag is "exists")
#   ghrelease.sh draft-test                                              (draft create + delete; writes RELEASE_TOKEN_PROOF)
# Token: GITHUB_RELEASE_TOKEN in a root-only env file (fine-grained, public repo only, Contents read and write), sent
# to curl in a config on stdin. Exit: 0 created or exists, 3 no token or auth refused (401/403), 2 bad arguments,
# 1 any other failure. A staged poster $RR_HOME/posters/<tag>.png is uploaded once and shown at the top.
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
rr_init
envf=$(rr_conf_get GITHUB_RELEASE_ENV /etc/capstan-release/github-release.env)
curl_bin=$(rr_conf_get CURL /usr/bin/curl)
read_env() { grep -E "^$1=" "$envf" 2>/dev/null | tail -n 1 | sed -E "s/^$1=//; s/^['\"]//; s/['\"]\$//"; }
json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'; }
token=$(read_env GITHUB_RELEASE_TOKEN); repo=$(read_env GITHUB_RELEASE_REPO)
[ -n "$token" ] || { rr_log "ghrelease: no token saved"; exit 3; }
case "$repo" in */*) ;; *) rr_log "ghrelease: GITHUB_RELEASE_REPO must be owner/repo"; exit 2 ;; esac
api() { # api METHOD URL [body-file] -> prints body, returns HTTP status in $code_file
  local m="$1" u="$2" f="${3:-}"
  { printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/vnd.github+json"\nheader = "X-GitHub-Api-Version: 2022-11-28"\n' "$token"
    printf 'request = "%s"\nurl = "%s"\nsilent\nmax-time = 30\nwrite-out = "%%{http_code}"\n' "$m" "$u"
    [ -n "$f" ] && printf 'data-binary = "@%s"\nheader = "Content-Type: application/json"\n' "$f"
  } | "$curl_bin" -K - -o "$RR_HOME/ghrel.body" > "$RR_HOME/ghrel.code" 2>/dev/null
  cat "$RR_HOME/ghrel.code" 2>/dev/null
}
auth_or_fail() { case "$1" in 401|403) rr_log "ghrelease: auth refused ($1)"; exit 3 ;; *) rr_log "ghrelease: GitHub answered $1"; exit 1 ;; esac; }
B="https://api.github.com/repos/$repo"
case "${1:-}" in
  draft-test)
    printf '{"tag_name":"release-token-test-%s","name":"token test","draft":true,"body":"Draft made to prove the release token. Deleted at once."}' "$(rr_now)" > "$RR_HOME/ghrel.req"
    c=$(api POST "$B/releases" "$RR_HOME/ghrel.req"); [ "$c" = "201" ] || auth_or_fail "$c"
    id=$(grep -o '"id": *[0-9]*' "$RR_HOME/ghrel.body" | head -n 1 | tr -dc '0-9')
    c=$(api DELETE "$B/releases/$id"); [ "$c" = "204" ] || { rr_log "ghrelease: draft $id made but not deleted ($c); delete it by hand"; exit 1; }
    : > "$(rr_conf_get RELEASE_TOKEN_PROOF "$RR_HOME/release-token.proof")"
    echo "ghrelease: draft release made and deleted; token proven"; exit 0 ;;
  create)
    tag="${2:-}"; sha="${3:-}"; title="${4:-}"
    case "$tag" in update-[0-9][0-9]|bonus-[0-9][0-9]|fix-20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]-*) ;; *) echo "ghrelease: bad tag" >&2; exit 2 ;; esac
    printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$' || { echo "ghrelease: target must be a full 40-hex sha" >&2; exit 2; }
    [ -n "$title" ] || { echo "ghrelease: title missing" >&2; exit 2; }
    notes=""; [ -t 0 ] || notes=$(head -c 60000)
    c=$(api GET "$B/releases/tags/$tag")
    if [ "$c" = "200" ]; then echo "ghrelease: $tag exists"
    elif [ "$c" = "404" ]; then
      printf '{"tag_name":"%s","target_commitish":"%s","name":"%s","body":"%s","make_latest":"true"}' "$tag" "$sha" "$(json_str "$title")" "$(json_str "$notes")" > "$RR_HOME/ghrel.req"
      c=$(api POST "$B/releases" "$RR_HOME/ghrel.req"); [ "$c" = "201" ] || auth_or_fail "$c"
      echo "ghrelease: $tag created"
    else auth_or_fail "$c"; fi
    poster="$RR_HOME/posters/$tag.png"
    if [ -f "$poster" ] && ! grep -q "\"name\": *\"$tag.png\"" "$RR_HOME/ghrel.body"; then
      id=$(grep -o '"id": *[0-9]*' "$RR_HOME/ghrel.body" | head -n 1 | tr -dc '0-9')
      { printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: image/png"\nrequest = "POST"\n' "$token"
        printf 'url = "https://uploads.github.com/repos/%s/releases/%s/assets?name=%s.png"\ndata-binary = "@%s"\nsilent\nmax-time = 60\n' "$repo" "$id" "$tag" "$poster"
      } | "$curl_bin" -K - -o /dev/null || rr_log "ghrelease: poster upload for $tag failed (release is fine)"
    fi
    exit 0 ;;
  *) echo "usage: ghrelease.sh create <tag> <sha> <title> < notes | draft-test" >&2; exit 2 ;;
esac
