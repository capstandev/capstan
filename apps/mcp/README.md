# Capstan MCP server

A Model Context Protocol server for Capstan, the non-custodial multi-venue perps API. It speaks Streamable HTTP
(protocol `2025-11-25`), stateless: every request gets its own server, no session id is kept. Hosted at
`https://api.get-capstan.com/mcp` (the host name is configuration); locally `bun apps/mcp/src/index.ts` serves
`/mcp` on `MCP_PORT`.

Who may call: the Host header must be in `MCP_ALLOWED_HOSTS` (the public api host and loopback). A request with an
`Origin` header (a browser page) is refused with 403 unless that exact origin is in `MCP_ALLOWED_ORIGINS`; the hosted
server lists none. Agents and the `capstan-mcp` stdio bridge send no Origin. Each client IP may send
`MCP_RATE_LIMIT_PER_MIN` JSON-RPC messages a minute (default 60, a batch counts each message); more answer 429 with
`Retry-After`.

Read-only unless a write tool is called. No tool accepts a key. Builds return unsigned payloads; your host signs them
locally with the Capstan SDK, and the server only ever receives the signed envelope.

## Risks and limits

- Each venue liquidates independently. Legging risk is yours.
- A trade-only key can still trade and liquidate its account.
- Not available in refused regions.
- Receipts prove what Capstan did, not venue fill quality.

## Tools

| Tool | Input | Output |
|---|---|---|
| `capstan_markets` | `{ venue?, asset?, executableOnly? }` | `{ markets: Market[] }` |
| `capstan_funding` | `{ asset }` | `FundingSnapshot[]` for every venue, data-only venues included |
| `capstan_quote` | `QuoteRequest` (`canonicalAsset` or `marketIds` (10 at most), `side`, `sizeBase` or `notionalUsd`, `leverage`, `holdHours`, `orderType`, `limitPx?`, `owner?`) | `RouteQuote` with a per-venue cost table |
| `capstan_onboarding_build` | `{ venue, owner, agentAddress or lighterPubKey, builderMaxBps?, policy? }` | `OnboardingBundle`: the steps your main wallet signs, one plain sentence each |
| `capstan_build_order` | `{ owner, agentRef, intent, mode }` | `UnsignedVenuePayload` with its preview (sign it locally) |
| `capstan_submit` | `{ buildId, signedEnvelope }` only | `{ order, receiptId }` |
| `capstan_cancel_build` | `{ owner, agentRef, venueOrderId }` | `UnsignedVenuePayload` |
| `capstan_positions` | `{ owner, venues?, ownerRead }` | your positions per venue, each with its own liquidation price |
| `capstan_risk` | `{ owner, ownerRead }` or `{ addresses }` | `RiskView` per venue; free for your own, paid (x402, $0.01) for other addresses |
| `capstan_spread_scan` | `{ asset?, minBreakevenHours? }` | ranked pairs (x402, $0.02) |
| `capstan_spread_plan` | `{ owner, equivalenceId, sizeBase, leverage, hedgeFailurePolicy }` | `SpreadPlan` with `riskLabel` and `ackRequired: true` |
| `capstan_plan_status` | `{ planId }` | the plan and its events |
| `capstan_set_policy` | `{ policy, ownerSig }` | `{ policyId }` |
| `capstan_kill` | `{ agentRef, sig, message, closeAll? }` | `relayBlocked: true`, the venue revocation steps and, when asked, reduce-only close payloads |
| `capstan_get_receipt` | `{ receiptId }` | `Receipt` |
| `capstan_verify_receipt` | `{ receiptId }` or `{ receipt }` | `{ valid, checks }` (signature, leaf, proof, on-chain root) |
| `capstan_eligibility` | `{ venue? }` | `{ allowed, code }`; when refused the text is "Not available in your region." |

`ownerRead` is your wallet's read signature (the Capstan message with purpose `read`) for the exact path the tool calls:
`GET /v1/positions?owner=<owner>[&venues=<a,b>]` or `GET /v1/risk?owner=<owner>`. Write tools (`capstan_build_order`,
`capstan_submit`, `capstan_cancel_build`, `capstan_onboarding_build`) need a Capstan API key in the MCP client's
`Authorization: Bearer` header. A kill is the Capstan message with purpose `kill` and body `agentRef`, signed by your
wallet or by the agent itself; it stops the Capstan relay at once and cannot remove the key from the venue by itself.

## Paid tools (x402)

`capstan_spread_scan` and `capstan_risk` with `addresses` are paid per call with x402 over MCP. An unpaid call answers
`isError: true` with the payment requirements (`PaymentRequired`) in `structuredContent` and in the text. Retry with
the payment in `_meta["x402/payment"]`; the answer carries `_meta["x402/payment-response"]`. Base USDC is offered first.
With payments off, a paid call answers "payments unavailable" and is never served free.

The hosted server turns paid tools on only when all of these are set: `X402_ENABLED=1`, `FACILITATOR_URL`,
`X402_PAY_TO_EVM`, `X402_PAY_TO_SOL` and `CAPSTAN_INTERNAL_TOKEN` (32 or more characters, the same value as the api).
Rails are read from chain at boot (`BASE_RPC_URL` or `BASE_SEPOLIA_RPC_URL`, `RHC_RPC_URL`, `RHC_TESTNET_RPC_URL`);
a rail that cannot be read is not offered. The RHC USDG EIP-3009 option also needs `DATABASE_URL` to read the
detection results; without it that option is not offered.

## Sign locally

The key stays on your host. With the Capstan SDK (`packages/sdk`):

1. `capstan_build_order` returns the unsigned payload.
2. `checkBuild(intent, build, ...)` checks every field against your intent and the builder against the pinned address,
   and recomputes the digest (never trust the server's).
3. Sign that digest with your key store (`memoryKeyStore`, `fileKeyStore` or `browserKeyStore`).
4. `capstan_submit` with `{ buildId, signedEnvelope }`.

`apps/mcp/examples/agent-host.ts` does exactly this: quote, build, local check and signature, submit, receipt,
verification. `bun apps/mcp/examples/agent-host.ts --local` runs it on a local stack.
