#!/bin/bash
# Go-live kit, aster, testnet: the testnet proof. See README.md here.
# Dry run by default (prints every request, sends nothing). Add --send only with every arming switch set.
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
exec /bin/bash "$here/../kit.sh" --kit aster --network testnet "$@"
