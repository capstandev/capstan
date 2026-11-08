# Relay stop and restart

## Purpose
Stop Capstan from submitting signed orders to venues, for every venue (`RELAY_ENABLED`) or for one venue
(`HL_ENABLED`, `LIGHTER_304_ENABLED`, `LIGHTER_RH_ENABLED`, `ASTER_ENABLED`). This is the only pause Capstan has: the
contracts have no pause and no owner. Restart is the same flag turned back on.

## Who
- The owner or a named operator (README.md, Contacts), over ssh. The wrapper logs the operator (the ssh user) and the
  UTC time.
- Automation never changes a flag on the server.

## What users see
- Relay mode: `POST /v1/orders/submit` returns `VENUE_ERROR` with the message "relay paused". Builds still work.
- Direct mode keeps working: the SDK signs and sends the order to the venue itself, then calls `POST /v1/receipts/claim`
  for the receipt. Nothing Capstan runs is in that path except the receipt.
- Reads (markets, books, funding, quotes) keep working.

## Steps
1. Decide the scope: one venue (its orders fail or its signing changed) or all (any S1 incident).
2. Stop (owner or named operator):
   ```bash
   /usr/bin/ssh capstan-vps 'sudo /usr/local/sbin/capstan-relay-flag RELAY_ENABLED off'
   /usr/bin/ssh capstan-vps 'sudo /usr/local/sbin/capstan-relay-flag ASTER_ENABLED off'
   ```
   The wrapper (`ops/server/relay-flag.sh`) writes the flag into `/etc/capstan/relay/env`, restarts `capstan-relay` and
   `capstan-api`, appends one line to `/var/log/capstan/ops/flags.log` (`<UTC time> <operator> <FLAG> off`) and prints
   `flag: ASTER_ENABLED=0`.
3. Post one line in the internal ops group: which flag, why, when you expect to turn it back on.

## Verify
- The log line the relay prints at start shows the flags:
  ```bash
  /usr/bin/ssh capstan-vps 'sudo /usr/bin/grep -h "relay flags" /var/log/capstan/relay/relay.jsonl | /usr/bin/tail -n 1'
  ```
  It must show `"RELAY_ENABLED":false` (or the venue flag false).
- The flag log has the change:
  ```bash
  /usr/bin/ssh capstan-vps 'sudo /usr/bin/tail -n 5 /var/log/capstan/ops/flags.log'
  ```
- A submit through the API returns "relay paused" (any signed test build; testnet host first).

## Undo (restart)
1. Make sure the cause is fixed (incident.md step 7).
2. Turn the flag back on (owner or named operator):
   ```bash
   /usr/bin/ssh capstan-vps 'sudo /usr/local/sbin/capstan-relay-flag RELAY_ENABLED on'
   ```
3. Check the relay start line shows the flag true, and one testnet order passes.
4. Post one line in the internal ops group: relay back on, time.
