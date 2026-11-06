# Capstan

Non-custodial API, TypeScript SDK and MCP server for perpetual futures across several venues: Hyperliquid (core and
HIP-3 markets), Lighter (mainnet and the Robinhood Chain deployment) and Aster, with Variational and Arcus as
read-only data feeds. Two small contracts run on Robinhood Chain (chain ID `4663`).

Capstan never holds user keys or funds. Orders are built server-side, checked and signed on the user's own device by
the SDK, then relayed or sent directly to the venue. Every routed action gets a signed receipt, and hourly Merkle
roots of the receipts are anchored on-chain. Collateral stays on each venue: there is no cross-venue margin.

Status: pre-release scaffold. Nothing is deployed.

## Layout

```
apps/
  api/            REST + tRPC router, x402 middleware, eligibility edge (Hono)
  ws/             WebSocket gateway (market, account and plan streams)
  relay/          signed-payload verifier and venue submitter
  mcp/            MCP server (Streamable HTTP)
  workers/        BullMQ processors (ingest, funding, risk, reconcile, anchor)
  facilitator/    self-hosted x402 facilitator
packages/
  schema/         canonical types, zod validators, constants, database schema
  core/           config, database and migrations, queues, cache, service signer, signed messages, logger
  adapters/       hyperliquid, lighter, aster, variational (read-only), arcus (read-only)
  signers/        hl, lighter-wasm, aster
  sdk/            client-side key generation, payload checks, signing, plan executor
  eligibility/    geo matrix and decision engine
  receipts/       JCS canonicalisation, signing, Merkle trees, proofs
  catalog/        canonical-asset map and equivalence records
  x402/           client and server helpers (Permit2 + EIP-3009)
contracts/        Foundry: CapstanReceiptAnchor, CPSTLock, CPST
web/              website (placeholder)
ops/              CI checks, dashboards, alerts
```

### Contracts (`contracts/src`)

| Contract | What it does |
| --- | --- |
| `CapstanReceiptAnchor` | Write-once hourly Merkle roots of receipts; only the immutable poster may post; proof verification helper |
| `CPSTLock` | Locks CPST for API tiers; unlock always works after the chosen duration (0, 30 or 90 days) |
| `CPST` | Fixed-supply ERC-20 |

Interfaces only so far (`src/interfaces`). Non-upgradeable, no pause, no admin beyond what each contract states.
Vendored: forge-std v1.17.0.

### Deployments

Generated from `contracts/deployments/<chainId>.json` by `bun ops/ci/gen-deployments.ts`; CI fails if it differs.

<!-- deployments:start -->
No contracts are deployed yet.
<!-- deployments:end -->

### Services

| Service | Entry | What it does |
| --- | --- | --- |
| API | `apps/api/src/index.ts` | REST + tRPC, quotes, order builds, x402, eligibility |
| WS | `apps/ws/src/index.ts` | Market, funding, account and plan streams |
| Relay | `apps/relay/src/index.ts` | Verifies signed envelopes, policy and eligibility re-check, venue submit |
| MCP | `apps/mcp/src/index.ts` | MCP tools that mirror the REST API; no tool accepts a key |
| Workers | `apps/workers/src/index.ts` | Ingest, funding forecast, risk, receipts, anchoring, reconciliation |
| Facilitator | `apps/facilitator/src/index.ts` | x402 verify and settle |

## Requirements

- [Bun](https://bun.sh) 1.4.4+
- [Foundry](https://getfoundry.sh) 1.8.4 (solc 0.8.28 is set in `contracts/foundry.toml`)
- Docker (local Postgres 16 + TimescaleDB on port 55432, Redis 7 on port 56379; both ports configurable)

## Commands

```sh
bun install
bunx tsc --noEmit          # typecheck every workspace
docker compose up -d --wait  # local Postgres + Redis (CAPSTAN_PG_PORT / CAPSTAN_REDIS_PORT move the ports)
bun run db:migrate         # apply migrations (DATABASE_URL); `bun run db:migrate:down` reverts them
bun test                   # unit tests + CI invariant checks (database tests skip without DATABASE_URL / REDIS_URL)
bun run check              # typecheck, tests, key identifiers, banned words, pins, deployments, vectors, public guard
cd contracts && forge build && forge test
```

New API routes, worker jobs and catalog sources are drop-in files, found by a glob scan at boot:
`apps/api/src/routes/<area>.routes.ts` (exports `routes`, each with its auth declared), `apps/workers/src/jobs/<name>.job.ts`
(exports `job`) and `apps/workers/src/jobs/catalog-sources/<venue>.source.ts` (exports `source`).

### Configuration

All config comes from environment variables. `.env.example` lists every variable with a safe local default.

| Variable | Default | Notes |
| --- | --- | --- |
| `CAPSTAN_NETWORK` | `local` | `local`, `testnet` or `mainnet` |
| `API_PORT` / `WS_PORT` / `RELAY_PORT` / `MCP_PORT` / `FACILITATOR_PORT` | `8710` to `8714` | Listen ports |
| `DATABASE_URL` | `postgres://capstan:capstan@127.0.0.1:55432/capstan` | Local compose database |
| `REDIS_URL` | `redis://127.0.0.1:56379` | Local compose Redis |
| `WORKER_JOBS` | empty (all) | Comma list; an unknown name stops the worker at boot |
| `<ROLE>_SIGNER` | `keystore` | `keystore` (needs `<ROLE>_KEYSTORE_PATH` and `<ROLE>_KEYSTORE_PASSWORD_FILE`) or `dev` (chain 31337 only) |
| `ANCHOR_ARMED` / `X402_SETTLE_ARMED` / `RELAY_SUBMIT_ARMED` | `0` | Broadcasting stays off until set |
| `RHC_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | Public RPC |

Each service validates only its own variables at boot and names any missing one (never a value). Variables named
like a raw key are refused. Never commit `.env` files or keys; `.gitignore` refuses them.

## Checks

CI (`.github/workflows/ci.yml`) runs the typecheck, the pin check (exact dependencies, actions by sha, images by
digest), the migrations against Postgres + TimescaleDB, `bun test`, a coverage gate (70% of lines in `packages/`),
`forge fmt --check`, `forge build --sizes`, `forge test` (4,096 fuzz runs), a NatSpec check, slither, semgrep with a
local ruleset, and gitleaks. `.github/workflows/invariants.yml` runs the key-identifier rule
(`ops/ci/check-key-identifiers.ts`), the banned-word list (`ops/ci/check-banned-words.ts`), the deployment-file and
vector-file checks and the public guard. The fast checks also run in the pre-commit hook
(`git config core.hooksPath .githooks`).

## License

[MIT](LICENSE)
