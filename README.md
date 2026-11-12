# Capstan

Capstan is a non-custodial multi-venue perps API, TypeScript SDK and MCP server. It covers Hyperliquid (core and
HIP-3 markets), Lighter (mainnet and the Robinhood Chain deployment) and Aster, with Variational and Arcus as
read-only data feeds. Three small contracts run on Robinhood Chain (mainnet `4663`, testnet `46630`).

Capstan never holds user keys or funds, and no venue authorization asks for withdrawals. Orders are built server-side,
checked and signed on the user's own device by the SDK, then relayed or sent directly to the venue. Every routed
action gets a signed receipt, and hourly Merkle roots of the receipts are anchored on-chain. Collateral stays on each
venue: there is no cross-venue margin.

Status: pre-release. No contract is deployed yet and the code has not had an external audit.

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
  policy/         agent policy typed data, shared policy check, kill switch, revocation bundles
  quote/          quote engine: best-venue routing, staleness and depeg guards, funding forecast
  risk/           per-venue account snapshots, exposure, liquidation ladders under a fixed banner
  spreads/        funding-rate spread scanner, planner and client-side executor
  tiers/          plans and tiers: free, pay-as-you-go, pro credits, CPST lock tiers
  telemetry/      traces, Prometheus metrics, log redaction, ops alerts
  venue-client/   shared venue HTTP and WebSocket client, per-egress budget governor
contracts/        Foundry: CapstanReceiptAnchor, CPSTLock, CPST
web/              website and dashboard (Vite, its own install and tests: `cd web && bun run test`)
ops/              CI checks, deploy scripts, server scripts, dashboards, alerts, runbooks
```

### Contracts (`contracts/src`)

| Contract | What it does |
| --- | --- |
| `CapstanReceiptAnchor` | Write-once hourly Merkle roots of receipts; only the immutable poster may post; proof verification helper |
| `CPSTLock` | Locks CPST for API tiers; unlock always works after the chosen duration (0, 30 or 90 days) |
| `CPST` | Fixed-supply ERC-20 |

Non-upgradeable, no pause, no admin beyond what each contract states. Interfaces are in `src/interfaces`.
Vendored: forge-std v1.17.0.

### Deployments

Generated from `contracts/deployments/<chainId>.json` by `bun ops/ci/gen-deployments.ts`; CI fails if it differs.

<!-- deployments:start -->
| Chain | Contract | Address | Sourcify |
| --- | --- | --- | --- |
| Robinhood Chain testnet (`46630`) | `CapstanReceiptAnchor` | `0x34CC7eDB6b6F17E06BF88F79dFd86D2338d86Bcf` | [verified](https://repo.sourcify.dev/46630/0x34CC7eDB6b6F17E06BF88F79dFd86D2338d86Bcf) |
| Robinhood Chain testnet (`46630`) | `CPSTLock` | `0x3D69429d628c8Ea342d5C8722c9e1A75d54Fb7DA` | [verified](https://repo.sourcify.dev/46630/0x3D69429d628c8Ea342d5C8722c9e1A75d54Fb7DA) |
| Robinhood Chain testnet (`46630`) | `CPST` | `0x32a800622317F97d829277215Bcd0D62E191EB2E` | [verified](https://repo.sourcify.dev/46630/0x32a800622317F97d829277215Bcd0D62E191EB2E) |
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

## API routes

All routes are under `/v1` and are defined in `apps/api/src/routes/<area>.routes.ts`. The OpenAPI document is served at
`/openapi.json`.

| Area | Routes |
| --- | --- |
| Health and meta | `/health`, `/openapi.json`, `/venues` |
| Markets | `/markets`, `/markets/:id/book`, `/funding`, `/funding/forecast`, `/history/funding` |
| Quotes | `/quote` |
| Orders | `/orders/build`, `/orders/cancel/build`, `/orders/close-all/build`, `/orders/submit` (builds return an unsigned payload; no amend route) |
| Positions and risk | `/positions`, `/risk`, `/risk/snapshot`, `/risk/liq-heatmap`, `/risk/ingest` |
| Receipts | `/receipts`, `/receipts/:id`, `/receipts/:id/proof`, `/receipts/:id/verify`, `/receipts/claim` |
| Onboarding | `/onboarding/preflight`, `/onboarding/build`, `/onboarding/submit` |
| Agents | `/agents/policy`, `/agents/:agentRef/kill` |
| Spreads | `/spreads/scan`, `/spreads/plan`, `/spreads/:id`, `/spreads/:id/ack`, `/spreads/:id/events` |
| Account | `/account`, `/account/keys`, `/credits`, `/credits/topup/<pack>`, `/alerts/webhooks`, `/alerts/webhooks/:id` |
| Eligibility | `/eligibility` |

## Verify a receipt

`GET /v1/receipts/:id/proof` returns the hour's Merkle proof and root once that root is anchored (`anchored` says whether it is on chain yet). `GET /v1/receipts/:id/verify`
runs the full public check (signature, leaf and proof). The website has a verify page for it.

## Deploy the contracts from a fresh clone

The deploy is owner-run and goes in one order: CPST (whole supply to the brand Safe), then CPSTLock, then
CapstanReceiptAnchor. Every stage reads the chain first and skips what is already done, so a second run only prints
skip lines. Nothing here asks for a key in plain text: the deployer is a Foundry keystore and Foundry asks for its
password at a hidden prompt.

```sh
git clone <this repo> capstan && cd capstan
bun install
cd contracts && forge build && forge test && cd ..

