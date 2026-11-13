#!/bin/bash
# Release stress test on the REAL queue, container side (run by run.sh when STRESS_REPO is set). The runner is
# installed as on the server (install.sh as root), then releases every update of the real queue (/src/queue, a bare
# copy of the backend repo; STRESS_BASE..STRESS_TIP) through the real unit, at compressed slots (RR_NOW per pass),
# against local bare repos and stand-in deploy, Telegram and GitHub endpoints on 127.0.0.1. Nothing leaves the
# container. Injected along the way: gate failure, deploy failure after the switch, a deploy that switched nothing,
# network failure (stand-in APIs down, queue repo unreachable), crashes mid-pass (gate, check, after the public copy),
# clock skew (back two hours, forward five slots), a slow update overrunning its slot. Each update has its own content
# check (files it changed, read from production), proven to FAIL on the production before it.
# Prints one "PASS <case>: ..." or "FAIL <case>: ..." line per case and the arm.sh refusal list before and after the
# stress report (/src/report.md when mounted). STRESS_ARM_ONLY=1 stops after the arm check.
set -u
SRC=/src/release; Q=/src/queue; SB=/srv/sandbox; RH=/var/lib/capstan-release; CONF=/etc/capstan-release/release.conf
TG_PORT=25530; GH_PORT=25531
TG_TOKEN="123456789:SandboxStandinTokenNotRealCCCCCCCC"; GH_TOKEN="sandbox-standin-not-a-real-token"
PUB_EMAIL=1+capstandev@users.noreply.github.com; WORD=zebracorn   # stands in for the owner's forbidden words
U=capstan-release; NOW=0; QBASE="${STRESS_BASE:?STRESS_BASE}"; QTIP="${STRESS_TIP:?STRESS_TIP}"
export GIT_CONFIG_NOSYSTEM=1
failed=0; cases=0
G="git -c safe.directory=* -c user.name=Sandbox -c user.email=sandbox@example.invalid -c commit.gpgsign=false"

E=""
want() { if ! eval "$1"; then E="$E; $2"; fi; }
endcase() { cases=$((cases + 1)); if [ -z "$E" ]; then echo "PASS $1: $2"; else echo "FAIL $1: ${E#; }"; failed=$((failed + 1)); fi; E=""; }
asr() { runuser -u "$U" -- env HOME="$RH" RR_CONF="$CONF" RR_NOW="$NOW" "$@"; }
asroot() { env RR_CONF="$CONF" RR_NOW="$NOW" "$@"; }
pass_at() { NOW="$1"; systemctl set-environment RR_NOW="$1"; systemctl reset-failed capstan-release.service 2>/dev/null
  systemctl start capstan-release.service 2>/dev/null; return 0; }
