#!/usr/bin/env bash
# Symbolic check of the sorted-pair Merkle library (todo 25 R6): contracts/test/halmos/*.h.sol, functions check_*.
# Installs halmos into a venv outside the repo from the hash-locked ops/ci/halmos-requirements.txt (pip
# --require-hashes --no-deps), then runs it. In CI the job skips when no Python 3.11+ is available; the acceptance runs it.
# Usage: bash ops/ci/halmos.sh
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
venv="${HALMOS_VENV:-$HOME/.cache/capstan/halmos-venv}"
py=""
for c in python3.13 python3.12 python3.11; do
  if command -v "$c" >/dev/null 2>&1; then py="$(command -v "$c")"; break; fi
done
if [ ! -x "$venv/bin/halmos" ]; then
  if [ -z "$py" ]; then
    echo "halmos: skip (no Python 3.11 to 3.13 found)"
    exit 0
  fi
  mkdir -p "$(dirname "$venv")"
  "$py" -m venv "$venv"
  "$venv/bin/pip" install --quiet --require-hashes --no-deps -r "$root/ops/ci/halmos-requirements.txt"
fi
export PATH="$HOME/.foundry/bin:$PATH"
# forge 1.x links test deployments through a cheat code (deployCode) that halmos does not model
export FOUNDRY_DYNAMIC_TEST_LINKING=false
cd "$root/contracts"
"$venv/bin/halmos" --version
"$venv/bin/halmos" --contract MerkleSymbolic --function check_ "$@"
