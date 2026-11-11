#!/bin/bash
# Release sandbox, container side (run by run.sh as root in a systemd container). Installs the runner exactly as on
# the server (install.sh as root: user, sudoers, units, root wrappers), then drives the real unit with
# "systemctl start capstan-release.service" against local bare repos (private, queue with 6 updates, public), a
# stand-in deploy wrapper at /usr/local/sbin/capstan-deploy and stand-in Telegram and GitHub APIs on 127.0.0.1.
# Time is fixed per pass with "systemctl set-environment RR_NOW=<epoch>" (the unit inherits it), so slots are exact.
# Prints one "PASS <case>: ..." or "FAIL <case>: ..." line per case.
set -u
SRC=/src/release; SB=/srv/sandbox; RH=/var/lib/capstan-release; CONF=/etc/capstan-release/release.conf
TG_PORT=25520; GH_PORT=25521
TG_TOKEN="123456789:SandboxStandinTokenNotRealCCCCCCCC"; GH_TOKEN="sandbox-standin-not-a-real-token"
U=capstan-release; NOW=0
export GIT_CONFIG_NOSYSTEM=1
failed=0

# ---------- helpers ----------
E=""
want() { if ! eval "$1"; then E="$E; $2"; fi; }   # want '<shell test>' '<what was expected>'
endcase() { if [ -z "$E" ]; then echo "PASS $1: $2"; else echo "FAIL $1: ${E#; }"; failed=$((failed + 1)); fi; E=""; }
asr() { runuser -u "$U" -- env HOME="$RH" RR_CONF="$CONF" RR_NOW="$NOW" "$@"; }      # as the runner user
asroot() { env RR_CONF="$CONF" RR_NOW="$NOW" "$@"; }                                 # as root (owner commands)
# reset-failed clears systemd's start limit (5 starts in 10 s), which the sandbox hits and a 1-minute timer never does
pass_at() { NOW="$1"; systemctl set-environment RR_NOW="$1"; systemctl reset-failed capstan-release.service 2>/dev/null
  systemctl start capstan-release.service 2>/dev/null; return 0; }
st() { awk -F '\t' -v n="$1" '$1==n { s=$2 } END { print (s=="" ? "pending" : s) }' "$RH/state.tsv"; }
ann() { awk -F '\t' -v n="$1" '$1==n { s=$2 } END { print s }' "$RH/announce.tsv"; }
prod_sha() { readlink "$SB/prod/current" | xargs basename; }
prod_has() { [ "$(cat "$SB/prod/current/u$1.txt" 2>/dev/null)" = "update $1" ]; }
main_sha() { git --git-dir="$SB/repos/private.git" rev-parse main; }
main_has() { git --git-dir="$SB/repos/private.git" cat-file -e "main:u$1.txt" 2>/dev/null; }
log_has() { grep -q -- "$1" "$RH/log/runner.log"; }
calls() { python3 - "$SB/standin/calls.jsonl" "$@" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
what = sys.argv[2]
if what == "count":   # count api method status [text-substring]
    api, m, s = sys.argv[3], sys.argv[4], int(sys.argv[5]); sub = sys.argv[6] if len(sys.argv) > 6 else ""
    print(sum(1 for r in rows if r["api"] == api and r["method"] == m and r["status"] == s and sub in (r.get("text") or "")))
elif what == "photos":  # ok sendPhoto posts in order: "<first line of caption>|<photo bytes>"
    for r in rows:
        if r["api"] == "telegram" and r["method"] == "sendPhoto" and r["status"] == 200:
            print((r["text"] or "").splitlines()[0] + "|" + str(r["photo"]))
elif what == "released_tags":
    for r in rows:
        if r["api"] == "github" and r["method"] == "releases_create" and r["status"] == 201 and r["release"] and not r["release"]["draft"]:
            print(r["release"]["tag"] + " " + (r["release"]["target"] or ""))
elif what == "assets":
    for r in rows:
        if r["api"] == "github" and r["method"] == "asset_upload" and r["status"] == 201:
            print(r["query"].replace("name=", "") + " " + str(r["size"]))
elif what == "total":
    print(len(rows))
PY
}

