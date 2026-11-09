# web

The Capstan website: the owner's static multi-page design, wired to the Capstan API through the SDK. One static
build, deployable as is (Vercel config in `vercel.json`).

## Layout

| Path | What it is |
| --- | --- |
| `*.html` | One file per page: the owner's pages (index, how-it-works, developers, markets, quotes, risk, use-cases, the three case pages, pricing, about, contact, terms, privacy, dashboard) plus docs, verify, status, legal and 404 |
| `public/` | The owner's styles, scripts, component bundles, images and mascot videos, as supplied (kept word for word) |
| `site-src/` | The owner's editable sources for the component bundles in `public/assets/` (`site-src/package.json` has the esbuild commands) |
| `src/site/` | The live wiring: `main.ts` (the one module every page loads), `data.ts` (API reads and the view states), `feature.ts` (markets, quotes, risk and pricing pages), `dashboard.tsx` (the owner's dashboard views), `react.tsx` (React screens inside the owner's pages), `live.css`, `fonts.css` |
| `src/app/`, `src/pages/` | The SDK flow screens (connect, onboarding, quote, order ticket, risk, receipts, policy and kill, spreads) and the docs, verify, status and legal pages, mounted inside the owner's design |
| `scripts/` | `hash-public.ts` (content-hashed names for every public file after the build), `check-dist.ts`, `serve-dist.ts`, `sync-openapi.ts`, `check-copy.ts` |

The owner's scripts draw each page (`app.js`, `bloop-views.js`); `src/site/main.ts` then puts live values into the
owner's markup and mounts the live views. Where the owner wrote a line for the not-connected state ("not live",
"Awaiting connection", the specification notice), the line stays and shows in that state only.

## Live views

| Page | Live from the API |
| --- | --- |
| markets | the detail sheet values, funding per venue, the order book of any market, the comparison card's bars |
| quotes | a sample quote (venue fee, builder fee, slippage, funding, liquidation estimate, each on its own line per venue) and the quote widget |
| risk | connect, then one card per venue account under the fixed banner (never a cross-venue margin number) |
| pricing | the builder fee calculator at the fee GET /v1/venues reports |
| dashboard | overview counts, prices and funding bars; the market list with funding and books; Trade (connect, onboard, quote, order ticket, spreads, policy and kill); Risk; Activity (receipts); Developers (API health) |
| status, verify, docs | API and venue status; receipt checks in the browser; the OpenAPI file and the MCP tool table |
| index | the risk disclaimer; the $CPST box once `public/contracts.json` has a CPST address |

Every live view has loading, empty, error and offline states. Trading keeps the SDK flow: Capstan builds the venue
payload, the SDK checks it and shows plain-English steps, the trade-only key signs it in the browser, then it is sent.
Nothing withdraws.

## Commands

```bash
bun install            # at the repo root
cd web && bun install
bun run dev            # http://127.0.0.1:22273, API at http://127.0.0.1:22210/v1
bun run build          # sync, typecheck, vite build, hash public files, check dist/
bun run test           # happy-dom tests, plus headless Chromium checks when Chromium is installed
bun run test:e2e       # the browser passes (local stack; CAPSTAN_WEB_FORK=1 for the fork site pass)
```

The fork site pass: `FORK_WEB=dist bash ops/fork/up.sh` (move every port with `FORK_P_*` and the compose project with
`FORK_COMPOSE_PROJECT`; `FORK_EXTRA_JOBS=ingest-hl` adds funding and marks), then
`CAPSTAN_WEB_FORK=1 CAPSTAN_FORK_SITE=http://127.0.0.1:<web port> bun test --timeout 1800000 test/e2e/site-pass.spec.ts`.

## Configuration (build time)

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_PROFILE` | `live` | `fork` points at the local stack and an anvil fork, shows "Local test network" and refuses writes from chain 4663 |
| `VITE_API_BASE` | `http://127.0.0.1:22210/v1` in dev, `https://api.get-capstan.com/v1` in a build | Capstan API base |
| `VITE_NETWORK` | `mainnet` (`testnet` on the fork profile) | SDK pins and token chain |
| `VITE_RPC_URL` | Robinhood Chain public RPC | Anchor reads on the verify page |
| `VITE_WALLETCONNECT_PROJECT_ID` | unset | The Reown AppKit picker (WalletConnect and browser wallets). Unset: EIP-6963 injected wallets only. `VITE_REOWN_PROJECT_ID` is read too |

## Rules the tests hold

- The risk disclaimer is on the home, markets, quotes, risk, pricing and docs pages, the dashboard and every quote widget.
- The token box appears only when `public/contracts.json` has a CPST address for the build's chain.
- Every file under `assets/` and `_app/` in the build has a content hash in its name, and nothing references an
  unhashed public file; no page loads a script or font from another host (the owner's fonts are self-hosted).
- No source maps, server paths or `.env` values in `dist/`; files under 20 MB, the build under 100 MB.
- No animation, status badge or sparkle in this repo's own code (`src/`); the owner's design is the owner's.
