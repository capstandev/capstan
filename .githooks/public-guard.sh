#!/usr/bin/env bash
# Fails if the repo (tracked + staged + untracked-not-ignored files) contains anything that must stay private.
#
# Denylist lookup (first match wins):
#   1. public-guard.denylist next to this script (e.g. .githooks/public-guard.denylist when the guard lives in .githooks/)
#   2. scripts/public-guard.denylist at the repo root (old layout, kept as a fallback)
#   3. .githooks/public-guard.denylist at the repo root
# If no denylist is found, or it holds no patterns, the guard FAILS (exit 2). It never skips the word check silently.
set -uo pipefail
root="$(git rev-parse --show-toplevel)" || exit 2
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$root"
root_real="$(pwd -P)"

deny=""
for cand in "$script_dir/public-guard.denylist" "$root_real/scripts/public-guard.denylist" "$root_real/.githooks/public-guard.denylist"; do
  if [ -f "$cand" ]; then deny="$cand"; break; fi
done
if [ -z "$deny" ]; then
  echo "public-guard: ERROR no denylist found. Looked for:" >&2
  printf '%s\n' "$script_dir/public-guard.denylist" "$root_real/scripts/public-guard.denylist" "$root_real/.githooks/public-guard.denylist" \
    | awk '!seen[$0]++ { print "public-guard:   " $0 }' >&2
  echo "public-guard: put public-guard.denylist next to public-guard.sh. Refusing to pass without the private-word check." >&2
  exit 2
fi
patterns=$(grep -vE '^[[:space:]]*(#|$)' "$deny" || true)
if [ -z "$patterns" ]; then
  echo "public-guard: ERROR denylist $deny has no patterns. Seed it with the project's private words." >&2
  exit 2
fi
# Repo-relative path of the denylist (empty if it sits outside the repo), so it is not scanned for its own words.
deny_rel=""
case "$deny" in "$root_real"/*) deny_rel="${deny#"$root_real"/}";; esac

hits=0
flag(){ echo "public-guard: $1"; hits=$((hits+1)); }

files=$(git ls-files -co --exclude-standard)
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    # the website's own mascot clips (owner-supplied site media, served by web/; DECISIONS 222)
    web/public/assets/*.mp4) ;;
    *.pdf|*.mp4|*.mov|*.docx|*.key|*.pem) flag "$f: private file type";;
    docs/*|*/docs/*|plans/*|*/plans/*|todos/*|*/todos/*|*RESUME*|*STATUS.md) flag "$f: private path";;
    .env.example) ;;
    .env|.env.*|*/.env|*/.env.*) flag "$f: env file must not be committed";;
  esac
done <<< "$files"

text_files=$(echo "$files" | grep -vE '\.(png|jpg|jpeg|webp|gif|ico|lock|lockb)$' | grep -vxF "${deny_rel:-//none//}" || true)
if [ -n "$text_files" ]; then
  tmp=$(mktemp "${TMPDIR:-/tmp}/public-guard.XXXXXX")
  # 32-byte hex = possible private key. Allowed only with a marker on the same line.
  # Vendored libraries (contracts/lib/, unmodified upstream code such as forge-std's secp256k1 curve constants) and
  # recorded public venue data (packages/venue-client/fixtures/, which holds tx and order hashes) are skipped for this
  # check only; the denylist word check below still scans them, and ops/ci/check-vector-files.ts refuses any key-like
  # name in those fixtures.
  echo "$text_files" | grep -v -e '^contracts/lib/' -e '^packages/venue-client/fixtures/' | tr '\n' '\0' | xargs -0 grep -nIE '0x[0-9a-fA-F]{64}' 2>/dev/null \
    | grep -vE '// (test-key|not-a-key)|# (test-key|not-a-key)' | while IFS= read -r l; do echo "public-guard: possible private key: $l"; done > "$tmp"
  if [ -s "$tmp" ]; then cat "$tmp"; hits=$((hits+$(wc -l < "$tmp"))); fi; rm -f "$tmp"
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    m=$(echo "$text_files" | tr '\n' '\0' | xargs -0 grep -nIiE -- "$pat" 2>/dev/null | head -5)
    [ -n "$m" ] && { echo "$m" | while IFS= read -r l; do printf "public-guard: denylisted '%s': %s\n" "$pat" "$l"; done; hits=$((hits+1)); }
  done <<< "$patterns"
fi

if [ "$hits" -gt 0 ]; then echo "public-guard: $hits problem(s). Backend is public, fix before committing."; exit 1; fi
echo "public-guard: clean (denylist: ${deny_rel:-$deny})"