# ---------- world: repos, stand-ins, install ----------
setup_world() {
  rm -rf "$SB"; mkdir -p "$SB"/{repos,prod/releases,inject,bin,standin,seed}
  local g="git -c user.name=Sandbox -c user.email=sandbox@example.invalid -c commit.gpgsign=false -c init.defaultBranch=main"
  $g init -q --bare "$SB/repos/private.git"; $g init -q --bare "$SB/repos/queue.git"; $g init -q --bare "$SB/repos/public.git"
  $g init -q "$SB/seed"
  echo base > "$SB/seed/base.txt"; $g -C "$SB/seed" add -A; $g -C "$SB/seed" commit -q -m "chore: base"
  $g -C "$SB/seed" push -q "$SB/repos/private.git" main
  BASE=$($g -C "$SB/seed" rev-parse HEAD)
  $g -C "$SB/seed" checkout -q -b tu-queue
  for i in 1 2 3 4 5 6; do
    echo "update $i" > "$SB/seed/u$i.txt"; $g -C "$SB/seed" add -A; $g -C "$SB/seed" commit -q -m "feat(api): sandbox update $i"
  done
  $g -C "$SB/seed" push -q "$SB/repos/queue.git" tu-queue
  TIP=$($g -C "$SB/seed" rev-parse HEAD)

  # stand-in deploy wrapper (root, as provision.sh installs capstan-deploy): one release dir per sha, an atomic
  # "current" switch. inject/deploy-fail: switches, then reports a failed health check (exit 1).
  cat > /usr/local/sbin/capstan-deploy <<EOF
#!/bin/bash
set -u
sha="\${1:?sha}"; d="$SB/prod/releases/\$sha"
mkdir -p "\$d" && git --git-dir="$SB/repos/private.git" archive "\$sha" | tar -x -C "\$d" || exit 1
ln -sfn "\$d" "$SB/prod/current.new" && mv -T "$SB/prod/current.new" "$SB/prod/current"
echo "deploy \$sha" >> "$SB/prod/deploys.log"
[ -f "$SB/inject/deploy-fail" ] && { rm -f "$SB/inject/deploy-fail"; echo "health check failed (injected)"; exit 1; }
exit 0
EOF
  chmod 0755 /usr/local/sbin/capstan-deploy
  # stand-in gate: the update's file must be in the gated tree; inject/gate-N fails it; preflight-slow slows preflight
  cat > "$SB/bin/gate" <<EOF
#!/bin/bash
[ "\${RR_PREFLIGHT:-0}" = 1 ] && [ -f "$SB/inject/preflight-slow" ] && sleep 4
[ -f "$SB/inject/gate-\$1" ] && { echo "tests failed (injected)"; exit 1; }
[ "\$(cat "u\$1.txt" 2>/dev/null)" = "update \$1" ] || { echo "u\$1.txt missing from the gated tree"; exit 1; }
exit 0
EOF
  # stand-in public sync: copies the released tree to public.git as one commit "Update N"; a no-op when done
  cat > "$SB/bin/public-sync" <<EOF
#!/bin/bash
set -u
n="\$2"; sha="\$4"; w="$SB/public-work"
g() { git -c user.name="Capstan" -c user.email=release@example.invalid -c commit.gpgsign=false "\$@"; }
[ -d "\$w/.git" ] || g clone -q "$SB/repos/public.git" "\$w" 2>/dev/null
g -C "\$w" fetch -q origin 2>/dev/null; g -C "\$w" checkout -q -B main origin/main 2>/dev/null || g -C "\$w" checkout -q --orphan main
g -C "\$w" log --format=%s 2>/dev/null | grep -qx "Update \$n" && exit 0
find "\$w" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git --git-dir="$SB/repos/private.git" archive "\$sha" | tar -x -C "\$w"
g -C "\$w" add -A && g -C "\$w" commit -q -m "Update \$n" && g -C "\$w" push -q origin HEAD:main || exit 1
if [ -f "$SB/inject/publish-crash-\$n" ]; then rm -f "$SB/inject/publish-crash-\$n"; kill -9 "\$(cat $RH/run.lock/pid)"; sleep 5; fi
exit 0
EOF
  cat > "$SB/bin/public-ci" <<EOF
#!/bin/bash
[ -f "$SB/inject/public-ci-red" ] && exit 1; exit 0
EOF
  chmod 0755 "$SB/bin/"*

  : > "$SB/standin/calls.jsonl"; : > "$SB/standin/faults"
  python3 "$SRC/test/sandbox/standin.py" --telegram-port $TG_PORT --github-port $GH_PORT --token "$TG_TOKEN" \
    --gh-token "$GH_TOKEN" --record "$SB/standin/calls.jsonl" --faults "$SB/standin/faults" > "$SB/standin/out.log" 2>&1 &
  STANDIN_PID=$!
  for _ in $(seq 50); do grep -q listening "$SB/standin/out.log" && break; sleep 0.1; done
}

