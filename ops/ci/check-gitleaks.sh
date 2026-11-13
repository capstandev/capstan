#!/usr/bin/env bash
# The public CI gitleaks job, run locally: same gitleaks version (8.30.1), same config (.github/gitleaks.toml), same
# command, over the full git history. Part of `bun run check`, so a finding is caught before a public copy is made.
# Usage: bash ops/ci/check-gitleaks.sh [repoRoot]
set -euo pipefail
root="${1:-.}"
want="8.30.1"
bin="${GITLEAKS:-$(command -v gitleaks || true)}"
if [ -z "$bin" ]; then
  echo "check-gitleaks: gitleaks $want not found (brew install gitleaks, or set GITLEAKS=/path/to/gitleaks)" >&2
  exit 1
fi
have="$("$bin" version 2>/dev/null | tr -d 'v[:space:]')"
if [ "$have" != "$want" ]; then
  echo "check-gitleaks: gitleaks $have found, CI pins $want; rules differ between versions" >&2
  exit 1
fi
cd "$root"
"$bin" detect --source . --config .github/gitleaks.toml --redact --no-banner --exit-code 1
echo "check-gitleaks: no leaks (gitleaks $want, full history)"
