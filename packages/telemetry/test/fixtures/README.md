# Fixtures

Recorded read-only Hyperliquid info responses (2026-11-06, public API, no key), for the builder balance check:

- `hl-clearinghouse-state.json`: `POST https://api.hyperliquid.xyz/info {"type":"clearinghouseState","user":"0x...01"}`
- `hl-user-abstraction.json`: `POST https://api.hyperliquid.xyz/info {"type":"userAbstraction","user":"0x...01"}` returns `"default"`, the standard mode