install_runner() {
  bash "$SRC/install.sh" > "$SB/install.out" 2>&1 || return 1
  # server-side settings for the sandbox: appended, so the last value wins (rr_conf_get reads the last line)
  cat >> "$CONF" <<EOF
# ---- sandbox (ops/release/test/sandbox) ----
EXPECTED_COUNT=6
TRANSIENT_MAX=3
SIGN_CHERRY_PICKS=0
ALLOW_LOCAL_REMOTES=1
GATE_CMD=$SB/bin/gate
PUBLIC_SYNC_CMD=$SB/bin/public-sync
PUBLIC_CI_CHECK_CMD=$SB/bin/public-ci
TELEGRAM_API=http://127.0.0.1:$TG_PORT
GITHUB_API=http://127.0.0.1:$GH_PORT
GITHUB_UPLOADS=http://127.0.0.1:$GH_PORT
ANNOUNCE_TRIES=2
ANNOUNCE_BACKOFF_S=0
ANNOUNCE_MAX_TIME_S=10
EOF
  (umask 077; printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=-1001234567890\n' "$TG_TOKEN" > /etc/capstan-release/telegram.env
   printf 'GITHUB_RELEASE_TOKEN=%s\nGITHUB_RELEASE_REPO=capstan-sandbox/public\n' "$GH_TOKEN" > /etc/capstan-release/github-release.env)
  # the queue repo belongs to the runner on the server too (git refuses a local repo another user owns)
  chown -R "$U:" "$SB/repos/private.git" "$SB/repos/public.git" "$SB/repos/queue.git"
  mkdir -p "$SB/public-work"; chown "$U:" "$SB/public-work"; rmdir "$SB/public-work"
  chown "$U:" "$SB"; chmod 0777 "$SB/inject"   # one-shot injections are removed by the runner-side stand-ins
  # the runner's commit identity (crypto-runner-bringup sets it with the signing key; install.sh does not): the
  # rollback revert and the cherry-picks are commits made by the runner
  asr git config --global user.name "Capstan Release" && asr git config --global user.email release@example.invalid
  asr git clone -q "$SB/repos/private.git" "$RH/backend" || return 1
  asr git -C "$RH/backend" remote add queue "$SB/repos/queue.git" && asr git -C "$RH/backend" fetch -q queue || return 1
  # per-update content checks, posters and notes (staged by the kit before launch)
  asr mkdir -p "$RH/checks" "$RH/posters" "$RH/notes"
  for i in 1 2 3 4 5 6; do
    cat > "$RH/checks/0$i.sh" <<EOF
#!/bin/bash
if [ -f "$SB/inject/check-crash-$i" ]; then rm -f "$SB/inject/check-crash-$i"; kill -9 "\$(cat $RH/run.lock/pid)"; sleep 5; fi
[ -f "$SB/inject/check-fail-$i" ] && { echo "content check failed (injected)"; exit 1; }
[ "\$(cat $SB/prod/current/u$i.txt 2>/dev/null)" = "update $i" ]
EOF
    head -c $((3000 + i)) /dev/urandom > "$RH/posters/update-0$i.png"
    printf 'What is new in update %s.\nSandbox notes line two.\n' "$i" > "$RH/notes/update-0$i.txt"
  done
  chown -R "$U:" "$RH"
}

