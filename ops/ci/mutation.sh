#!/usr/bin/env bash
# Mutation pass over the contracts (todo 25 R14, R20). Scripted operator swaps (ops/ci/mutate.ts), each mutant run
# against the Foundry suite in a scratch copy. Fails under 90% or on any survivor without a reason in
# ops/ci/mutation-equivalent.txt. Writes contracts/test/MUTATION.md and .audit-grade/mutation.md.
# Usage: bash ops/ci/mutation.sh [--files src/A.sol,src/B.sol] [--limit N]
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
cd "$root"
bun ops/ci/mutate.ts "$@"
