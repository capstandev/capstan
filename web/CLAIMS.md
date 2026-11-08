# Product claims

The website's copy is the owner's (`public/`, `*.html`). This table is the list of product claims the site and the
API docs may make, each with how someone outside the team can check it today (`src/copy.ts` holds the same sentences
and `test/claims.test.ts` keeps the two in step). A claim whose check is not possible yet is marked `not live`
(`src/live.ts` holds the switches). Owner lines that go further than this table are listed for the owner in the
private copy notes, not changed on the site.

| Id | Claim | How to check it today | Status |
| --- | --- | --- | --- |
| venues | Quotes Hyperliquid (core and HIP-3 markets), Lighter on mainnet and on Robinhood Chain, and Aster side by side. | The /docs page lists `GET /v1/venues` and `POST /v1/quote`; the quote response has one row per venue market (`legs`), each with its venue id. | live |
| cost-columns | Venue fee, integration fee, slippage, funding and liquidation price are shown in separate columns before you sign. | The /docs page: the quote response carries `venueFeeBps`, `builderFeeBps`, `slippageBps`, `fundingCostBps` and `estLiqPx` per venue, and quotes need no signature. | live |
| own-key | Your trade-only key is made on your device. Capstan never sees it. | The /docs page: onboarding build takes only the new key's public address (`agentAddress` or `lighterPubKey`); no endpoint has a key field. | live |
| no-withdraw | No venue approval Capstan asks for can withdraw or transfer funds. | Read the typed data in an onboarding bundle before you sign: Hyperliquid `ApproveAgent` and `ApproveBuilderFee`, Aster `approveAgent` (perps only) and `approveBuilder`, Lighter key registration. Each venue's public API docs describe what those approvals allow. | live |
| fee-cap | Your main wallet approves the integration fee once, with a cap of 0.03%. | The builder step in the onboarding bundle shows `maxFeeRate` "0.03%" (Hyperliquid) or 0.0003 (Aster), and your wallet shows the same value when it asks you to sign. | live |
| liq-separate | Every venue's liquidation price is shown on its own. Margin is never pooled across venues. | The /docs page: `GET /v1/risk` returns `perVenue` (one account per venue) and a `liquidationLadder` with one price per venue market, under the fixed banner. There is no total margin field. | live |
| receipts | Every routed order gets a signed receipt you can check on the verify page. | Paste a receipt id or the receipt JSON on /verify: the signature, the leaf, the Merkle proof and the posted hourly root are checked in your browser. | live |
| agents | AI agents get one MCP server with owner-signed caps and a kill switch. | The /docs page lists the MCP tools, including `capstan_set_policy` and `capstan_kill`. | live |
| npm | Install the TypeScript SDK from npm: capstan-sdk. | Search the npm registry for `capstan-sdk`. | not live |
| source | The API, SDK, MCP server and contracts are open source. | Open the public source repository. | not live |