# ---------- cases ----------
setup_world
L=$(date -u -d 2026-11-20T01:00:00Z +%s); H=3600

# 1. install as on the server
install_runner; rc=$?
want '[ "$rc" -eq 0 ]' "install.sh failed: $(tail -n 3 "$SB/install.out" | tr '\n' ' ')"
want 'id "$U" >/dev/null 2>&1' "runner user missing"
want 'visudo -c >/dev/null 2>&1' "sudoers invalid"
want '[ "$(systemctl is-enabled capstan-release.timer 2>/dev/null)" = disabled ]' "timer not disabled"
want '[ ! -e /etc/capstan-release/ALLOW_REAL_DEPLOY ]' "flag file present"
for w in notify announce ghrelease status pause resume retry preflight; do
  want "[ -x /usr/local/sbin/capstan-release-$w ]" "wrapper capstan-release-$w missing"
done
want 'sudo -n -u "$U" sudo -n -l /usr/local/sbin/capstan-release-announce >/dev/null 2>&1' "runner may not sudo the announcer"
want 'systemd-analyze verify /etc/systemd/system/capstan-release.service >/dev/null 2>&1' "unit does not verify"
endcase install "install.sh as root: user, sudoers (visudo ok), units verify, timer disabled, no flag, 8 root wrappers"

NOW=$((L - 86400))
asr /opt/capstan-release/bin/build-schedule.sh "$BASE" queue/tu-queue > "$SB/sched.out" 2>&1

# 2. an unarmed runner does nothing and posts nothing
pass_at "$L"
want '[ ! -s "$RH/state.tsv" ]' "state changed while unarmed"
want '[ "$(calls total)" -eq 0 ]' "stand-in APIs were called while unarmed"
want 'log_has "pass: not armed"' "no not-armed log line"
want '[ ! -e "$SB/prod/current" ]' "something was deployed"
endcase unarmed "the real unit ran a pass with no flag: no state, no deploy, 0 API calls"

