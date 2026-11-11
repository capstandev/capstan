# Shared code for publish-public.sh and publish-public-update.sh (sourced, never run). Works on macOS bash 3.2:
# no arrays, no ${x,,}, no mapfile. Every stage prints one line; slow stages say so.
#
# Settings (environment, all optional):
#   CAPSTAN_HOME  default ~/Documents/GitHub/Capstan
#   STATE         sync state file (private docs/, never in this repo); default $CAPSTAN_HOME/docs/public/capstan-public.state.json
#   PRIVATE_REPO  private checkout to copy from; default $CAPSTAN_HOME/backend
#   PRIVATE_REF   ref to publish; default origin/main of PRIVATE_REPO (fetched first), else its main
#   PRIVATE_FETCH 1 (default) fetches origin main in PRIVATE_REPO first; 0 skips it
#   SYNC_DIR      working clone the sync runs in (grafts live here, never in the dev checkout); default $CAPSTAN_HOME/public-sync
#   ABOUT_FILE    About text; default $CAPSTAN_HOME/docs/marketing/github-about.md
#   PUBLIC_URL    push URL of the public repo; default the state's publicUrl
#   GH            gh binary; default gh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CAPSTAN_HOME="${CAPSTAN_HOME:-$HOME/Documents/GitHub/Capstan}"
STATE="${STATE:-$CAPSTAN_HOME/docs/public/capstan-public.state.json}"
PRIVATE_REPO="${PRIVATE_REPO:-$CAPSTAN_HOME/backend}"
PRIVATE_REF="${PRIVATE_REF:-}"
PRIVATE_FETCH="${PRIVATE_FETCH:-1}"
SYNC_DIR="${SYNC_DIR:-$CAPSTAN_HOME/public-sync}"
ABOUT_FILE="${ABOUT_FILE:-$CAPSTAN_HOME/docs/marketing/github-about.md}"
GH="${GH:-gh}"
STAGES="${STAGES:-1}"
STAGE=0
PREV_GH_USER=""

say() { STAGE=$((STAGE + 1)); printf '[%s %s/%s] %s %s\n' "$TAG" "$STAGE" "$STAGES" "$(date '+%H:%M:%S')" "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '[%s] STOP: %s\n' "$TAG" "$*" >&2; exit 1; }

jget() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2], ""); print(v if isinstance(v, str) else json.dumps(v))' "$STATE" "$1"; }
jset() { python3 -c 'import json,os,sys; p=sys.argv[1]; s=json.load(open(p)); s[sys.argv[2]]=sys.argv[3]; t=p+".tmp"; json.dump(s, open(t,"w"), indent=1); os.replace(t,p)' "$STATE" "$1" "$2"; }
expand() { case "$1" in "~/"*) printf '%s\n' "$HOME/${1#\~/}";; *) printf '%s\n' "$1";; esac; }
sgit() { git -C "$SYNC_DIR" "$@"; }

load_state() {
  if [ ! -f "$STATE" ]; then
    tpl="$(dirname "$STATE")/capstan-public.state.template.json"
    [ -f "$tpl" ] || die "no state file at $STATE and no template next to it"
    cp "$tpl" "$STATE"
    die "made $STATE from the template: put the capstandev noreply email in \"email\", then run this again"
  fi
  PUB_NAME="$(jget name)"; PUB_EMAIL="$(jget email)"; OWNER="$(jget publicOwner)"; REPO="$(jget publicRepo)"
  KEY="$(expand "$(jget signingKey)")"; FORBIDDEN="$(jget forbidden)"; BRANCH="$(jget branch)"; BRANCH="${BRANCH:-main}"
  PUBLIC_URL="${PUBLIC_URL:-$(jget publicUrl)}"; REMOTE="$(jget publicRemote)"; REMOTE="${REMOTE:-public}"
  case "$PUB_EMAIL" in ""|SET-*) die "set \"email\" in $STATE (capstandev's ID+capstandev@users.noreply.github.com)";; esac
  [ -n "$OWNER" ] && [ -n "$REPO" ] && [ -n "$PUBLIC_URL" ] || die "publicOwner, publicRepo and publicUrl must be set in $STATE"
  [ -n "$FORBIDDEN" ] || die "the state has no forbidden words; refusing to publish without the check"
  [ -f "$KEY" ] || die "signing key $KEY not found (make it with ssh-keygen, see docs/BACKLOG.md)"
  for t in git python3 ssh-keygen "$GH"; do command -v "$t" >/dev/null 2>&1 || die "$t is not installed"; done
  note "state $STATE, public $OWNER/$REPO as $PUB_NAME, key $KEY"
}

