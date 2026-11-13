#!/bin/bash
# PUBLIC_SYNC_CMD on the server: the public copy of update N, made by ops/public/sync-public.py (installed as
# lib/sync-public.py) as the capstandev user, signed with its key and pushed with its push key.
#   public-sync.sh --update N --private-sha SHA     stdout: the public sha of that update (one line); the rest on stderr
#   public-sync.sh --check                          config, keys and remote reachable; pushes nothing
# Runs as the runner user, never as root. Idempotent: an update already copied (or copied by a run that crashed after
# its push) copies nothing again and prints the same public sha. A forbidden word left after the scrub refuses the
# whole copy before anything is pushed (exit 1). Exit 2 = usage or setup, 75 = another copy is running.
# Config (release.conf): PUBLIC_STATE (root-owned template with the forbidden words, readable by the runner only),
# PUBLIC_SIGNING_KEY, PUBLIC_PUSH_KEY (or empty and an ssh alias in PUBLIC_REMOTE_URL), PUBLIC_KNOWN_HOSTS,
# PUBLIC_REMOTE_URL (default: the template's publicUrl), PUBLIC_SYNC_HOME (default $RR_HOME/public),
# PUBLIC_PRIVATE_SRC (default WORK_DIR), PUBLIC_MESSAGE_OVERRIDES. Key files are only ever passed by path.
set -u
. "$(cd "$(dirname "$0")/.." && pwd -P)/lib/common.sh"
die() { echo "public-sync: $1" >&2; exit "${2:-1}"; }
say() { echo "public-sync: $*" >&2; }

n=""; sha=""; check=0
while [ $# -gt 0 ]; do
  case "$1" in
    --update) n="${2:-}"; shift 2 || shift ;;
    --private-sha) sha="${2:-}"; shift 2 || shift ;;
    --check) check=1; shift ;;
    *) die "usage: public-sync.sh --update N --private-sha <40-hex> | --check" 2 ;;
  esac
done
if [ "$check" = 0 ]; then
  case "$n" in ''|*[!0-9]*) die "--update must be a number" 2 ;; esac
  printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$' || die "--private-sha must be a full 40-hex sha" 2
fi
[ "$(id -u)" = "0" ] && die "runs as the runner user, never as root" 2
rr_init

TPL=$(rr_conf_get PUBLIC_STATE /etc/capstan-release/public/state.json)
SIGN=$(rr_conf_get PUBLIC_SIGNING_KEY "")
PUSHKEY=$(rr_conf_get PUBLIC_PUSH_KEY "")
KNOWN=$(rr_conf_get PUBLIC_KNOWN_HOSTS "")
URL=$(rr_conf_get PUBLIC_REMOTE_URL "")
SRC=$(rr_conf_get PUBLIC_PRIVATE_SRC "$RR_WORK")
PH=$(rr_conf_get PUBLIC_SYNC_HOME "$RR_HOME/public")
SYNC_PY="$RR_ROOT/lib/sync-public.py"; [ -f "$SYNC_PY" ] || SYNC_PY="$RR_ROOT/../public/sync-public.py" # installed, or the repo
SYNC_PY=$(rr_conf_get PUBLIC_SYNC_PY "$SYNC_PY")
OVR=$(rr_conf_get PUBLIC_MESSAGE_OVERRIDES "")
PY=$(rr_conf_get PYTHON python3)
R="$PH/repo.git"; WS="$PH/state.json"; ENTRIES="$PH/changelog-entries.json"

[ -f "$TPL" ] && [ -r "$TPL" ] || die "PUBLIC_STATE is not a readable file (the operator copies the state template there)" 2
[ -n "$SIGN" ] && [ -f "$SIGN" ] && [ -r "$SIGN" ] || die "PUBLIC_SIGNING_KEY is not set or not readable" 2
[ -z "$PUSHKEY" ] || { [ -f "$PUSHKEY" ] && [ -r "$PUSHKEY" ]; } || die "PUBLIC_PUSH_KEY is set but not readable" 2
[ -z "$KNOWN" ] || [ -r "$KNOWN" ] || die "PUBLIC_KNOWN_HOSTS is set but not readable" 2
[ -f "$SYNC_PY" ] || die "sync-public.py not installed (run install.sh)" 2
command -v "$PY" >/dev/null 2>&1 || die "python3 not found" 2
[ -L "$PH" ] && die "$PH is a symlink: refused" 2
(umask 077; mkdir -p "$PH") || die "cannot make $PH" 2
chmod 0700 "$PH"

