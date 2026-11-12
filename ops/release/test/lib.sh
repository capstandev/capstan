# Test helpers for the release runner. Every test gets a fresh sandbox: local bare repos stand in for the private repo
# and the server's queue.git, and fake commands stand in for deploy, rollback, checks, the public copy, GitHub Releases,
# Telegram and systemctl. Nothing reaches the network, a real server or a real repo.
set -u
T_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BIN="$T_ROOT/bin"
T_PASS=0; T_FAIL=0
LAUNCH_ISO=2026-11-20T01:00:00Z
. "$T_ROOT/lib/common.sh"

fail() { echo "    FAIL: $*"; return 1; }
assert_eq() { [ "$1" = "$2" ] || fail "${3:-values differ}: expected [$2], got [$1]"; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "${3:-missing text}: [$2] not in [$1]" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) fail "${3:-unexpected text}: [$2] found" ;; *) ;; esac; }
assert_file() { [ -e "$1" ] || fail "missing file $1"; }
assert_no_file() { [ ! -e "$1" ] || fail "file should not exist: $1"; }
lines() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }

g() { git -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }

# sandbox [count]: repos with a base commit on main and <count> queued updates (default 3), config, fakes, schedule.
sandbox() {
  local count="${1:-3}" i
  T=$(mktemp -d "${TMPDIR:-/tmp}/rr-test.XXXXXX")
  trap 'case "$T" in */rr-test.*) rm -rf "$T" ;; esac' EXIT
  export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$T/gitconfig"
  printf '[user]\n\tname = Release Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[advice]\n\tdetachedHead = false\n' > "$T/gitconfig"
  g init -q --bare "$T/private.git"; g init -q --bare "$T/queue.git"
  g init -q "$T/seed"
  echo base > "$T/seed/base.txt"; g -C "$T/seed" add -A; g -C "$T/seed" commit -q -m "chore: base"
  g -C "$T/seed" push -q "$T/private.git" main
  BASE=$(g -C "$T/seed" rev-parse HEAD)
  g -C "$T/seed" checkout -q -b tu-queue
  i=1
  while [ "$i" -le "$count" ]; do
    echo "update $i" > "$T/seed/u$i.txt"; g -C "$T/seed" add -A; g -C "$T/seed" commit -q -m "feat(api): update number $i"
    i=$((i + 1))
  done
  g -C "$T/seed" push -q "$T/queue.git" tu-queue
  g clone -q "$T/private.git" "$T/work"
  g -C "$T/work" remote add queue "$T/queue.git"; g -C "$T/work" fetch -q queue
  mkdir -p "$T/fake" "$T/home"
  write_fakes
  cat > "$T/release.conf" <<EOF
RR_HOME=$T/home
WORK_DIR=$T/work
QUEUE_REF=queue/tu-queue
FLAG_FILE=$T/flag
OWNER_TZ=America/Toronto
CADENCE_MINUTES=60
MIN_GAP_MINUTES=2
TRANSIENT_MAX=3
SIGN_CHERRY_PICKS=0
ALLOW_LOCAL_REMOTES=1
STRESS_REPORT=$T/stress.md
RELEASE_TOKEN_PROOF=$T/home/release-token.proof
NOTIFY_PROOF=$T/home/notify.proof
GATE_CMD=$T/fake/gate
PRIVATE_PUSH_CMD=$BIN/push-private.sh
DEPLOY_CMD=$T/fake/deploy
ROLLBACK_CMD=$T/fake/rollback
CHECK_CMD=$T/fake/check
PUBLISH_CMD=$T/fake/publish
GHREL_CMD=$T/fake/ghrel
NOTIFY_CMD=$T/fake/notify
ANNOUNCE_CMD=$T/fake/announce
SYSTEMCTL=$T/fake/systemctl
EOF
  export RR_CONF="$T/release.conf" CAPSTAN_RELEASE_RUNNER=1 RR_NOW=0
  unset RR_HOME 2>/dev/null || true
  "$BIN/build-schedule.sh" "$BASE" queue/tu-queue "$LAUNCH_ISO" > /dev/null || fail "build-schedule failed"
  LAUNCH=$(rr_iso_to_epoch "$LAUNCH_ISO")
  : > "$T/flag"
  rr_init
}

