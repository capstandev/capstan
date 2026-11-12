# Capstan team bot (teambot)

One small program on the server that answers the internal TEAM Telegram group with the release alert bot. Python 3
stdlib only, long polling (getUpdates, 50 s), no paid API and no AI answers. systemd unit `capstan-teambot.service`
with `Restart=always`.

It serves only the team group (`TELEGRAM_CHAT_ID`) and the owner's private chat (`OWNER_TELEGRAM_ID`). Every other
chat is ignored. The bot token stays in the release runner's `/etc/capstan-release/telegram.env` and reaches curl in a
config on stdin: never on a command line, never in a log, never in a reply.

## Commands

Anyone in the team group:

| Command | Answer |
|---|---|
| /help | the command list |
| /status | released N of 72, the next update and its time, running or paused, the held list (from the release runner's `bin/status.sh` and its `schedule.tsv` / `state.tsv`) |
| /roadmap | https://get-capstan.com/roadmap and the next 3 updates |
| /changelog | https://get-capstan.com/changelog and the last 3 released, with their GitHub Release links |
| /socials | site, roadmap, changelog, docs, API, MCP, GitHub, releases, plus the "Socials" section of known.md |
| /contracts | CPST, CPSTLock and CapstanReceiptAnchor from contracts.json (web/public), each with its explorer link; says plainly when mainnet is not deployed yet |
| /videos | the demo videos in captions.json |
| /video N, /video N phone | sends that demo (desktop by default) with its caption |
| /poster N | the poster of update N (`/var/lib/capstan-release/posters/update-NN.png`), only once it is released |
| /mcp | the "MCP server" section of known.md |
| /request text | saves a request and asks the owner to approve or decline it |
| /whoami | your Telegram id (the owner uses it once for set-keys.sh) |

Owner only (everyone else gets "Only the owner can do that."):

| Command | What happens |
|---|---|
| /pause reason | Confirm / Cancel buttons; only the owner's tap counts; expires after 2 minutes. Confirm runs the runner's `bin/pause.sh` and posts "Updates paused by the owner: reason. Nothing is broken." |
| /resume | the same, runs `bin/unpause.sh` and posts "Updates resumed." |

A message that mentions the bot or replies to it, and is not a command, gets one fixed reply with the command list and
"Use /request <what you want> to ask the owner."

Limits: requests 3 per person per 10 minutes and 20 per hour for the group; videos and posters 5 per person per 10
minutes and 20 per hour; mention replies 2 per person per 10 minutes.

## Requests

`/request <text>` writes a line to `/var/lib/capstan-teambot/requests.jsonl` and sends the owner a private message with
Approve / Decline. If the owner has never opened a private chat with the bot, it goes to the group and tags the owner.

    teambot requests              # every request, one JSON line each
    teambot requests --approved   # only the approved ones (what a work session picks up)
    teambot requests --done 3 shipped as bonus 7   # mark request 3 done; the group gets "Done: text."

## Files

| Path | What |
|---|---|
| /usr/local/sbin/teambot | the program (`run`, `check [--live]`, `requests`) |
| /etc/systemd/system/capstan-teambot.service | the unit |
| /etc/capstan-release/telegram.env | bot token and team chat id (the runner's file, read only) |
| /etc/capstan-release/release.conf | the runner config, handed to status.sh, pause.sh and unpause.sh as RR_CONF |
| /etc/capstan-teambot/teambot.env | `OWNER_TELEGRAM_ID` (root 0600, written by set-keys.sh) |
| /etc/capstan-teambot/known.md | hand-written: what Capstan has and does not have; /mcp and /socials read it |
| /var/lib/capstan-teambot/{offset,state.json,requests.jsonl} | poll offset, open confirmations, the request queue |
| /var/lib/capstan-teambot/{captions.json,contracts.json,videos/} | copied by install.sh |
| /var/lib/capstan-release/ | read only: schedule.tsv, state.tsv, PAUSE, posters/, notes/ |

## Install (from the Mac, once the release runner is on the server)

    bash ops/teambot/install.sh root@HOST [--known] [VIDEOS_DIR=...]
    bash ops/teambot/set-keys.sh root@HOST     # hidden prompt, typed twice: OWNER_TELEGRAM_ID from /whoami

## Tests

    python3 -m unittest discover -s ops/teambot/tests -t .    # from backend/; also part of bun test

The real program, the real runner scripts on a scratch runner home, and the stand-in Telegram API
(`ops/alerts/telegram-standin.ts`, its getUpdates queue) drive every command end to end, including that a non-owner
cannot pause, resume or tap the owner's Confirm.
