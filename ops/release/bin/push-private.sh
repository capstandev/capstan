#!/bin/bash
# Push the work checkout's main to the private repo (fast-forward only). Exit 75 on a network failure.
set -u
dir="${1:?usage: push-private.sh <work dir>}"
git -C "$dir" push -q origin HEAD:refs/heads/main || exit 75
