#!/bin/bash
# Every service unit caps its memory (MemoryHigh below MemoryMax) and its swap (MemorySwapMax), so one runaway service cannot swap the box until the
# kernel OOM killer picks a victim. Server defect: ingest-hl grew to 4.9 GB, load 58, ssh timed out. Runs on the Mac.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
. "$here/lib.sh"
T_NAME=memory
units="$(cd "$here/.." && pwd -P)/systemd"
mb() { # 1200M -> 1200, 2G -> 2048
  case "$1" in *M) echo "${1%M}" ;; *G) echo $(( ${1%G} * 1024 )) ;; *) echo "" ;; esac
}
n=0
for f in "$units"/*.service; do
  [ -f "$f" ] || continue
  n=$((n + 1))
  u="$(basename "$f")"
  # only the [Service] section counts
  svc="$(awk '/^\[/{s=($0=="[Service]")} s' "$f")"
  hi="$(printf '%s\n' "$svc" | sed -n 's/^MemoryHigh=//p' | tail -n 1)"
  mx="$(printf '%s\n' "$svc" | sed -n 's/^MemoryMax=//p' | tail -n 1)"
  [ -n "$hi" ] || { fail "$u: no MemoryHigh in [Service]"; continue; }
  [ -n "$mx" ] || { fail "$u: no MemoryMax in [Service]"; continue; }
  h="$(mb "$hi")"; m="$(mb "$mx")"
  [ -n "$h" ] && [ -n "$m" ] || { fail "$u: MemoryHigh/MemoryMax must be in M or G ($hi, $mx)"; continue; }
  [ "$h" -lt "$m" ] || fail "$u: MemoryHigh $hi must be below MemoryMax $mx"
  # above the measured RSS with room (smallest measured service is about 36 MB; workers about 155 MB)
  [ "$h" -ge 256 ] || fail "$u: MemoryHigh $hi is too tight"
  if [ "$u" = capstan-workers.service ]; then [ "$h" -ge 1024 ] || fail "$u: workers MemoryHigh $hi below 1024M"; fi
  # swap is capped per unit too: without it a unit at MemoryHigh pages out into the 4 GB swapfile and drags the box
  sw="$(printf '%s\n' "$svc" | sed -n 's/^MemorySwapMax=//p' | tail -n 1)"
  [ -n "$sw" ] || { fail "$u: no MemorySwapMax in [Service]"; continue; }
  s="$(mb "$sw")"
  [ -n "$s" ] || { fail "$u: MemorySwapMax must be in M or G ($sw)"; continue; }
  [ "$s" -gt 0 ] && [ "$s" -le 512 ] || fail "$u: MemorySwapMax $sw must be above 0 and at most 512M"
done
[ "$n" -ge 10 ] || fail "expected at least 10 service units, found $n"
pass
