#!/bin/bash
# Go-live kit, hl-core, testnet: the testnet proof. See README.md here.
# Dry run by default (prints every request, sends nothing). Add --send only with every arming switch set.
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
exec /bin/bash "$here/../kit.sh" --kit hl-core --network testnet "$@"
