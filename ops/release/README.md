# Release runner

Releases a queue of finished, tested updates one at a time on a schedule (default: 72 updates, one an hour), from the
server, with no person in the loop. Plain bash, no dependencies beyond git and curl; runs under macOS bash 3.2 and
Linux bash 5.

## What one release does
1. **Gate**: apply the update on private main (fast-forward, or a signed cherry-pick), run the light gate
   (`bin/gate-light.sh`: frozen install, typecheck, the tests of what it touched, the public guard).
2. **Push** private main.
3. **Deploy** (`DEPLOY_CMD`, with health checks); **check** production by content (`bin/check-update.sh` runs the
   update's own check, which was recorded as failing on production before the release).
4. Only then the **public copy** (`bin/publish-public.sh`), the **GitHub Release** (`bin/ghrelease.sh`, poster
   attached when staged) and **one team post** ("Update N is live"): `bin/announce-telegram.sh` sends the staged
   poster `posters/<tag>.png` with the notes `notes/<tag>.txt` as its caption (`sendPhoto`; past 1,024 characters the
   rest follows as messages), retries with backoff (Telegram's `retry_after` on a 429), and falls back to text only
   with a "Poster missing" line. The release is marked announced only when the post went out; until then it is owed
   and retried one per pass. `ANNOUNCE_DRY_RUN=1` (or `announce-telegram.sh --dry-run`) renders it and sends nothing.

| Failure | What happens |
| --- | --- |
| Gate fails | That update is held, the team is told; the next update still releases at its slot |
| Exit 75 from gate, push or deploy ("nothing switched") | Stays pending and is retried each pass; held after `TRANSIENT_MAX` tries |
| Deploy or check fails | Rolled back to the previous version, private main reverted, held, team told |
| Rollback fails | `PAUSE` file written, alert, update marked held (never left half done) |
| Crash or reboot mid-release | The next pass reads the journal and finishes or redoes it; the public copy is never made twice |
| The same update crashes its pass again and again | After `CRASH_MAX` (3) adoptions: `PAUSE` file, one alert; resuming starts the count again |
| Public copy or Release fails | The update stays live; it is retried later (an owed Release page, one per pass); later updates are not blocked |
| Team post fails | The update stays live; the post is owed and retried each pass (no part twice); one alert after `ANNOUNCE_MAX_PASSES` |
| Main moved under the queue | That update is held with one "queue needs a rebase" alert |

Alerts are keyed by cause (one alert, then at most an hourly reminder). An unarmed runner posts nothing.

## Guards
- **Real-deploy guard**: a pass does anything only when the flag file (`FLAG_FILE`) exists AND the unit sets
  `CAPSTAN_RELEASE_RUNNER=1`. Only `bin/arm.sh` creates the flag; `install.sh` removes it.
- **Arming** (`bin/arm.sh LAUNCH_AT=<ISO UTC>`) refuses, naming the guard, unless: the launch time is UTC with `Z`
  and ahead, `OWNER_TZ` is set, the stress-test report says `Result: PASS` for this exact queue tip, the schedule
  matches the checkouts, public CI is green, the release token and the team alert were both proven, and no stand-in
  origins remain. `--check` runs the guards only.
- **Preflight** (`bin/preflight.sh`) runs the gate on every pending and held update ahead of its slot. It never takes
  the release lock.

## Commands
| Command | Use |
| --- | --- |
| `bin/build-schedule.sh <base> <tip> [launch]` | Schedule from the queue (one straight line on top of base) |
| `bin/verify-schedule.sh` | Schedule base and tip equal the checkouts |
| `bin/preflight.sh` | Gate every pending and held update now |
| `bin/arm.sh [--check] LAUNCH_AT=...` | Arm (the last step) |
| `bin/set-times.sh <ISO UTC>` | Move the launch: every slot moves, order kept, backup kept |
| `bin/status.sh [n]` | Armed, paused, counts, held updates, next slots in UTC and the owner's zone |
| `bin/pause.sh "<why>"` / `bin/unpause.sh` | Planned pause and resume (both posted to the team) |
| `bin/retry.sh <n>` | Held back to pending (run before a queue rebase) |
| `bin/disarm.sh` | Remove the flag; nothing else changes |
| `bin/public-sync.sh --update N --private-sha SHA` | The public copy of update N (`PUBLIC_SYNC_CMD`); prints its public sha |
| `bin/public-sync.sh --check` | Public copy setup check as the runner: files, keys sign, remote reachable, state agrees |

## Public copy (`bin/public-sync.sh`)
`publish-public.sh` (the `PUBLISH_CMD`) calls `PUBLIC_SYNC_CMD --update N --private-sha SHA` after the deploy passed
its checks. `bin/public-sync.sh` is that command. It runs as the runner user (root is refused) and:
- reads the root-owned template `PUBLIC_STATE` (public name and email, scrub rules, the forbidden words; mode 0640,
  group = the runner) and keeps its own progress (`privateSha`, `publicSha`, the map, the crash journal) in
  `PUBLIC_SYNC_HOME` (default `$RR_HOME/public`, mode 0700). The words never enter this repo;
- fetches the private objects from the runner checkout (local, no network) into its own repo, sets its `main` to SHA,
  and runs `lib/sync-public.py` (a root-owned copy of `ops/public/sync-public.py`, installed by `install.sh`): every
  first-parent private commit since the last copy becomes one capstandev commit with the same tree and message,
  signed with `PUBLIC_SIGNING_KEY`, pushed to `PUBLIC_REMOTE_URL` with `PUBLIC_PUSH_KEY` (pinned host keys in
  `PUBLIC_KNOWN_HOSTS`). Key files are passed by path only, never printed;
- refuses the whole copy before any push when a message or file still holds a forbidden word after the scrub (exit 1;
  the word is not printed). The update stays live and `publish_pending`; one alert; the owner fixes the file or sets
  a message in `PUBLIC_MESSAGE_OVERRIDES`;
- is idempotent: an update already copied copies nothing and prints the same public sha. A crash between the push and
  the state write is adopted on the next run from the journal (no commit twice). An older update retried after a newer
  one prints its own public sha;
- with a `changelog` key in the template, adds one changelog commit per update (title from the schedule, notes from
  `notes/<tag>.txt`), as `ops/public/publish-public-update.sh` does from the Mac;
- prints only the public sha on stdout. The runner passes it to the GitHub Release (a Release on the public repo must
  target a public commit; a command that prints none keeps the private sha, as before).

Exit codes: 0 copied or already public, 1 refused or failed (nothing new public unless a log line says pushed),
2 usage or setup, 75 another copy is running.

### Public copy: one-time server setup (the operator, as root)
Once the runner owns the public copy, stop running `publish-public-update.sh` from the Mac: two writers would race
(the runner adopts a matching push by content, anything else stops with "someone pushed there").
1. Install or update the runner: `bash ops/release/install.sh` (copies `lib/sync-public.py`, makes
   `/etc/capstan-release/public`, root:capstan-release 0750).
2. State template: on the Mac, run `publish-public-update.sh` once so the state is current, then copy
   `<private docs>/public/capstan-public.state.json` (and its `.map.jsonl`) to the server as
   `/etc/capstan-release/public/state.json` (and `state.json.map.jsonl`). `privateSha` and `publicSha` must be real
   shas (the copy was published). `chown root:capstan-release` and `chmod 0640` both files. Later changes to the
   words or scrub rules go into this server file (read every run; the runner's progress is kept separately).
3. Signing key: make a new ed25519 key on the server for capstandev (`ssh-keygen -t ed25519 -N '' -C capstandev-release
   -f /etc/capstan-release/public/id_ed25519_sign`), `chown root:capstan-release`, `chmod 0640`. Add the `.pub` to the
   capstandev account as an SSH **signing** key, so the commits show Verified.
4. Push key: a second key `/etc/capstan-release/public/id_ed25519_push` (same owner and mode), added to
   capstandev/capstan as a deploy key **with write access** (repo-scoped, nothing else). Pin GitHub's host keys:
   `ssh-keyscan github.com > /etc/capstan-release/public/known_hosts`, then compare the fingerprints with the ones
   GitHub publishes. If main is protected, allow this deploy key to push (or no protection on main of the copy).
5. release.conf: `PUBLIC_SYNC_CMD`, `PUBLIC_STATE`, `PUBLIC_SIGNING_KEY`, `PUBLIC_PUSH_KEY`, `PUBLIC_KNOWN_HOSTS`,
   `PUBLIC_REMOTE_URL=git@github.com:capstandev/capstan.git` (the example has them all). Optional
   `PUBLIC_MESSAGE_OVERRIDES` (root-owned JSON, private sha to public message).
6. Prove it, pushing nothing: `runuser -u capstan-release -- env RR_CONF=/etc/capstan-release/release.conf
   /opt/capstan-release/bin/public-sync.sh --check` prints `ready` with the public main and the state's private sha.

## Files
`lib/common.sh` (config, UTC maths, state, journal, lock, alerts), `bin/` (the commands), `systemd/` (oneshot service
and a 1-minute timer, installed disabled), `sudoers/` (narrow rules), `etc/release.conf.example`, `install.sh`,
`npm/` (package metadata for the SDK and MCP packages), `test/` (sandboxed tests: local bare repos and fake commands).

## Tests
```bash
bash ops/release/test/run-all.sh
```

Container sandbox (Docker; the real runner installed by `install.sh` as root in a Debian 12 container with systemd as
PID 1, real unit and sudo wrappers, local bare private, queue and public repos, a stand-in `capstan-deploy`, stand-in
Telegram and GitHub APIs on 127.0.0.1:25520 and 25521, and the REAL `bin/public-sync.sh` with a throwaway key against
a local bare public repo). 15 cases, one PASS or FAIL line each, about 3 minutes:
```bash
bash ops/release/test/sandbox/run.sh
```

Stress test on the real queue (`test/sandbox/stress72.sh`, the same container): every update of the queue released in
order at compressed slots, each with its own content check, with a gate failure, a deploy failure after the switch,
the stand-in APIs and the queue repo unreachable, a deploy that switched nothing, kill -9 in the gate, the check and
after the public copy, clock skew both ways and a slow update overrunning its slot; then the end state. About 10
minutes for 72 updates. Run from a clone outside ~/Documents:
```bash
git clone -q --bare <backend> /tmp/q.git
STRESS_REPO=/tmp/q.git STRESS_BASE=<main sha> STRESS_TIP=<queue tip sha> [STRESS_NOTES=<notes dir>] \
  [STRESS_REPORT_FILE=<report.md>] [STRESS_ARM_ONLY=1] bash ops/release/test/sandbox/run.sh
```
With `STRESS_REPORT_FILE` it also prints the `arm.sh --check` refusal list before and after that report.