# 3. arming refusals, one guard at a time, then arming
NOW=$((L - 86400)); out=$(asroot /opt/capstan-release/bin/arm.sh --check LAUNCH_AT=2026-11-20T01:00:00Z 2>&1)
for gd in stress-report release-token notify; do want "printf '%s' \"\$out\" | grep -q 'REFUSED $gd'" "no $gd refusal with nothing proven"; done
out=$(asroot /opt/capstan-release/bin/arm.sh --check LAUNCH_AT=2026-11-20T01:00:00 2>&1); want "printf '%s' \"\$out\" | grep -q 'REFUSED launch-at'" "no Z accepted"
out=$(asroot /opt/capstan-release/bin/arm.sh --check LAUNCH_AT=$(date -u -d @$((NOW + 300)) +%Y-%m-%dT%H:%M:%SZ) 2>&1); want "printf '%s' \"\$out\" | grep -q 'REFUSED launch-at'" "launch 5 minutes ahead accepted"
# the two proofs, through the real root wrappers against the stand-ins
/usr/local/sbin/capstan-release-notify --test > /dev/null 2>&1; /usr/local/sbin/capstan-release-ghrelease draft-test > /dev/null 2>&1
want '[ -f "$RH/notify.proof" ]' "notify --test made no proof"; want '[ -f "$RH/release-token.proof" ]' "draft-test made no proof"
want '[ "$(calls count github releases_delete 204)" -eq 1 ]' "draft release not deleted"
printf '# sandbox stand-in report\nQueue tip: %s\n' "$TIP" > "$RH/release-stress.md"
out=$(asroot /opt/capstan-release/bin/arm.sh --check LAUNCH_AT=2026-11-20T01:00:00Z 2>&1); want "printf '%s' \"\$out\" | grep -q \"REFUSED stress-report: the report does not say\"" "report without PASS accepted"
printf '# sandbox stand-in report\nResult: PASS\nQueue tip: %s\n' "$BASE" > "$RH/release-stress.md"
out=$(asroot /opt/capstan-release/bin/arm.sh --check LAUNCH_AT=2026-11-20T01:00:00Z 2>&1); want "printf '%s' \"\$out\" | grep -q 'REFUSED stress-report: the report is for another queue'" "report for another queue accepted"
printf '# sandbox stand-in report\nResult: PASS\nQueue tip: %s\n' "$TIP" > "$RH/release-stress.md"
touch "$SB/inject/public-ci-red"; out=$(asroot /opt/capstan-release/bin/arm.sh --check LAUNCH_AT=2026-11-20T01:00:00Z 2>&1); rm -f "$SB/inject/public-ci-red"
want "printf '%s' \"\$out\" | grep -q 'REFUSED public-ci'" "red public CI accepted"
sed -i 's/^ALLOW_LOCAL_REMOTES=1$/ALLOW_LOCAL_REMOTES=0/' "$CONF"; out=$(asroot /opt/capstan-release/bin/arm.sh --check LAUNCH_AT=2026-11-20T01:00:00Z 2>&1)
sed -i 's/^ALLOW_LOCAL_REMOTES=0$/ALLOW_LOCAL_REMOTES=1/' "$CONF"
want "printf '%s' \"\$out\" | grep -q 'REFUSED origins: remote origin points at a local path'" "local origin accepted"
want "printf '%s' \"\$out\" | grep -q 'REFUSED origins: TELEGRAM_API points at a stand-in'" "stand-in Telegram API accepted"
want "printf '%s' \"\$out\" | grep -q 'REFUSED origins: GITHUB_API points at a stand-in'" "stand-in GitHub API accepted"
asr git -C "$RH/backend" config url.https://example.invalid/.insteadOf git@example.invalid:
out=$(asroot /opt/capstan-release/bin/arm.sh --check LAUNCH_AT=2026-11-20T01:00:00Z 2>&1); asr git -C "$RH/backend" config --unset url.https://example.invalid/.insteadOf
want "printf '%s' \"\$out\" | grep -q 'REFUSED origins: url'" "url rewrite accepted"
git -c user.name=x -c user.email=x@example.invalid -c commit.gpgsign=false -C "$SB/seed" commit -q --allow-empty -m "chore: late extra"
runuser -u "$U" -- git -c safe.directory='*' -C "$SB/seed" push -q "$SB/repos/queue.git" tu-queue
out=$(asroot /opt/capstan-release/bin/arm.sh --check LAUNCH_AT=2026-11-20T01:00:00Z 2>&1)
want "printf '%s' \"\$out\" | grep -q 'REFUSED schedule'" "a moved queue tip accepted"
git -C "$SB/seed" reset -q --hard "$TIP"; runuser -u "$U" -- git -c safe.directory='*' -C "$SB/seed" push -q -f "$SB/repos/queue.git" tu-queue
want '[ ! -e /etc/capstan-release/ALLOW_REAL_DEPLOY ] && [ "$(systemctl is-enabled capstan-release.timer)" = disabled ]' "a refused arm changed something"
out=$(asroot /opt/capstan-release/bin/arm.sh LAUNCH_AT=2026-11-20T01:00:00Z 2>&1)
want "printf '%s' \"\$out\" | grep -q 'arm: ARMED'" "arm failed: $(printf '%s' "$out" | tr '\n' ' ')"
want '[ -e /etc/capstan-release/ALLOW_REAL_DEPLOY ] && [ "$(systemctl is-enabled capstan-release.timer)" = enabled ]' "arm left no flag or no enabled timer"
systemctl stop capstan-release.timer   # passes are started by hand below, at exact times; the timer is proven last
endcase arming "refused, naming the guard: stress-report (none, no PASS, other queue), release-token, notify, launch-at (no Z, too soon), public-ci, origins (local remote, url rewrite, stand-in APIs), schedule; refusals change nothing; then ARMED with flag and timer"

