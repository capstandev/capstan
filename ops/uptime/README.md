# Outside uptime check

Three monitors watch Capstan from outside the server, so an outage is seen even when the server itself is down and
cannot raise its own alert. The list lives in `monitors.json`; `check.sh` probes the same URLs from any machine.

| Monitor | URL | Passes when |
| --- | --- | --- |
| site | https://get-capstan.com/ | 200 and the page holds `Capstan` |
| api-health | https://api.get-capstan.com/v1/health | 200 and the body holds `"degraded":false` |
| mcp-health | https://api.get-capstan.com/mcp/health | 200 and the body holds `"degraded":false` |

## What the health endpoints answer

`GET /v1/health` (API) and `GET /mcp/health` (MCP, the path Caddy sends to the MCP process) always answer 200 with
`Cache-Control: no-store`, so no cache can hide an outage:

```json
{"ok":true,"service":"api","version":"4d3f5e7aa11b","degraded":false,"failing":[]}
```

- `version`: `CAPSTAN_VERSION` when set, else the release sha from `/opt/capstan/releases/<sha>`, else `dev`.
- `degraded`: true when a dependency failed on the last probe. The API checks Postgres and Redis; the MCP server
  checks the API, and `/mcp/health` also checks that the Host it was reached on is in `MCP_ALLOWED_HOSTS` (a wrong
  list would refuse every hosted MCP call with 403 while the process looks up). `failing` names what failed.
- The probe runs at most once every 5 seconds and each check stops after 400 ms, so a monitor never loads the
  database and the answer stays quick. A dead process gives no answer at all, which the monitor also catches.

## Run the check by hand

```sh
ops/uptime/check.sh          # probes the public URLs: PASS or FAIL per monitor, then a summary line
ops/uptime/check.sh --list   # prints the URLs, calls nothing
```

Point it at another stack with `CAPSTAN_UPTIME_SITE_BASE` and `CAPSTAN_UPTIME_API_BASE`. Exit 0 means every
monitor passed, 1 means at least one failed. The tests (`bun test ops/uptime`) run it against the real API and MCP
apps on 127.0.0.1 with `CAPSTAN_UPTIME_LOCAL_ONLY=1`, which refuses any outside URL.

## Free plan facts (read from the pricing pages on 2026-11-08)

- UptimeRobot Free: 50 monitors, 5 minute interval, keyword monitors, SSL and domain expiry checks, up to 5
  integrations. Email alerts are free. Telegram alerts need Solo (from $9 a month, which also gives 60 second
  checks); webhooks need Team. A 1 minute interval is not free.
- Better Stack Free (the fallback): 10 monitors and heartbeats, Slack and email alerts. Its free check interval is
  not on the pricing page (VERIFY when the account is made).

So the free setup is UptimeRobot, 5 minute checks, alerts by email to the ops inbox. Telegram alerts to the ops chat
wait for the owner to choose Solo; the steps for it are at the end.

## Click-path (the owner does this once, about 10 minutes)

Menu names below are from UptimeRobot's dashboard as documented; if a label differs, the closest match is right.

1. Go to https://uptimerobot.com, choose **Register for FREE**, sign up with the ops email, confirm the email.
2. Alert contact: open **Integrations & Team** (left menu), check that the sign-up email is listed as an email
   contact. To use a separate ops inbox, choose **Add** next to **E-mail**, enter it and confirm the link it sends.
3. Site monitor: choose **+ New monitor**.
   - Monitor type: **Keyword**.
   - URL: `https://get-capstan.com/`. Friendly name: `Capstan site`.
   - Keyword: `Capstan`. Alert when: **keyword does not exist** (UptimeRobot calls it "Keyword not exists").
   - Monitoring interval: **5 minutes** (the free minimum).
   - Notifications: tick the ops email contact. Leave "notify after" at its default.
   - Under advanced settings, keep the timeout at 30 seconds and leave SSL error alerts on.
   - Choose **Create monitor**.
4. API monitor: **+ New monitor**, type **Keyword**, URL `https://api.get-capstan.com/v1/health`, name
   `Capstan API health`, keyword `"degraded":false` (with the quotes, no spaces), alert when **keyword does not
   exist**, interval 5 minutes, tick the ops email, **Create monitor**.
5. MCP monitor: same as step 4 with URL `https://api.get-capstan.com/mcp/health` and name `Capstan MCP endpoint`.
6. Check: each monitor turns green within 5 minutes. Run `ops/uptime/check.sh` from any machine; it must print
   `PASS 3/3 monitors`. If a monitor is red while `check.sh` passes, compare the URL and keyword with
   `monitors.json`.
7. Test the alert once: pause the site monitor, edit its keyword to `capstan-not-here`, resume it, wait for the
   email, then set the keyword back to `Capstan`.

Create the API and MCP monitors only once `api.get-capstan.com` serves (after the server deploy); before that they
would alert all day.

## Later: alerts to the ops Telegram chat (paid, Solo plan)

1. Upgrade to **Solo** in **Billing**.
2. **Integrations & Team** > **Telegram** > **Add**. UptimeRobot shows a bot link and a code: add that bot to the
   ops Telegram chat and send it the code. The chat then shows a confirmation message.
3. Edit each of the three monitors, tick the Telegram contact under notifications, save.
4. Optional on Solo: set the interval to 60 seconds on the two API monitors.
5. Update `alertContacts` in `monitors.json` (set the Telegram entry `free` note to the plan in use) so the file
   keeps matching the account.
