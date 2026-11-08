#!/bin/bash
# The npm packages build, pack to the exact file list and run under plain Node, offline (no publish, ever, from here).
. "$(dirname "$0")/lib.sh"
NODE=$(command -v node || echo /opt/homebrew/bin/node); BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
export PATH="$(dirname "$NODE"):$(dirname "$BUN"):$PATH"

t_mcp_bridge_smoke() { (cd "$T_ROOT/npm/capstan-mcp" && node smoke.mjs) | grep -q 'smoke: PASS'; }
t_sdk_bundle_smoke() { (cd "$T_ROOT/npm/capstan-sdk" && bun build.ts > /dev/null && node smoke.mjs) | grep -q 'smoke: PASS'; }
t_versions_and_repo_in_step() {
  for p in capstan-sdk capstan-mcp; do
    j="$T_ROOT/npm/$p/package.json"
    assert_contains "$(cat "$j")" '"url": "git+https://github.com/capstan-xyz/capstan.git"' "$p repository.url"
    assert_contains "$(cat "$j")" "\"directory\": \"ops/release/npm/$p\"" "$p directory"
    assert_not_contains "$(cat "$j")" '"private"' "$p must be publishable"
  done
}
run_tests "$0"