# 4. one update per slot, in order (and the team post carries the poster; one failed photo upload is retried)
echo "sendPhoto 500 1" > "$SB/standin/faults"
pass_at $((L - 60)); want '[ ! -s "$RH/state.tsv" ]' "released before launch"
pass_at "$L"; want '[ "$(st 1)" = released ] && prod_has 1 && main_has 1' "update 1 not live at its slot"
pass_at $((L + 300)); want '[ "$(st 2)" = pending ]' "update 2 released before its slot"
pass_at $((L + H - 1)); want '[ "$(st 2)" = pending ]' "update 2 released 1 s early"
want '[ "$(ann 1)" = announced ] && [ "$(calls count telegram sendPhoto 500)" -eq 1 ]' "photo retry not proven"
endcase one-per-slot "update 1 at its slot only; nothing before launch, nothing at slot+5min or 1 s before slot 2; failed photo upload retried"

# 5. rollback on a failed deploy (update 2, a fast-forward)
p1=$(prod_sha); touch "$SB/inject/deploy-fail"; pass_at $((L + H))
want '[ "$(st 2)" = held ]' "update 2 not held after a failed deploy (is $(st 2))"
want '[ "$(prod_sha)" = "$p1" ] && ! prod_has 2' "production not back on the previous version"
want '! main_has 2' "private main still carries update 2"
want 'grep -q "rollback\|deploy $p1" "$SB/prod/deploys.log" && [ "$(tail -n 1 "$SB/prod/deploys.log")" = "deploy $p1" ]' "no rollback deploy of the previous sha"
want '[ "$(calls count telegram sendMessage 200 "Update 2 ROLLED BACK")" -eq 1 ]' "no ROLLED BACK alert"
endcase rollback "deploy failed after the switch: production back on $(printf '%.7s' "$p1"), main reverted, held, one ROLLED BACK alert"

# 6. hold on a failing check: gate (update 3) and production content check (update 4); no cascade
touch "$SB/inject/gate-3"; pass_at $((L + 2 * H))
want '[ "$(st 3)" = held ] && [ "$(prod_sha)" = "$p1" ]' "update 3 not held before deploy"
want '[ "$(calls count telegram sendMessage 200 "HELD Update 3")" -eq 1 ]' "no HELD alert for 3"
touch "$SB/inject/check-fail-4"; pass_at $((L + 3 * H))
want '[ "$(st 4)" = held ] && ! main_has 4' "update 4 not held and reverted after its check failed"
want 'prod_has 1 && ! prod_has 2 && ! prod_has 3 && ! prod_has 4' "production is not back on update 1 content"
want '[ "$(git --git-dir="$SB/repos/private.git" rev-parse "$(prod_sha)^{tree}")" = "$(git --git-dir="$SB/repos/private.git" rev-parse "$p1^{tree}")" ]' "rollback did not restore the previous tree"
rm -f "$SB/inject/gate-3" "$SB/inject/check-fail-4"
endcase hold-on-failing-check "gate failure held 3 (never deployed); content-check failure deployed 4, rolled it back, held it; production stayed on update 1"

# 7. retry: held back to pending, released in order, one per pass, with the minimum gap
NOW=$((L + 3 * H + 60))
for n in 2 3 4; do /usr/local/sbin/capstan-release-retry "$n" > /dev/null 2>&1 || E="$E; retry wrapper failed for $n"; done
want '[ "$(stat -c %U "$RH/state.tsv")" = "$U" ]' "state.tsv not owned by the runner after retry"
pass_at $((L + 3 * H + 120)); want '[ "$(st 2)" = released ] && [ "$(st 3)" = pending ]' "retry order wrong after pass 1 (2=$(st 2) 3=$(st 3))"
pass_at $((L + 3 * H + 180)); want '[ "$(st 3)" = pending ]' "two releases within the minimum gap"
pass_at $((L + 3 * H + 240)); want '[ "$(st 3)" = released ]' "update 3 not released on retry"
pass_at $((L + 3 * H + 360)); want '[ "$(st 4)" = released ]' "update 4 not released on retry"
for n in 1 2 3 4; do want "prod_has $n && main_has $n" "update $n not live after the retries"; done
endcase retry "retry wrapper (as the runner user) put 2, 3, 4 back; released 2, 3, 4 in order, one per pass, none within the 2-minute gap; the rolled-back fast-forward (2) really shipped"