# 1. local rehearsal on anvil (chain 31337, throwaway keystores under out/deploy-local/, nothing leaves the machine)
anvil --port 21445 --silent &
EXPECTED_CHAIN_ID=31337 bash ops/deploy/deploy-rhc.sh local
bash ops/deploy/post-deploy-check.sh local

# 2. fork dry run against Robinhood Chain mainnet state: measures the gas the deployer needs, sends nothing
(cd contracts && RHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path test/fork/DeployFork.t.sol -vv)

# 3. testnet 46630 (keystore account "capstan-deployer", a real Safe as BRAND_SAFE)
POSTER_ADDRESS=<anchor poster> BRAND_SAFE=<Safe address> bash ops/deploy/deploy-rhc.sh testnet
bash ops/deploy/post-deploy-check.sh testnet

# 4. mainnet 4663, only on the day of the go (the guard refuses any other date string)
CAPSTAN_MAINNET_GO=go-$(date -u +%Y-%m-%d) POSTER_ADDRESS=<anchor poster> BRAND_SAFE=<Safe address> \
  bash ops/deploy/deploy-rhc.sh mainnet
bash ops/deploy/post-deploy-check.sh mainnet
```

`deploy-rhc.sh` writes `contracts/deployments/<chainId>.json`; commit it with the copies `bun run gen:deployments`
regenerates (CI fails when they differ). `post-deploy-check.sh` is read-only: code at every address, runtime code equal
to a fresh build, `poster()` and `token()` equal to the deployment file, the reviewed selector set, the chain id and the
Sourcify status. The BRAND_SAFE check requires Safe 1.4.1, threshold 2 or more, no modules and no guard.

When something breaks after a deploy, see `ops/runbooks/` (incident and relay stop).

## Checks

CI (`.github/workflows/ci.yml`) runs the typecheck, the pin check (exact dependencies, actions by sha, images by
digest), the migrations against Postgres + TimescaleDB, `bun test`, a coverage gate (70% of lines in `packages/`),
`forge fmt --check`, `forge build --sizes`, `forge test` (4,096 fuzz runs), a NatSpec check, slither, semgrep with a
local ruleset, gitleaks, and the web package (its own frozen install, build with the dist check, tests and copy
check). `.github/workflows/invariants.yml` runs the key-identifier rule
(`ops/ci/check-key-identifiers.ts`), the banned-word list (`ops/ci/check-banned-words.ts`), the deployment-file and
vector-file checks and the public guard. The fast checks also run in the pre-commit hook
(`git config core.hooksPath .githooks`).

## Website

The `web/` folder is the Capstan website and dashboard at https://get-capstan.com. It is a static Vite build with its own
install and tests, deployed on Vercel (`web/vercel.json`). See `web/README.md` for its layout.

## License

[MIT](LICENSE)
