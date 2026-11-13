# Mainnet env overlays

One file per service, applied on top of `ops/server/etc/<service>.env` (the testnet templates provision.sh writes).
`bun ops/mainnet/env-review.ts` merges each pair, fills the public mainnet inputs (from `ops/mainnet/inputs.conf`, an env var of the same name wins) and checks every rule of the
review (flags off at first deploy, values that must match, no empty security setting). Placeholders:

- `@BRAND_SAFE@`: the brand Safe on Robinhood Chain (the x402 payTo).
- `@HL_BUILDER@`, `@ASTER_BUILDER@`: the builder addresses; they must equal the SDK pins (`packages/sdk/src/pins.json`).
- `@RELAY_EGRESS_IP@` (from the template): the VPS static IP.
- `@DB_PASSWORD@`, `@API_HOST@`, `@SVC@`: filled on the server by provision.sh, never here.

Every venue and arming flag starts at 0. The go-live runbook turns them on one at a time, on the server.