# one copy at a time (the runner holds its own lock; this also covers an owner run by hand)
if ! mkdir "$PH/lock" 2>/dev/null; then
  holder=$(cat "$PH/lock/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then die "another public copy is running (pid $holder)" 75; fi
  rm -rf "$PH/lock"; mkdir "$PH/lock" 2>/dev/null || die "cannot take the lock" 75
fi
echo "$$" > "$PH/lock/pid"
trap 'rm -rf "$PH/lock"' EXIT

# template fields (never the forbidden words) as shell values
tplval() { "$PY" -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print(v if isinstance(v,str) else "")' "$TPL" "$1"; }
BRANCH=$(tplval branch); BRANCH=${BRANCH:-main}
[ -n "$URL" ] || URL=$(tplval publicUrl)
[ -n "$URL" ] || die "no public remote: set PUBLIC_REMOTE_URL or publicUrl in the template" 2

export GIT_DIR="$R"
[ -d "$R/objects" ] || git init -q --bare "$R" || die "cannot make $R" 2
if git remote get-url public >/dev/null 2>&1; then git remote set-url public "$URL"; else git remote add public "$URL"; fi
if [ -n "$PUSHKEY" ]; then
  ssh_cmd="ssh -i $PUSHKEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes"
  [ -n "$KNOWN" ] && ssh_cmd="$ssh_cmd -o UserKnownHostsFile=$KNOWN"
  export GIT_SSH_COMMAND="$ssh_cmd"
fi

# the private objects: from the runner's checkout (local, no network)
git fetch -q --no-tags "$SRC" '+refs/heads/*:refs/private/heads/*' '+refs/remotes/*:refs/private/remotes/*' \
  || die "cannot read the private checkout (PUBLIC_PRIVATE_SRC)" 1

# runner-side state: the template's fields every run (the operator may update the words), our own progress kept
"$PY" - "$TPL" "$WS" "$ENTRIES" <<'PY' || die "state template is not usable (see above)" 2
import json, os, re, shutil, sys
tpl_p, ws_p, entries_p = sys.argv[1:4]
st = json.load(open(tpl_p))
if os.path.exists(ws_p):
    ws = json.load(open(ws_p))
    st["privateSha"], st["publicSha"] = ws["privateSha"], ws["publicSha"]
else:
    for k in ("privateSha", "publicSha"):
        if not re.fullmatch(r"[0-9a-f]{40}", str(st.get(k, ""))):
            sys.exit(f"public-sync: template {k} is not a sha: the public copy was never published (publish-public.sh first)")
    if os.path.exists(tpl_p + ".map.jsonl") and not os.path.exists(ws_p + ".map.jsonl"):
        shutil.copyfile(tpl_p + ".map.jsonl", ws_p + ".map.jsonl")
for k in ("name", "email"):
    if not st.get(k) or str(st[k]).startswith("SET"):
        sys.exit(f"public-sync: template {k} is not set")
st["publicRemote"] = "public"
if st.get("changelog"):
    e = st["changelog"].get("entries") or []
    e = [e] if isinstance(e, str) else list(e)
    st["changelog"]["entries"] = [x for x in e if x != entries_p] + [entries_p]
tmp = ws_p + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(st, f, indent=1)
os.replace(tmp, ws_p)
PY
PS=$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["privateSha"])' "$WS")
git cat-file -e "$PS^{commit}" 2>/dev/null || die "the state's private sha ${PS:0:12} is not in the private checkout" 2

sync_env() { env SYNC_SIGNING_KEY="$SIGN" SYNC_PUBLIC_REMOTE=public ${OVR:+SYNC_MESSAGE_OVERRIDES="$OVR"} "$@"; }

if [ "$check" = 1 ]; then
  tip=$(git ls-remote public "refs/heads/$BRANCH" | cut -f1)
  [ -n "$tip" ] || die "public remote has no $BRANCH (or is not reachable with the push key)" 1
  printf 'capstan public sync check\n' > "$PH/check.txt"
  ssh-keygen -Y sign -n git -f "$SIGN" "$PH/check.txt" >/dev/null 2>&1 || { rm -f "$PH/check.txt"*; die "the signing key cannot sign" 1; }
  rm -f "$PH/check.txt"*
  ( cd "$PH" && sync_env "$PY" "$SYNC_PY" "$WS" --reconcile ) >&2 || die "public main and the state disagree (see above)" 1
  echo "public-sync: ready: public $BRANCH ${tip:0:12}, state private ${PS:0:12}" >&2
  exit 0
fi

git cat-file -e "$sha^{commit}" 2>/dev/null || die "private sha ${sha:0:12} is not in the private checkout" 1
if [ "$sha" != "$PS" ] && ! git merge-base --is-ancestor "$sha" "$PS"; then
  git merge-base --is-ancestor "$PS" "$sha" || die "private sha ${sha:0:12} is not on the copied line after ${PS:0:12}: refused" 1
  # the update's changelog entry (only when the template asks for a changelog): title from the schedule, notes staged
  if "$PY" -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("changelog") else 1)' "$WS"; then
    tag=$(rr_tag_of "$n")
    title=$(rr_sched_field "$n" 4 2>/dev/null || true); [ -n "$title" ] || title=$(git log -1 --format=%s "$sha")
    notes=$(rr_read "$RR_HOME/notes/$tag.txt" 2>/dev/null || true); [ -n "$notes" ] || notes="$title"
    when=$(rr_epoch_to_iso "$(rr_now)"); when="${when:0:10} ${when:11:5}"
    printf '%s' "$notes" | "$PY" -c '