# 8. preflight never takes the lock
NOW=$((L + 4 * H - 900)); touch "$SB/inject/preflight-slow" "$SB/inject/gate-6"
/usr/local/sbin/capstan-release-preflight > "$SB/pf1.out" 2>&1 &
pf=$!; sleep 1
want '[ ! -d "$RH/run.lock" ]' "preflight holds the release lock"
pass_at $((L + 4 * H - 840)); want 'tail -n 3 "$RH/log/runner.log" | grep -q "pass: nothing due"' "a pass during preflight did not run normally"
wait "$pf"; rm -f "$SB/inject/preflight-slow"
want 'grep -q "preflight: 1 of 2 PASS" "$SB/pf1.out"' "preflight result wrong: $(tail -n 1 "$SB/pf1.out")"
want 'grep -q "^6	FAIL" "$RH/preflight/results.tsv"' "preflight did not flag update 6"
runuser -u "$U" -- bash -c "mkdir $RH/run.lock && echo \$\$ > $RH/run.lock/pid && exec sleep 60" & hjob=$!; sleep 1; holder=$(cat "$RH/run.lock/pid")
/usr/local/sbin/capstan-release-preflight > "$SB/pf2.out" 2>&1
want '[ "$(cat "$RH/run.lock/pid" 2>/dev/null)" = "$holder" ]' "preflight touched a held lock"
want 'grep -q "of 2 PASS" "$SB/pf2.out"' "preflight did not finish while the lock was held"
pass_at $((L + 4 * H - 780)); want 'tail -n 2 "$RH/log/runner.log" | grep -q "another pass is running"' "the lock was not really held"
kill "$holder" 2>/dev/null; wait "$hjob" 2>/dev/null; rm -rf "$RH/run.lock"; rm -f "$SB/inject/gate-6"
want '[ "$(stat -c %U "$RH/backend/.git")" = "$U" ] && [ -z "$(find "$RH/backend" -user root | head -n 1)" ]' "preflight left root-owned files in the work checkout"
endcase preflight-no-lock "preflight (sudo wrapper, as the runner) ran beside a normal pass and finished while another holder kept the lock; 1 of 2 PASS with 6 flagged"

# 9. pause and resume
NOW=$((L + 4 * H - 60)); /usr/local/sbin/capstan-release-pause "sandbox pause" > /dev/null 2>&1
pass_at $((L + 4 * H)); want '[ "$(st 5)" = pending ] && log_has "pass: paused"' "released while paused"
want '[ "$(calls count telegram sendMessage 200 "sandbox pause")" -eq 1 ]' "no pause post"
NOW=$((L + 4 * H + 60)); /usr/local/sbin/capstan-release-resume > /dev/null 2>&1
want '[ "$(calls count telegram sendMessage 200 "Next: Update 5")" -eq 1 ]' "no resume post naming update 5"
want '[ ! -e "$RH/PAUSE" ]' "PAUSE still there"
endcase pause-resume "paused at slot 5: no release, one post; resumed: one post naming update 5 next"

# 10. crash adoption from the journal: killed during the check (5), killed after the public copy (6)
touch "$SB/inject/check-crash-5"; pass_at $((L + 4 * H + 120))
want '[ "$(st 5)" = in_progress ] && [ -d "$RH/run.lock" ]' "crash at the check left no in_progress state and stale lock"
pass_at $((L + 4 * H + 180))
want 'log_has "update 5: adopting a crashed release (last stage: deployed, crash 1 of"' "crash at deployed not adopted"
want 'log_has "lock: taking over a stale lock"' "stale lock not taken over"
want '[ "$(st 5)" = released ] && prod_has 5 && main_has 5' "update 5 not released after adoption"
touch "$SB/inject/publish-crash-6"; pass_at $((L + 5 * H))
want '[ "$(st 6)" = in_progress ]' "crash at publishing left no in_progress state"
pass_at $((L + 5 * H + 60))
want 'log_has "update 6: adopting a crashed release (last stage: publishing, crash 1 of"' "crash at publishing not adopted"
want '[ "$(st 6)" = released ] && prod_has 6' "update 6 not released after adoption"
want '[ "$(git --git-dir="$SB/repos/public.git" log --format=%s main | grep -c "^Update 6$")" -eq 1 ]' "public copy of 6 made twice"
endcase crash-adoption "killed -9 in the check (5): next pass took the stale lock, redid it from the start; killed after the public copy (6): next pass finished it, public copy once"