about() {
  [ -f "$ABOUT_FILE" ] || die "About file $ABOUT_FILE not found"
  DESC="$(awk '/^Description/{f=1;next} f&&NF{print;exit}' "$ABOUT_FILE")"
  WEBSITE="$(awk -F': ' '/^Homepage:/{print $2;exit}' "$ABOUT_FILE")"
  WEBSITE="${WEBSITE:-$(jget website)}"
  [ -n "$DESC" ] || die "no description line in $ABOUT_FILE"
  note "About: $DESC ($WEBSITE)"
}

restore_gh() {
  if [ -n "$PREV_GH_USER" ] && [ "$PREV_GH_USER" != "$OWNER" ]; then
    if "$GH" auth switch -h github.com -u "$PREV_GH_USER" >/dev/null 2>&1; then echo "[$TAG] gh is back on $PREV_GH_USER"
    else echo "[$TAG] could not switch gh back: run  gh auth switch -u $PREV_GH_USER" >&2; fi
  fi
}

use_gh_owner() {
  PREV_GH_USER="$("$GH" api user --jq .login 2>/dev/null || true)"
  trap restore_gh EXIT
  if [ "$PREV_GH_USER" != "$OWNER" ]; then
    "$GH" auth switch -h github.com -u "$OWNER" >/dev/null 2>&1 \
      || die "gh has no login for $OWNER: run  gh auth login --hostname github.com --git-protocol ssh --web  as $OWNER"
  fi
  note "gh is on $OWNER (was ${PREV_GH_USER:-none}; switched back on exit)"
}

fetch_private() {
  if [ "$PRIVATE_FETCH" = 1 ] && git -C "$PRIVATE_REPO" remote get-url origin >/dev/null 2>&1; then
    git -C "$PRIVATE_REPO" fetch -q origin main || die "could not fetch origin main in $PRIVATE_REPO"
  fi
  if [ -z "$PRIVATE_REF" ]; then
    if git -C "$PRIVATE_REPO" rev-parse -q --verify refs/remotes/origin/main >/dev/null; then PRIVATE_REF=refs/remotes/origin/main
    else PRIVATE_REF=refs/heads/main; fi
  fi
  [ -d "$SYNC_DIR/.git" ] || git init -q -b "$BRANCH" "$SYNC_DIR"
  sgit fetch -q --update-head-ok --no-tags "$PRIVATE_REPO" "+$PRIVATE_REF:refs/heads/$BRANCH"
  if sgit remote get-url "$REMOTE" >/dev/null 2>&1; then sgit remote set-url "$REMOTE" "$PUBLIC_URL"
  else sgit remote add "$REMOTE" "$PUBLIC_URL"; fi
  local_main="$(git -C "$PRIVATE_REPO" rev-parse -q --verify refs/heads/main || true)"
  tip="$(sgit rev-parse "refs/heads/$BRANCH")"
  note "private $PRIVATE_REF = ${tip:0:12} ($(sgit rev-list --count --first-parent "$BRANCH") first-parent commits) into $SYNC_DIR"
  if [ -n "$local_main" ] && [ "$local_main" != "$tip" ]; then note "note: local main ${local_main:0:12} differs; push private first if it should go out"; fi
}

run_sync() {
  sgit fetch -q "$REMOTE" "$BRANCH" 2>/dev/null || true
  out="$(cd "$SYNC_DIR" && python3 "$HERE/sync-public.py" "$STATE" --dry-run)" || { printf '%s\n' "$out"; die "dry run refused (nothing pushed)"; }
  n="$(printf '%s\n' "$out" | grep -c -- ' -> ' || true)"
  if [ "$n" = 0 ]; then note "nothing to sync"; return 0; fi
  note "dry run ok: $n public commit(s). Signing and pushing them now (about $((n / 12 + 1)) min, prints at the end)"
  (cd "$SYNC_DIR" && python3 "$HERE/sync-public.py" "$STATE") | tail -n 3 | while IFS= read -r l; do note "$l"; done
}

