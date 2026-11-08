# Incident

## Purpose
Handle anything that is broken: a service down, wrong quotes, a venue rejecting orders, an anchor mismatch, or any
`act` or `critical` ops alert. Goal: stop harm first, then explain, then fix.

## Who
Contacts by role are in README.md.
- First responder: whoever sees the alert first (the owner or anyone in the internal ops group).
- Posts in the internal ops group: the first responder. Nothing goes to the community group until the owner writes it.
- Server steps (deploy rollback, flag changes): the owner or a named operator, over ssh.
- Automation and helpers: read logs, write the timeline and the fix; never touch the server.

## Severity
| Level | Means | Examples | Response |
|---|---|---|---|
| S1 critical | Users can lose money or receive a wrong payload | anchor root mismatch, receipt signer fault, payload verify bypass, wrong builder fee | Stop the relay now (relay-stop.md), then investigate |
| S2 act | A feature is down or wrong, no loss path | one venue rejecting all submits, quotes stale above 3 s for 5 minutes, governor above 90%, facilitator float above limit | Stop that venue if orders fail; fix within the day |
| S3 info | Degraded or noisy | catalog found a new dex, recovery after staleness | Note it; handle in working hours |

## Steps
1. Read the alert. Look up its cause in `ops/alerts/GLOSSARY.md` (what it means, what to do).
2. Post one line in the internal ops group: what happened, who is affected, what you are doing now.
3. If S1, stop the relay globally (owner or named operator):
   ```bash
   /usr/bin/ssh capstan-vps 'sudo /usr/local/sbin/capstan-relay-flag RELAY_ENABLED off'
   ```
   If only one venue is affected, stop that venue instead (`HL_ENABLED`, `LIGHTER_304_ENABLED`, `LIGHTER_RH_ENABLED`,
   `ASTER_ENABLED`). Direct mode keeps working for users (they submit to the venue themselves).
4. Look at the service state and the last log lines:
   ```bash
   /usr/bin/ssh capstan-vps 'sudo /usr/local/sbin/capstan-status'
   /usr/bin/ssh capstan-vps 'sudo /usr/bin/tail -n 200 /var/log/capstan/relay/relay.jsonl'
   /usr/bin/ssh capstan-vps 'sudo /usr/bin/journalctl -u capstan-relay --since "-30 min" --no-pager'
   ```
   Trace ids: every log line of one request carries the same `trace_id` (api, relay, venue span). Search for it:
   ```bash
   /usr/bin/ssh capstan-vps 'sudo /usr/bin/grep -h "<trace_id>" /var/log/capstan/*/*.jsonl'
   ```
5. If the last deploy caused it, roll back to the previous release (owner or named operator). The wrapper keeps the last sha in
   `/opt/capstan/previous`:
   ```bash
   /usr/bin/ssh capstan-vps 'sudo /usr/local/sbin/capstan-deploy --rollback'
   ```
   The deploy wrapper runs health checks after a rollback and prints `deploy: ok <sha>` or `deploy: failed`.
6. Post a second line within 10 minutes of the first: the cause if known, what was done, what is next.
7. Fix in the private repo, run the full suite (`bun run check`), deploy the fix sha (owner or named operator):
   ```bash
   /usr/bin/ssh capstan-vps 'sudo /usr/local/sbin/capstan-deploy <git-sha>'
   ```
8. Turn the relay back on (relay-stop.md, Undo) once the fix is live and verified.
9. Write the post-incident note (template below) in the private operations notes.

## First 10 minutes (checklist)
- [ ] Alert read, glossary entry read.
- [ ] One line posted in the internal ops group.
- [ ] S1: relay stopped. S2: affected venue stopped if orders fail.
- [ ] Service status and last 200 log lines read.
- [ ] Decision taken: roll back, stop, or watch.

## Verify
- The alert stops repeating (ops alerts dedupe for 30 minutes per cause; a recovery sends one `info` line).
- `capstan-status` shows every unit `active (running)` and `/health` ok:
  ```bash
  /usr/bin/ssh capstan-vps 'sudo /usr/local/sbin/capstan-status'
  ```
- For a venue incident: one small order through the relay on testnet passes before the venue flag goes back on.

## Undo
- A rollback is undone by deploying the newer sha again (step 7).
- A relay or venue stop is undone in relay-stop.md, Undo.

## Post-incident note template
```text
Incident <UTC date and time>
Severity: S1 | S2 | S3
What happened (plain words):
Who was affected (counts only, no addresses):
Timeline (UTC): detected, first post, relay stopped, fixed, relay on
Cause:
What we changed:
How we prove it cannot repeat (test name):
Follow-ups (owner, date):
```