st() { awk -F '\t' -v n="$1" '$1==n { s=$2 } END { print (s=="" ? "pending" : s) }' "$RH/state.tsv"; }
ann() { awk -F '\t' -v n="$1" '$1==n { s=$2 } END { print s }' "$RH/announce.tsv"; }
qsha() { awk -F '\t' -v n="$1" '$1==n { print $3 }' "$RH/schedule.tsv"; }
slot() { echo $((L + ($1 - 1) * H)); }
pgit() { $G --git-dir="$SB/repos/private.git" "$@"; }
qgit() { $G --git-dir="$SB/repos/queue.git" "$@"; }   # the queue's own commits live here, not on private main
qtree() { qgit rev-parse "$1^{tree}"; }
prod_sha() { readlink "$SB/prod/current" | xargs basename; }
prod_tree() { pgit rev-parse "$(prod_sha)^{tree}"; }
prod_is() { [ "$(prod_tree)" = "$(qtree "$(qsha "$1")")" ]; }   # production runs exactly update n
main_is() { [ "$(pgit rev-parse "main^{tree}")" = "$(qtree "$(qsha "$1")")" ]; }
log_has() { grep -q -- "$1" "$RH/log/runner.log"; }
own_check_fails_now() { asr /opt/capstan-release/bin/check-update.sh "$1" x > /dev/null 2>&1 && return 1; return 0; }
calls() { python3 - "$SB/standin/calls.jsonl" "$@" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
what = sys.argv[2]
if what == "count":
    api, m, s = sys.argv[3], sys.argv[4], int(sys.argv[5]); sub = sys.argv[6] if len(sys.argv) > 6 else ""
    print(sum(1 for r in rows if r["api"] == api and r["method"] == m and r["status"] == s and sub in (r.get("text") or "")))
elif what == "live":   # "Update N is live" posts (photo or text), in order: N per line
    import re
    for r in rows:
        if r["api"] == "telegram" and r["method"] in ("sendPhoto", "sendMessage") and r["status"] == 200:
            m = re.match(r"Update (\d+) is live", r.get("text") or "")
            if m: print(m.group(1))
elif what == "released_tags":
    for r in rows:
        if r["api"] == "github" and r["method"] == "releases_create" and r["status"] == 201 and r["release"] and not r["release"]["draft"]:
            print(r["release"]["tag"])
PY
}
standin_up() {
  python3 "$SRC/test/sandbox/standin.py" --telegram-port $TG_PORT --github-port $GH_PORT --token "$TG_TOKEN" \
    --gh-token "$GH_TOKEN" --record "$SB/standin/calls.jsonl" --faults "$SB/standin/faults" >> "$SB/standin/out.log" 2>&1 &
  STANDIN_PID=$!
  for _ in $(seq 50); do [ "$(grep -c listening "$SB/standin/out.log")" -ge "$1" ] && return 0; sleep 0.1; done
}
standin_down() { kill "$STANDIN_PID" 2>/dev/null; wait "$STANDIN_PID" 2>/dev/null; }

# ---------- world: the real queue in local bare repos ----------
rm -rf "$SB"; mkdir -p "$SB"/{repos,prod/releases,inject,bin,standin}
for r in private queue public; do $G init -q --bare -b main "$SB/repos/$r.git"; done
pgit fetch -q "$Q" "refs/heads/main:refs/heads/main" 2>/dev/null || pgit fetch -q "$Q" "+$QBASE:refs/heads/main"
[ "$(pgit rev-parse main)" = "$QBASE" ] || pgit update-ref refs/heads/main "$QBASE"
$G --git-dir="$SB/repos/queue.git" fetch -q "$Q" "+refs/heads/*:refs/remotes/src/*"
# the public copy, bootstrapped as publish-public.sh does (one signed empty commit by capstandev, a throwaway key)
mkdir -p "$SB/keys"; ssh-keygen -q -t ed25519 -N '' -C sandbox-public-sync -f "$SB/keys/sign"
PUB_BASE=$(GIT_AUTHOR_NAME=capstandev GIT_AUTHOR_EMAIL=$PUB_EMAIL GIT_COMMITTER_NAME=capstandev GIT_COMMITTER_EMAIL=$PUB_EMAIL \
  $G --git-dir="$SB/repos/public.git" -c gpg.format=ssh -c user.signingkey="$SB/keys/sign" commit-tree -S "$($G --git-dir="$SB/repos/public.git" hash-object -t tree /dev/null)" -m "chore: start the public repository")
$G --git-dir="$SB/repos/public.git" update-ref refs/heads/main "$PUB_BASE"
printf '%s %s\n' "$PUB_EMAIL" "$(cat "$SB/keys/sign.pub")" > "$SB/keys/allowed"
qref=$($G --git-dir="$SB/repos/queue.git" for-each-ref --format='%(refname)' --contains "$QTIP" refs/remotes/src | head -n 1)
$G --git-dir="$SB/repos/queue.git" update-ref refs/heads/tu-queue "$QTIP"
COUNT=$($G --git-dir="$SB/repos/queue.git" rev-list --count "$QBASE..$QTIP")