verify_public() {
  sgit fetch -q "$REMOTE" "$BRANCH"
  ref="refs/remotes/$REMOTE/$BRANCH"
  signers="$SYNC_DIR/.git/allowed_signers"
  printf '%s namespaces="git" %s\n' "$PUB_EMAIL" "$(cat "$KEY")" > "$signers"
  want="G $PUB_NAME|$PUB_EMAIL|$PUB_NAME|$PUB_EMAIL"
  bad="$(sgit -c gpg.ssh.allowedSignersFile="$signers" log --format='%h %G? %an|%ae|%cn|%ce' "$ref" \
        | awk -v w="$want" '{ h = $1; sub(/^[^ ]+ /, ""); if ($0 != w) print h " " $0 }')"
  [ -z "$bad" ] || die "public commits not signed by $PUB_NAME or not authored by it: $(printf '%s' "$bad" | head -3 | tr '\n' ' ')"
  hits="$(sgit log -p --format='%H%n%an %ae%n%cn %ce%n%B' "$ref" | grep -ciE "$FORBIDDEN" || true)"
  [ "$hits" = 0 ] || die "$hits forbidden-word line(s) in git log -p of the public copy"
  ai="$(sgit log --format=%B "$ref" | grep -ciE 'claude|anthropic|chatgpt|openai|codex|copilot' || true)"
  [ "$ai" = 0 ] || die "$ai commit message line(s) name an AI tool"
  paths="$(sgit log --format= --name-only "$ref" | sort -u \
          | grep -E '(^|/)(docs|plans|todos)/|(^|/)\.env($|\.)|\.(pem|key)$|RESUME|(^|/)STATUS\.md$' | grep -vE '(^|/)\.env\.example$' || true)"
  [ -z "$paths" ] || die "private paths in the public copy: $(printf '%s' "$paths" | head -5 | tr '\n' ' ')"
  python3 - "$STATE" "$SYNC_DIR" <<'PY' || die "a public tree differs from its private commit beyond the scrub rules"
import json, subprocess, sys
st = json.load(open(sys.argv[1])); allowed = set(st.get("scrubFiles", {})) | {"CHANGELOG.md"}
pairs = [json.loads(l) for l in open(sys.argv[1] + ".map.jsonl") if l.strip()]
bad = 0
for p in pairs:
    d = set(subprocess.run(["git", "-C", sys.argv[2], "diff", "--name-only", p["private"], p["public"]], capture_output=True, text=True, check=True).stdout.split())
    if d - allowed:
        bad += 1; print("    tree differs:", p["private"][:12], p["public"][:12], sorted(d - allowed)[:5])
print(f"    trees: {len(pairs) - bad} of {len(pairs)} public commits match their private tree (scrubbed files and CHANGELOG.md aside)")
sys.exit(1 if bad else 0)
PY
  note "$(sgit rev-list --count "$ref") public commits: all signed (G) by $PUB_NAME, 0 forbidden-word hits in git log -p, no docs or env files"
}

setting() { # setting <label> <command...>: prints on or FAILED with the settings URL; never stops the run
  label="$1"; shift
  if "$@" >/dev/null 2>&1; then note "$label: on"; else note "$label: FAILED: https://github.com/$OWNER/$REPO/settings (rerun publish-public-update.sh later)"; fi
}

apply_settings() {
  setting "About text and website" "$GH" repo edit "$OWNER/$REPO" --description "$DESC" --homepage "$WEBSITE" --enable-wiki=false --enable-projects=false
  printf '%s' '{"required_status_checks":null,"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}' \
    > "$SYNC_DIR/.git/protection.json"
  setting "branch protection on $BRANCH (no required checks, no force push)" "$GH" api -X PUT "repos/$OWNER/$REPO/branches/$BRANCH/protection" --input "$SYNC_DIR/.git/protection.json"
  setting "private vulnerability reporting" "$GH" api -X PUT "repos/$OWNER/$REPO/private-vulnerability-reporting"
}