write_fakes() {
  cat > "$T/fake/gate" <<EOF
#!/bin/bash
f="$T/fail-gate-\$1"; [ -f "\$f" ] && exit "\$(cat "\$f")"; exit 0
EOF
  cat > "$T/fake/deploy" <<EOF
#!/bin/bash
f="$T/fail-deploy"
if [ -f "\$f" ]; then c=\$(cat "\$f"); [ "\$c" = once75 ] && { rm -f "\$f"; exit 75; }; exit "\$c"; fi
echo "\$1" > "$T/prod"; echo "deploy \$1" >> "$T/deploys.log"
EOF
  cat > "$T/fake/rollback" <<EOF
#!/bin/bash
[ -f "$T/fail-rollback" ] && exit 1
echo "\$1" > "$T/prod"; echo "rollback \$1" >> "$T/deploys.log"
EOF
  cat > "$T/fake/check" <<EOF
#!/bin/bash
[ -f "$T/crash-check" ] && { rm -f "$T/crash-check"; kill -9 \$PPID; sleep 2; }
[ -f "$T/fail-check-\$1" ] && exit 1; exit 0
EOF
  cat > "$T/fake/publish" <<EOF
#!/bin/bash
[ -f "$T/fail-publish" ] && exit 1
grep -q "^\$1 " "$T/public.log" 2>/dev/null && exit 0
echo "\$1 \$2" >> "$T/public.log"
[ -f "$T/crash-publish" ] && { rm -f "$T/crash-publish"; kill -9 \$PPID; sleep 2; }
exit 0
EOF
  cat > "$T/fake/ghrel" <<EOF
#!/bin/bash
[ -f "$T/ghrel-code" ] && exit "\$(cat "$T/ghrel-code")"
echo "\$*" >> "$T/ghrel.log"
EOF
  cat > "$T/fake/notify" <<EOF
#!/bin/bash
[ -f "$T/fail-notify" ] && { cat > /dev/null; exit 1; }
printf '%s|%s\n' "\$1" "\$(cat)" >> "$T/notify.log"
EOF
  cat > "$T/fake/announce" <<EOF
#!/bin/bash
[ -f "$T/fail-announce" ] && { cat > /dev/null; exit 1; }
d=""; [ "\$1" = "--dry-run" ] && { d="dry "; shift; }
body=\$(cat); printf '%s%s|%s\n' "\$d" "\$2" "\$body" >> "$T/notify.log"; printf '%s%s %s\n' "\$d" "\$1" "\$2" >> "$T/announce.log"
EOF
  cat > "$T/fake/systemctl" <<EOF
#!/bin/bash
echo "\$*" >> "$T/systemctl.log"
EOF
  chmod +x "$T/fake/"*
}

pass_at() { RR_NOW="$1" "$BIN/release-pass.sh"; }   # one runner pass at a given epoch
st() { awk -F '\t' -v n="$1" '$1==n { s=$2 } END { print (s=="" ? "pending" : s) }' "$T/home/state.tsv"; }
notes() { cat "$T/notify.log" 2>/dev/null || true; }
private_has() { g -C "$T/work" fetch -q origin main && g -C "$T/work" cat-file -e "origin/main:$1" 2>/dev/null; }

# run every function named t_* in the calling file, each in its own subshell and sandbox
run_tests() {
  local name file="$1" out rc
  for name in $(grep -oE '^t_[a-zA-Z0-9_]+\(\)' "$file" | tr -d '()'); do
    out=$( (set -eu; "$name") 2>&1 ); rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "ok - $(basename "$file" .test.sh)::${name#t_}"; T_PASS=$((T_PASS + 1))
    else
      echo "not ok - $(basename "$file" .test.sh)::${name#t_}"; printf '%s\n' "$out" | tail -n 15; T_FAIL=$((T_FAIL + 1))
    fi
  done
  echo "# $(basename "$file"): $T_PASS pass, $T_FAIL fail"
  [ "$T_FAIL" -eq 0 ]
}