# 11. the announcer posted the poster, once per update, in order; Releases with the poster attached
photos=$(calls photos); exp=""; for i in 1 2 3 4 5 6; do exp="$exp$(printf 'Update %s is live: sandbox update %s|%s' "$i" "$i" $((3000 + i)))
"; done
want '[ "$photos" = "${exp%?}" ]' "photo posts differ: $(printf '%s' "$photos" | tr '\n' ',')"
want '[ "$(calls count telegram sendPhoto 200 "What is new in update 3.")" -eq 1 ]' "notes not in the caption"
for i in 1 2 3 4 5 6; do want "[ \"\$(ann $i)\" = announced ]" "update $i not marked announced"; done
tags=$(calls released_tags | cut -d' ' -f1 | tr '\n' ' ')
want '[ "$tags" = "update-01 update-02 update-03 update-04 update-05 update-06 " ]' "releases: $tags"
want '[ "$(calls assets | tr "\n" " ")" = "update-01.png 3001 update-02.png 3002 update-03.png 3003 update-04.png 3004 update-05.png 3005 update-06.png 3006 " ]' "posters not attached: $(calls assets | tr '\n' ' ')"
endcase announcer-poster "6 sendPhoto posts, in order, each with its own poster bytes and notes caption; 6 Releases each with its poster asset"

# 12. end state: production snapshot, public copy, private main
want '[ "$(main_sha)" = "$(prod_sha)" ]' "production is not private main"
for i in 1 2 3 4 5 6; do want "prod_has $i" "u$i not in production"; done
pub=$(git --git-dir="$SB/repos/public.git" log --reverse --format='%s|%an' main | tr '\n' ' ')
want '[ "$pub" = "Update 1|Capstan Update 2|Capstan Update 3|Capstan Update 4|Capstan Update 5|Capstan Update 6|Capstan " ]' "public history: $pub"
want '[ -z "$(find "$RH" -user root -newer "$SB/install.out" ! -path "$RH/announce*" ! -name "ghrel.*" ! -name "*.proof" | head -n 3)" ]' "root-owned runner files: $(find "$RH" -user root -newer "$SB/install.out" ! -path "$RH/announce*" ! -name 'ghrel.*' ! -name '*.proof' | head -n 3 | tr '\n' ' ')"
endcase end-state "production = private main, all 6 live; public history 1..6 once each, one author; no root-owned runner state"

# 13. the timer starts passes by itself; disarm stops them
before=$(wc -l < "$RH/log/runner.log"); systemctl start capstan-release.timer
for _ in $(seq 100); do [ "$(wc -l < "$RH/log/runner.log")" -gt "$before" ] && break; sleep 1; done
want '[ "$(wc -l < "$RH/log/runner.log")" -gt "$before" ]' "the timer started no pass in 100 s"
asroot /opt/capstan-release/bin/disarm.sh > /dev/null; systemctl stop capstan-release.timer; pass_at $((L + 6 * H))
want 'tail -n 1 "$RH/log/runner.log" | grep -q "pass: not armed"' "a pass ran armed after disarm"
endcase timer-disarm "the enabled timer ran a pass on its own; after disarm.sh a pass does nothing"

kill "$STANDIN_PID" 2>/dev/null
echo "sandbox: $((13 - failed)) of 13 cases PASS"
[ "$failed" -eq 0 ]