# stand-in deploy: one release dir per sha (git archive), an atomic "current" switch, old dirs pruned (keep 3).
# inject/deploy-fail (one shot): switches, then the health check fails (exit 1). deploy-net: nothing switched (exit 75).
# deploy-slow: the deploy takes 8 s (a slow update overrunning its slot).
cat > /usr/local/sbin/capstan-deploy <<EOF
#!/bin/bash
set -u
sha="\${1:?sha}"; d="$SB/prod/releases/\$sha"
[ -f "$SB/inject/deploy-net" ] && { rm -f "$SB/inject/deploy-net"; echo "network: could not reach the build host (injected)"; exit 75; }
[ -f "$SB/inject/deploy-slow" ] && { rm -f "$SB/inject/deploy-slow"; sleep 8; }
rm -rf "\$d"; mkdir -p "\$d" && git -c safe.directory='*' --git-dir="$SB/repos/private.git" archive "\$sha" | tar -x -C "\$d" || exit 1
ln -sfn "\$d" "$SB/prod/current.new" && mv -T "$SB/prod/current.new" "$SB/prod/current"
echo "deploy \$sha" >> "$SB/prod/deploys.log"
cur=\$(readlink "$SB/prod/current"); ls -1dt "$SB/prod/releases/"* | tail -n +4 | while read -r o; do [ "\$o" = "\$cur" ] || rm -rf "\$o"; done
[ -f "$SB/inject/deploy-fail" ] && { rm -f "$SB/inject/deploy-fail"; echo "health check failed (injected)"; exit 1; }
exit 0
EOF
chmod 0755 /usr/local/sbin/capstan-deploy
# stand-in gate: the gated tree must be EXACTLY the queue's tree for update N (every earlier update live, nothing
# else); inject/gate-N fails it; gate-crash-N kills the pass inside the gate
cat > "$SB/bin/gate" <<EOF
#!/bin/bash
q=\$(awk -F '\t' -v n="\$1" '\$1==n { print \$3 }' $RH/schedule.tsv)
if [ -f "$SB/inject/gate-crash-\$1" ]; then rm -f "$SB/inject/gate-crash-\$1"; kill -9 "\$(cat $RH/run.lock/pid)"; sleep 5; fi
[ -f "$SB/inject/gate-\$1" ] && { rm -f "$SB/inject/gate-\$1"; echo "tests failed (injected)"; exit 1; }
[ "\$(git rev-parse HEAD^{tree})" = "\$(git rev-parse "\$q^{tree}")" ] || { echo "gated tree is not the queue tree of update \$1"; exit 1; }
exit 0
EOF
# public sync: the REAL bin/public-sync.sh as installed; this wrapper only adds the kill -9 injection after the copy
cat > "$SB/bin/public-sync" <<EOF
#!/bin/bash
/opt/capstan-release/bin/public-sync.sh "\$@" || exit \$?
if [ -f "$SB/inject/publish-crash-\$2" ]; then rm -f "$SB/inject/publish-crash-\$2"; kill -9 "\$(cat $RH/run.lock/pid)"; sleep 5; fi
exit 0
EOF
printf '#!/bin/bash\nexit 0\n' > "$SB/bin/public-ci"
chmod 0755 "$SB/bin/"*
: > "$SB/standin/calls.jsonl"; : > "$SB/standin/faults"; : > "$SB/standin/out.log"
standin_up 1

# ---------- install as on the server ----------
bash "$SRC/install.sh" > "$SB/install.out" 2>&1; irc=$?
cat >> "$CONF" <<EOF
# ---- stress (ops/release/test/sandbox/stress72.sh) ----
QUEUE_REF=queue/tu-queue
EXPECTED_COUNT=$COUNT
TRANSIENT_MAX=4
SIGN_CHERRY_PICKS=0
ALLOW_LOCAL_REMOTES=1
GATE_CMD=$SB/bin/gate
PUBLIC_SYNC_CMD=$SB/bin/public-sync
PUBLIC_REMOTE_URL=$SB/repos/public.git
PUBLIC_PUSH_KEY=
PUBLIC_KNOWN_HOSTS=
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
python3 - "$QBASE" "$PUB_BASE" "$PUB_EMAIL" "$WORD" > /etc/capstan-release/public/state.json <<'PY2'
import json, sys
priv, pub, email, word = sys.argv[1:5]
print(json.dumps({"privateSha": priv, "publicSha": pub, "name": "capstandev", "email": email, "signingKey": "/unused.pub",
                  "publicRemote": "public", "branch": "main", "projectName": "Capstan", "scrub": {}, "forbidden": word,
                  "publicUrl": "/unused"}, indent=1))
