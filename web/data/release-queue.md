# Release queue (copy for /roadmap)

Generated from the release queue; do not edit by hand. `bun scripts/sync-roadmap.ts` turns it into
data/roadmap.json, and test/roadmap.test.tsx fails if the two differ. Times are relative to launch:
"Day 1, +4 h" is four hours after the launch time.

| # | When | Lane | Tier | Title | Line |
| --- | --- | --- | --- | --- | --- |
| 1 | Day 1, +0 h | C | core | MCP landing page for people who open the agent address | The MCP endpoint now explains itself to people who open it in a browser, with setup steps and the tool list. |
| 2 | Day 1, +1 h | A | core | Health shows the running commit and how fresh each part is | Health now reports the running commit and the age of every data feed and job. |
| 3 | Day 1, +2 h | D | core | Contracts page with every address and its verified source | New contracts page: every deployed address with explorer and Sourcify links. |
| 4 | Day 1, +3 h | B | core | Public USDG peg reading | New public USDG peg reading with its source and age. |
| 5 | Day 1, +4 h | A | core | Rate-limit headers on every answer | Every answer now carries RateLimit headers. |
| 6 | Day 1, +5 h | C | core | MCP tool capstan_venues | New MCP tool capstan_venues. |
| 7 | Day 1, +6 h | D | core | Security headers on the API host | Stricter security headers on the API. |
| 8 | Day 1, +7 h | B | core | Market changes feed | New feed of market listings, delistings and reduce-only moves. |
| 9 | Day 1, +8 h | A | core | Per-venue status endpoint | New per-venue status: data age, budget headroom, last error class. |
| 10 | Day 1, +9 h | C | core | SDK keeps your agents after a page reload | The SDK now restores your agents after a browser reload. |
| 11 | Day 1, +10 h | D | core | Quote table readable on phones | Quotes are now readable on phones, one card per venue. |
| 12 | Day 1, +11 h | B | core | Spread scan says why a pair was left out | Spread scans now list excluded pairs and the reason, and one odd market no longer holds up the rest. |
| 13 | Day 1, +12 h | A | core | Close-all carries on past one venue and cancels resting orders | Close-all now carries on past a venue it cannot read and cancels resting orders before closing. |
| 14 | Day 1, +13 h | C | core | MCP tool capstan_book | New MCP tool capstan_book. |
| 15 | Day 1, +14 h | D | core | Content-Security-Policy for the website | The website and dashboard now send a strict Content-Security-Policy, and the dashboard is built and tested on every commit. |
| 16 | Day 1, +15 h | B | core | Alert when anchoring falls behind | Ops now get an alert when receipt anchoring fails or falls behind, and every anchored hour is recounted. |
| 17 | Day 1, +16 h | A | core | List of posted anchor roots | New list of anchored hourly roots with their transactions. |
| 18 | Day 1, +17 h | C | core | Receipts show their anchor | Receipts now carry their anchor transaction once posted. |
| 19 | Day 1, +18 h | D | core | Status page shows data age and the peg | Status page now shows venue data age and the USDG peg. |
| 20 | Day 1, +19 h | B | core | Public payment rail state | New public view of which payment rails are on, and a rail that misses one read now comes back by itself. |
| 21 | Day 1, +20 h | A | core | Request id on every answer | Every answer and error now carries a request id. |
| 22 | Day 1, +21 h | C | core | SDK waits politely on rate limits | The SDK now retries rate-limited reads after Retry-After. |
| 23 | Day 1, +22 h | D | core | Sitemap and robots for the website | The website now has a sitemap and robots file. |
| 24 | Day 1, +23 h | B | core | Builder fee reconciliation metric | Fee reconciliation now reports metrics and mismatches. |
| 25 | Day 2, +0 h | A | core | Error catalog | New error catalog with a plain explanation for every code. |
| 26 | Day 2, +1 h | C | core | MCP errors explain themselves | MCP errors now carry the code and a link to its explanation. |
| 27 | Day 2, +2 h | D | core | Each service gets its own database login | Each service now has its own database login with only the access it needs. |
| 28 | Day 2, +3 h | B | core | Quotes use the funding forecast when it is fresh | Quotes now use the funding forecast when it is fresh and say which source they used; forecasts say when their data was last seen. |
| 29 | Day 2, +4 h | A | core | Your tier and limits in one call | New /v1/limits: your tier, limits and credits. |
| 30 | Day 2, +5 h | C | core | SDK helpers for limits and errors | SDK: limits() and errorInfo() helpers. |
| 31 | Day 2, +6 h | D | core | Dashboard shows your tier and limits | Dashboard now shows your tier and limits. |
| 32 | Day 2, +7 h | B | core | New locks count within a block | Lock tier changes now apply within about one block. |
| 33 | Day 2, +8 h | A | core | Download all your receipts | Export all your receipts as one file. |
| 34 | Day 2, +9 h | C | core | SDK saves and checks your receipt export | SDK: save your receipts and verify every one offline. |
| 35 | Day 2, +10 h | D | core | Verify page takes a file | The verify page now checks a whole receipt file. |
| 36 | Day 2, +11 h | B | Whale | Lock Whale monthly call credits | Lock Whale owners now get $10 of premium-call credits each month. |
| 37 | Day 2, +12 h | A | core | Machine-readable price list | New machine-readable price list for paid routes, and every paid route now charges exactly what the list says. |
| 38 | Day 2, +13 h | C | core | MCP resources for the disclaimer, venues and prices | MCP now offers the disclaimer, venues and prices as resources. |
| 39 | Day 2, +14 h | D | core | Pricing page reads the live price list | Pricing page now reads the live price list. |
| 40 | Day 2, +15 h | B | Holder | More webhooks for lock tiers | Webhooks are now capped at 5, or 20 for lock tiers. |
| 41 | Day 2, +16 h | A | core | Send a test event to your webhook | Webhooks can now be tested with one call. |
| 42 | Day 2, +17 h | C | core | MCP rate limit per caller | MCP calls are now limited per caller, and each paid tool call runs once per payment. |
| 43 | Day 2, +18 h | D | core | Status page lists anchored roots | Status page now lists the last day of anchored roots. |
| 44 | Day 2, +19 h | B | core | Choose your liquidation alert distance | Liquidation alerts now take your own distance and watch every position you hold. |
| 45 | Day 2, +20 h | A | core | Webhook delivery log | New delivery log for each webhook. |
| 46 | Day 2, +21 h | C | core | Receipt checks in plain words | Receipt verification now explains each check and says when a receipt is not anchored yet. |
| 47 | Day 2, +22 h | D | core | Copy-ready samples in the docs | Docs now have copy-ready samples for every route. |
| 48 | Day 2, +23 h | B | core | Liquidation heatmap bucket size | Heatmap now takes a bucket size and counts each position once. |
| 49 | Day 3, +0 h | A | core | Receipt claims checked against the venue | Receipt claims are now checked against the venue's own order record. |
| 50 | Day 3, +1 h | C | core | Onboarding checks every step before you sign | Onboarding now checks every step before you sign, and Lighter onboarding includes the eligibility declaration. |
| 51 | Day 3, +2 h | D | core | Burn plans check a reference rate | Burn plans now check the pool rate against a 30-minute average and keep demo files apart. |
| 52 | Day 3, +3 h | B | core | Alert when a market you hold goes reduce-only | New alert when a market you hold goes reduce-only. |
| 53 | Day 3, +4 h | A | core | Lighter orders build reliably | Lighter order builds now use the venue's own next nonce and follow the market review. |
| 54 | Day 3, +5 h | C | core | SDK watch helpers for live channels | SDK: live watch helpers for risk, receipts and plans, and each spread plan now runs once. |
| 55 | Day 3, +6 h | D | core | Prometheus alert rules | New monitoring alert rules for the service. |
| 56 | Day 3, +7 h | B | core | Each payment unlocks exactly one answer | Each payment now unlocks exactly one paid answer. |
| 57 | Day 3, +8 h | A | core | Preview an order without building it | Order builds can now be previewed without storing anything. |
| 58 | Day 3, +9 h | C | core | Command line receipt check | New command line receipt checker. |
| 59 | Day 3, +10 h | D | core | README: verify a receipt in three commands | README now shows how to verify a receipt yourself. |
| 60 | Day 3, +11 h | B | core | Root indexer catches up after downtime | The root index now fills gaps after a restart and lists only roots that are final on chain. |
| 61 | Day 3, +12 h | A | core | Each order build is relayed once | Each order build is now relayed at most once, and a kill applies up to the moment of sending. |
| 62 | Day 3, +13 h | C | core | SDK checks the contract addresses too | SDK now refuses if the API serves different contract addresses. |
| 63 | Day 3, +14 h | D | core | Weekly restore test of the backups | Backups are now restore-tested every week. |
| 64 | Day 3, +15 h | B | core | Payment service settles only for Capstan and recovers stuck payments | The payment service now settles only Capstan's own payments and recovers payments held up by a network outage. |
| 65 | Day 3, +16 h | A | core | Published eligibility rules | Eligibility rules are now published with the age of the location data, and applied the same way at every step. |
| 66 | Day 3, +17 h | C | core | Agent limits count the worst case | Agent limits now count the largest order the signature allows, and the order ticket labels server estimates. |
| 67 | Day 3, +18 h | D | core | Security policy covers the whole stack | SECURITY.md now covers the website and operations, with accepted limits and review history. |
| 68 | Day 3, +19 h | B | core | Stored data stays bounded | Stored data now stays bounded: unused quotes, probes and idle anonymous keys are cleared. |
| 69 | Day 3, +20 h | A | core | Credits are spent only on answers that succeed | Call credits are now spent only on answers that succeed. |
| 70 | Day 3, +21 h | C | core | The newest agent policy you signed wins | Agent policies now carry a sequence, so the newest one you signed always applies. |
| 71 | Day 3, +22 h | D | core | Dashboard keeps your session after reload | Dashboard keeps your agents after a reload. |
| 72 | Day 3, +23 h | B | core | Public usage counts | Usage counts are now public. |

## Bonus updates

| Bonus | Key | When | Title | Line |
| --- | --- | --- | --- | --- |
| 1 | home-funding | launch day | Live funding comparison on the landing page | The landing page shows live funding for one asset on every venue that lists it, ranked by the observed annualised rate, with the gap between the highest and the lowest. |
| 2 | mcp-quickstart | launch day | MCP quick start on the agents page | The agents page has an MCP quick start: the hosted address, a copy-ready entry for HTTP clients, a one-line check that lists the tools, and every tool the server ships. |
| 3 | lock-calculator | later | Lock calculator on the pricing page | A lock calculator on the pricing page shows the tier an amount of $CPST on Robinhood Chain gives when locked, its rate limits and integration fee, and how much more reaches the next tier. |
