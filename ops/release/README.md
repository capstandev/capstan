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
| Public copy or Release fails | The update stays live; it is retried later; later updates are not blocked |
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

## Files
`lib/common.sh` (config, UTC maths, state, journal, lock, alerts), `bin/` (the commands), `systemd/` (oneshot service
and a 1-minute timer, installed disabled), `sudoers/` (narrow rules), `etc/release.conf.example`, `install.sh`,
`npm/` (package metadata for the SDK and MCP packages), `test/` (sandboxed tests: local bare repos and fake commands).

## Tests
```bash
bash ops/release/test/run-all.sh
```