PY2
install -o root -g "$U" -m 0640 "$SB/keys/sign" /etc/capstan-release/public/id_ed25519_sign
chown root:"$U" /etc/capstan-release/public/state.json; chmod 0640 /etc/capstan-release/public/state.json
chown -R "$U:" "$SB/repos"; chown "$U:" "$SB"; chmod 0777 "$SB/inject"
asr git config --global user.name "Capstan Release"; asr git config --global user.email release@example.invalid
asr git clone -q "$SB/repos/private.git" "$RH/backend"
asr git -C "$RH/backend" remote add queue "$SB/repos/queue.git"; asr git -C "$RH/backend" fetch -q queue
asr mkdir -p "$RH/checks" "$RH/posters" "$RH/notes"
L=$(date -u -d 2026-11-20T01:00:00Z +%s); H=3600; NOW=$((L - 86400))
asr /opt/capstan-release/bin/build-schedule.sh "$QBASE" queue/tu-queue > "$SB/sched.out" 2>&1
# each update's own check: up to 4 files it changed (no renames), read from production by content
for n in $(seq "$COUNT"); do
  sha=$(qsha "$n"); f="$RH/checks/$(printf '%02d' "$n").sh"
  { echo '#!/bin/bash'
    echo "# own check of update $n ($sha): the files it changed, as it left them, in production"
    echo "P=$SB/prod/current"
    echo "if [ -f $SB/inject/check-crash-$n ]; then rm -f $SB/inject/check-crash-$n; kill -9 \"\$(cat $RH/run.lock/pid)\"; sleep 5; fi"
    qgit diff-tree --no-commit-id -r --no-renames --raw "$sha^" "$sha" | grep -v $'\tCHANGELOG.md$' | head -n 4 |
      while IFS=$'\t' read -r meta path; do
        set -- $meta; qp=$(printf '%q' "$path")
        if [ "$5" = D ]; then echo "[ ! -e \"\$P\"/$qp ] || { echo 'still there: '$qp; exit 1; }"
        else echo "[ \"\$(git hash-object \"\$P\"/$qp 2>/dev/null)\" = $4 ] || { echo 'not as update $n left it: '$qp; exit 1; }"; fi
      done
    echo 'exit 0'
  } > "$f"
  t=$(printf 'update-%02d' "$n")
  head -c $((2000 + n)) /dev/urandom > "$RH/posters/$t.png"
  if [ -f "/src/notes/$(printf '%02d' "$n").md" ]; then cp "/src/notes/$(printf '%02d' "$n").md" "$RH/notes/$t.txt"
  else printf 'What is new in update %s.\n' "$n" > "$RH/notes/$t.txt"; fi
