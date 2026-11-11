#!/bin/bash
# Local proof of the public publish, nothing touches GitHub: a LOCAL bare repo stands in for capstandev/capstan, a gh
# stub records every gh call, and a throwaway key signs. Runs publish-public.sh over the whole private main history,
# then publish-public-update.sh twice (nothing to sync, then one new private commit).
#   bash ops/public/test/prove-local.sh <state template json> <private repo> [work dir]
set -euo pipefail
TPL="$1"; SRC="$2"; D="${3:-$(mktemp -d "${TMPDIR:-/tmp}/capstan-public-proof.XXXXXX")}"
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
mkdir -p "$D/bin" "$D/state"
git init -q --bare -b main "$D/public.git"
git clone -q --no-local "$SRC" "$D/private"
ssh-keygen -q -t ed25519 -N '' -C capstan-sync-test -f "$D/testkey"
python3 - "$TPL" "$D" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); d = sys.argv[2]
s.update(email="1+capstandev@users.noreply.github.com", signingKey=d + "/testkey.pub", publicUrl=d + "/public.git")
s["changelog"]["entries"] = d + "/state/no-entries.json"
json.dump(s, open(d + "/state/capstan-public.state.json", "w"), indent=1)
PY
cat > "$D/bin/gh" <<'GH'
#!/bin/bash
echo "gh $*" >> "$GHSTUB/gh.log"
case "$*" in
  "api user --jq .login") echo previous-user;;
  "auth switch"*) ;;
  "repo view"*"--json visibility"*) [ -f "$GHSTUB/public" ] && echo PUBLIC || echo PRIVATE;;
  "repo view"*) [ -f "$GHSTUB/created" ];;
  "repo create"*"--private"*) touch "$GHSTUB/created";;
  "repo edit"*"--visibility public"*) [ -f "$GHSTUB/created" ] && touch "$GHSTUB/public";;
  "repo edit"*|"api -X PUT"*) [ -f "$GHSTUB/created" ];;
  *) echo "gh stub: unexpected: $*" >&2; exit 9;;
esac
GH
chmod +x "$D/bin/gh"
export GHSTUB="$D" GH="$D/bin/gh" STATE="$D/state/capstan-public.state.json" PRIVATE_REPO="$D/private" SYNC_DIR="$D/sync" PRIVATE_FETCH=0 PRIVATE_REF=refs/heads/main \
       ABOUT_FILE="${ABOUT_FILE:?set ABOUT_FILE to docs/marketing/github-about.md}"
echo "== publish (work dir $D)"; /bin/bash "$HERE/publish-public.sh"
echo "== update, nothing new"; /bin/bash "$HERE/publish-public-update.sh" | tee "$D/update1.log"
grep -q "nothing to sync" "$D/update1.log"
git -C "$D/private" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -q --allow-empty -m "chore: proof commit after publish"
echo "== update, one new private commit"; /bin/bash "$HERE/publish-public-update.sh" | tee "$D/update2.log"
grep -q "pushed 1 commit" "$D/update2.log"
# order checks on the gh calls: created private before any push of content, public only after verify, back on exit
awk '/repo create/{c=NR} /--visibility public/{p=NR} END{exit !(c && p && c < p)}' "$D/gh.log"
[ "$(grep -c 'auth switch -h github.com -u previous-user' "$D/gh.log")" = 3 ]
grep -q -- '--description Non-custodial multi-venue perps API' "$D/gh.log"
priv="$(git -C "$D/private" rev-list --count --first-parent main)"; pub="$(git -C "$D/public.git" rev-list --count main)"
[ "$pub" = $((priv + 1)) ] || { echo "public has $pub commits, want $((priv + 1))"; exit 1; }
echo "PROOF OK: $pub public commits (1 base + $priv copies), gh calls in order, gh switched back 3 of 3 runs. Log: $D/gh.log"
