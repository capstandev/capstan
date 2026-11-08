# ops/mainnet: the mainnet launch package

| File | Who runs it | What it does |
|---|---|---|
| `dry-run.sh` | agent, fork only | The exact `ops/deploy/deploy-rhc.sh mainnet` from a snapshot of the committed tree on an anvil fork of 4663 (anvil 22549 behind a fee shim on 22545, rpc-cache 22546 that refuses writes upstream), a second run that must only skip, `live-check.sh` on the fork record, one anchor post, one USDG settle per RHC path; then the gas report. Refuses any RPC that is not the loopback fork. |
| `report.ts` | `dry-run.sh` | Gas per transaction, the live gas price and the L1 data estimate (read-only), the deployer ETH to fund (gas x price x 1.3, and the script's own balance floor). |
| `env-review.ts` | agent, before the go | Merges `ops/server/etc/<svc>.env` with `env/<svc>.env`, prints every value with its sha, and checks the flags that must be off, the values that must match (VPS IP, SDK builder pins, brand Safe as payTo) and that no security setting is empty. `--strict` fails on pending inputs. |
| `live-check.sh` | after the go, read-only | Runtime code against this checkout's build (immutables masked), `poster()`, `token()`, the CPST ticker, the supply in the brand Safe, the real Safe check, Sourcify. Writes `.audit-grade/live-check-<date>.md`. |
| `builder-balances.ts` | read-only | Hyperliquid builder account value and abstraction mode; Aster is a signed read on the VPS. |
| `fork-steps.ts` | `dry-run.sh` | Fork-only helpers: a Safe 1.4.1 made on the fork, a USDG settle through the facilitator's own signer. |

Tests: `bun test --timeout 30000 ops/mainnet`.