done
chown -R "$U:" "$RH"
nchecks=$(grep -l 'hash-object\|! -e' "$RH"/checks/*.sh | wc -l)
want '[ "$irc" -eq 0 ]' "install.sh failed"
want 'grep -q "build-schedule: $COUNT updates" "$SB/sched.out"' "schedule: $(cat "$SB/sched.out")"
want '[ "$(awk "/^# tip/ { print \$3 }" "$RH/schedule.tsv")" = "$QTIP" ]' "schedule tip is not $QTIP"
want '[ "$nchecks" -eq "$COUNT" ]' "only $nchecks of $COUNT updates have a content check"
endcase queue "real queue ${QTIP:0:7} on ${QBASE:0:7} (${qref#refs/remotes/src/}): $COUNT updates scheduled in order, $nchecks own content checks"

# ---------- arm.sh refusal list before and after the stress report ----------
/usr/local/sbin/capstan-release-notify --test > /dev/null 2>&1; /usr/local/sbin/capstan-release-ghrelease draft-test > /dev/null 2>&1
LA=$(date -u -d @"$L" +%Y-%m-%dT%H:%M:%SZ)
echo "arm-check before (no stress report):"; asroot /opt/capstan-release/bin/arm.sh --check LAUNCH_AT="$LA" 2>&1 | sed 's/^/  /'
if [ -f /src/report.md ]; then
  cp /src/report.md "$RH/release-stress.md"; chown "$U:" "$RH/release-stress.md"
  echo "arm-check after (stress report $(sed -n 's/^Queue tip: //p' /src/report.md | head -c 12)):"
  out=$(asroot /opt/capstan-release/bin/arm.sh --check LAUNCH_AT="$LA" 2>&1); printf '%s\n' "$out" | sed 's/^/  /'
  want "printf '%s' \"\$out\" | grep -q 'every guard passed'" "arm.sh refused the stress report"
  endcase arm-accepts-report "arm.sh --check passes every guard with the stress report for ${QTIP:0:7}"
fi
[ "${STRESS_ARM_ONLY:-0}" = 1 ] && { echo "stress: $((cases - failed)) of $cases cases PASS (arm check only)"; [ "$failed" -eq 0 ]; exit; }

# every check fails on the production that runs the base (recorded FAIL before any release)
/usr/local/sbin/capstan-deploy "$QBASE" > /dev/null
pre_ok=0; for n in $(seq "$COUNT"); do own_check_fails_now "$n" && pre_ok=$((pre_ok + 1)); done
want '[ "$pre_ok" -eq "$COUNT" ]' "only $pre_ok of $COUNT checks fail on the base production"
endcase checks-fail-before "$pre_ok of $COUNT own checks FAIL against the base production"

[ -f "$RH/release-stress.md" ] || printf 'Result: PASS\nQueue tip: %s\n' "$QTIP" > "$RH/release-stress.md"
chown "$U:" "$RH/release-stress.md"
NOW=$((L - 86400)); out=$(asroot /opt/capstan-release/bin/arm.sh LAUNCH_AT="$LA" 2>&1)
want "printf '%s' \"\$out\" | grep -q 'arm: ARMED'" "arm failed: $(printf '%s' "$out" | tr '\n' ' ')"
systemctl stop capstan-release.timer

# ---------- the run: one update per slot, failures injected on the way ----------
order_bad=""; check_bad=""; nextfail=""
release_at() { # release_at n time: one pass; update n must be live, production exactly its tree, its own check passing
  local n="$1"
  [ "${3:-}" = nopre ] || own_check_fails_now "$n" || nextfail="$nextfail $n"
  pass_at "$2"
  [ "$(st "$n")" = released ] && prod_is "$n" && main_is "$n" || order_bad="$order_bad $n($(st "$n"))"
  [ "$n" -lt "$COUNT" ] && [ "$(st $((n + 1)))" != pending ] && order_bad="$order_bad $((n + 1))-early"
  asr /opt/capstan-release/bin/check-update.sh "$n" x > /dev/null 2>&1 || check_bad="$check_bad $n"
}
n=1
while [ "$n" -le "$COUNT" ]; do
  s=$(slot "$n")
  case "$n" in
  5) # gate failure: held, never deployed, next update not blocked; retried and released in order
    p=$(prod_sha); touch "$SB/inject/gate-5"; pass_at "$s"
    want '[ "$(st 5)" = held ] && [ "$(prod_sha)" = "$p" ] && main_is 4' "gate failure: 5 is $(st 5), production or main moved"
    want '[ "$(calls count telegram sendMessage 200 "HELD Update 5")" -eq 1 ]' "no HELD alert for 5"
    NOW=$((s + 60)); /usr/local/sbin/capstan-release-retry 5 > /dev/null 2>&1
    release_at 5 $((s + 180))
    endcase gate-fail "update 5 held on a failed gate (production stayed on 4, one HELD alert), retried, released next pass" ;;
  12) # deploy fails after the switch: rolled back, main reverted, held; retried as a cherry-pick from then on
    p=$(prod_sha); touch "$SB/inject/deploy-fail"; pass_at "$s"
    want '[ "$(st 12)" = held ] && [ "$(prod_sha)" = "$p" ] && main_is 11' "rollback: 12 is $(st 12), production $(prod_sha | head -c 7), main not back on 11"
    want '[ "$(calls count telegram sendMessage 200 "Update 12 ROLLED BACK")" -eq 1 ]' "no ROLLED BACK alert"
    NOW=$((s + 60)); /usr/local/sbin/capstan-release-retry 12 > /dev/null 2>&1
    release_at 12 $((s + 180))
    endcase deploy-fail-rollback "update 12 deploy failed after the switch: production back on 11, main reverted, held; retried and released; every later update is a cherry-pick on the revert" ;;
  20) # network failure: Telegram and GitHub stand-ins down during the release; the release still goes out
    standin_down; release_at 20 "$s"
    want '[ "$(ann 20)" = owed ]' "post for 20 not owed with Telegram down ($(ann 20))"
    pass_at $((s + 600)); want '[ "$(st 21)" = pending ] && [ "$(ann 20)" = owed ]' "outage pass changed state"
    standin_up 2; pass_at $((s + 1200))
    want '[ "$(ann 20)" = announced ]' "owed post for 20 not sent when Telegram came back ($(ann 20))"
    endcase network-apis-down "Telegram and GitHub unreachable at slot 20: released, production on 20, post owed; sent once on the next pass after they came back" ;;
  21) # network failure to git: the queue repo is unreachable; nothing switches, retried, released
    mv "$SB/repos/queue.git" "$SB/repos/queue.git.away"; p=$(prod_sha); pass_at "$s"
    want '[ "$(st 21)" = pending ] && [ "$(prod_sha)" = "$p" ] && log_has "update 21: fetch failed (transient"' "queue unreachable: 21 is $(st 21)"
    mv "$SB/repos/queue.git.away" "$SB/repos/queue.git"; release_at 21 $((s + 60))
    endcase network-git-down "queue repo unreachable at slot 21: stayed pending, production unchanged; released the next pass" ;;
  25) # deploy cannot reach its host: exit 75, nothing switched, retried
    p=$(prod_sha); touch "$SB/inject/deploy-net"; pass_at "$s"
    want '[ "$(st 25)" = pending ] && [ "$(prod_sha)" = "$p" ]' "deploy 75: 25 is $(st 25)"
    release_at 25 $((s + 60))
    endcase deploy-nothing-switched "deploy exit 75 at slot 25: pending, production unchanged, released the next pass" ;;
  30|31|33) # crashes mid-pass: in the check (30), after the public copy (31), in the gate (33)
    own_check_fails_now "$n" || nextfail="$nextfail $n"
    case "$n" in 30) touch "$SB/inject/check-crash-30" ;; 31) touch "$SB/inject/publish-crash-31" ;; 33) touch "$SB/inject/gate-crash-33" ;; esac
    pass_at "$s"; want "[ \"\$(st $n)\" = in_progress ]" "crash at $n left no in_progress state"
    release_at "$n" $((s + 60)) nopre
    want "log_has 'update $n: adopting a crashed release'" "crash of $n not adopted"
    if [ "$n" = 33 ]; then
      want '[ "$(git --git-dir="$SB/repos/public.git" rev-list --count --first-parent "$PUB_BASE..main")" -eq "$(pgit rev-list --count --first-parent "$QBASE..main")" ]' "public copy of 30 or 31 not exactly once"
      endcase crash-mid-pass "killed -9 in the check (30), after the public copy (31), in the gate (33): each adopted from the journal next pass, released once, public copy once"
    fi ;;
  40) # clock skew: back two hours after 40, then forward five slots: no repeat, no burst, gap kept
    release_at 40 "$s"
    pass_at $((s - 7200)); want '[ "$(st 41)" = pending ]' "41 released with the clock two hours back"
    own_check_fails_now 41 || nextfail="$nextfail 41"
    pass_at $((s + 5 * H)); asr /opt/capstan-release/bin/check-update.sh 41 x > /dev/null 2>&1 || check_bad="$check_bad 41"; want '[ "$(st 41)" = released ] && [ "$(st 42)" = pending ]' "forward jump: 41=$(st 41) 42=$(st 42) (burst?)"
    pass_at $((s + 5 * H + 30)); want '[ "$(st 42)" = pending ]' "two releases within the minimum gap after the jump"
    for k in 42 43 44 45; do release_at "$k" $((s + 5 * H + (k - 41) * 150)); done
    n=45
    endcase clock-skew "clock back 2 h after 40: nothing released; forward 5 slots: 41..45 caught up one per pass, never within the 2-minute gap" ;;
  50) # a slow update overruns its slot: a second pass meanwhile does nothing; the next update follows late, in order
    own_check_fails_now 50 || nextfail="$nextfail 50"
    touch "$SB/inject/deploy-slow"; NOW=$s; systemctl set-environment RR_NOW="$s"; systemctl reset-failed capstan-release.service
    systemctl start --no-block capstan-release.service; sleep 2
    NOW=$((s + H + 60)); out=$(asr env CAPSTAN_RELEASE_RUNNER=1 /opt/capstan-release/bin/release-pass.sh 2>&1)
    want 'tail -n 3 "$RH/log/runner.log" | grep -q "another pass is running"' "a second pass ran during the slow update"
    want '[ "$(st 51)" = pending ]' "51 released while 50 was still running"
    for _ in $(seq 30); do [ "$(systemctl is-active capstan-release.service)" = active ] || [ "$(systemctl is-active capstan-release.service)" = activating ] || break; sleep 1; done
    want '[ "$(st 50)" = released ] && prod_is 50' "slow update 50 not released ($(st 50))"
    asr /opt/capstan-release/bin/check-update.sh 50 x > /dev/null 2>&1 || check_bad="$check_bad 50"
    release_at 51 $((s + H + 120))
    n=51
    endcase slow-overrun "update 50 deployed for 8 s past its slot: the pass meanwhile found the lock and did nothing; 51 released late, in order" ;;
  *) release_at "$n" "$s" ;;
  esac
  n=$((n + 1))
done
want '[ -z "$order_bad" ]' "not live in order:$order_bad"
want '[ -z "$check_bad" ]' "own check failed after release:$check_bad"
want '[ -z "$nextfail" ]' "own check passed BEFORE its release:$nextfail"
endcase all-in-order "$COUNT updates released in order at their slots; production exactly each update's tree after its pass; each own check FAIL before and PASS after"

# ---------- end state ----------
pass_at $(( $(slot "$COUNT") + 600 ))   # one more pass: anything owed is retried
pub=$(git --git-dir="$SB/repos/public.git" log --reverse --first-parent --format='%s|%an' "$PUB_BASE..main")
exp=$(pgit log --reverse --first-parent --format='%s|capstandev' "$QBASE..main")
unsigned=$(git --git-dir="$SB/repos/public.git" -c gpg.ssh.allowedSignersFile="$SB/keys/allowed" log --format='%G?' main | grep -vc '^G$')
want '[ "$(pgit rev-parse main)" = "$(prod_sha)" ]' "production $(prod_sha | head -c 7) is not private main $(pgit rev-parse main | head -c 7)"
want '[ "$(pgit rev-parse main^{tree})" = "$(qtree "$QTIP")" ]' "private main tree is not the queue tip tree"
want '[ -n "$exp" ] && [ "$pub" = "$exp" ]' "public history is not the private first-parent history once each by one author"
want '[ "$unsigned" -eq 0 ]' "$unsigned public commits not signed by the capstandev key"
want '[ "$(git --git-dir="$SB/repos/public.git" rev-parse main^{tree})" = "$(qtree "$QTIP")" ]' "public tree is not the queue tip tree"
live=$(calls live | sort -n | uniq -c | awk '$1!=1' | head -n 3)
want '[ "$(calls live | sort -n | uniq | wc -l)" -eq "$COUNT" ] && [ -z "$live" ]' "team posts not once each: $(calls live | sort -n | uniq | wc -l) distinct, repeats: $live"
tags=$(calls released_tags | sort | uniq | wc -l)
want '[ "$tags" -eq "$COUNT" ]' "$tags of $COUNT GitHub Releases made"
want '[ "$(awk -F "\t" "\$2==\"released\"" "$RH/state.tsv" | wc -l)" -eq "$COUNT" ] && [ ! -e "$RH/PAUSE" ]' "not every update released, or paused"
endcase end-state "production = private main tip, tree = queue tip ${QTIP:0:7}; public history = private first-parent history once each (real public sync), signed, one author; $COUNT team posts once each; $tags Releases"

standin_down
echo "stress: $((cases - failed)) of $cases cases PASS"
[ "$failed" -eq 0 ]