import json, os, sys
p, sha, n, tag, title, when = sys.argv[1:7]
d = json.load(open(p)) if os.path.exists(p) else {}
if sha not in d:
    d[sha] = {"n": int(n), "id": tag, "title": title, "date": when, "notes": sys.stdin.read().strip()}
    tmp = p + ".tmp"
    json.dump(d, open(tmp, "w"), indent=1)
    os.replace(tmp, p)' "$ENTRIES" "$sha" "$n" "$tag" "$title" "$when" || die "cannot write the changelog entry" 1
  fi
  git update-ref "refs/heads/$BRANCH" "$sha" || die "cannot set $BRANCH" 1
  say "update $n: copying private ${PS:0:12}..${sha:0:12}"
  ( cd "$PH" && sync_env "$PY" "$SYNC_PY" "$WS" ) >&2
  rc=$?
  [ "$rc" -eq 0 ] || die "update $n: public copy refused or failed (rc $rc); nothing new is public from this run unless a line above says pushed" 1
else
  # already copied; a push whose state write was lost is adopted here (the journal), nothing is copied twice
  git update-ref "refs/heads/$BRANCH" "$PS"
  ( cd "$PH" && sync_env "$PY" "$SYNC_PY" "$WS" --reconcile ) >&2 || die "update $n: public main and the state disagree (see above)" 1
  say "update $n: already public"
fi

# the public sha of this update: the last map line of the newest copied first-parent commit at or before it
pub=$(git rev-list --first-parent "$sha" | "$PY" -c '
import json, sys
m = {}
try:
    for l in open(sys.argv[1]):
        if l.strip():
            r = json.loads(l); m[r["private"]] = r["public"]
except FileNotFoundError:
    pass
st = json.load(open(sys.argv[2]))
for c in sys.stdin.read().split():
    if c in m:
        print(m[c]); break
    if c == st["privateSha"]:
        print(st["publicSha"]); break' "$WS.map.jsonl" "$WS")
printf '%s' "$pub" | grep -Eq '^[0-9a-f]{40}$' || die "update $n: copied, but its public sha is not in the map" 1
echo "$pub"
