# capstan-mcp

A stdio bridge to the hosted Capstan MCP server, for AI agent clients that speak MCP over stdio. Capstan is a
non-custodial perps API for Hyperliquid (core and HIP-3 markets), Lighter (mainnet and Robinhood Chain) and Aster.

The bridge **holds no key and asks for none**. Tools that change anything return an UNSIGNED payload; your own wallet
or the `capstan-sdk` signs it on your machine. It refuses to start when a key-like setting is present.

```json
{ "mcpServers": { "capstan": { "command": "npx", "args": ["-y", "capstan-mcp"] } } }
```

Clients that speak Streamable HTTP can use the hosted endpoint directly: `https://api.get-capstan.com/mcp`.

| Setting | Default | Use |
| --- | --- | --- |
| `CAPSTAN_MCP_URL` | `https://api.get-capstan.com/mcp` | The hosted server (https only) |
| `CAPSTAN_API_KEY` | none | Optional `cpst_...` API key for credits and higher limits. Never a wallet key. |

The tool list is the hosted server's own (`tools/list`): markets, funding, quotes, onboarding and order builds,
positions, risk, spreads, agent policy and kill switch, receipts and their verification, eligibility.

## Before you trade
- Each venue liquidates your account there on its own. Margin is never pooled across venues.
- On a two-leg spread, legging risk is yours.
- A trade-only key can still trade, and so can lose, the account it is approved for.
- Not available in refused regions. Receipts prove what Capstan did, not how the venue filled.

Published with npm provenance by the repository's `npm publish` workflow. MIT licence.
