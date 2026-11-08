// Every public sentence of the site lives here, so the copy check (scripts/check-copy.ts) and the claims ledger
// (web/CLAIMS.md) see one list. Plain English. Integration fees are the venues' builder fees.
import type { LiveFlags } from "./live";

/** DECISIONS #13: shown on the landing page, the docs page, pricing, the dashboard and inside every quote widget. */
export const DISCLAIMER = {
  title: "Risks and limits",
  lines: [
    "Each venue liquidates independently.",
    "Legging risk is yours.",
    "A trade-only key can still trade and liquidate its account.",
    "Not available in refused regions.",
    "Receipts prove what Capstan did, not venue fill quality.",
  ],
} as const;

export const REGION_REFUSED = "Not available in your region.";
export const TOKEN_LINE = "$CPST on Robinhood Chain";
export const PUBLIC_APIS = "Built on Hyperliquid's, Lighter's and Aster's public APIs.";

export interface Claim {
  id: string;
  text: string;
}

/** Landing page claims. Each id has a row in web/CLAIMS.md that says how an outsider checks it today. */
export function landingClaims(live: LiveFlags): Claim[] {
  const claims: Claim[] = [
    { id: "venues", text: "Quotes Hyperliquid (core and HIP-3 markets), Lighter on mainnet and on Robinhood Chain, and Aster side by side." },
    { id: "cost-columns", text: "Venue fee, integration fee, slippage, funding and liquidation price are shown in separate columns before you sign." },
    { id: "own-key", text: "Your trade-only key is made on your device. Capstan never sees it." },
    { id: "no-withdraw", text: "No venue approval Capstan asks for can withdraw or transfer funds." },
    { id: "fee-cap", text: "Your main wallet approves the integration fee once, with a cap of 0.03%." },
    { id: "liq-separate", text: "Every venue's liquidation price is shown on its own. Margin is never pooled across venues." },
    { id: "receipts", text: "Every routed order gets a signed receipt you can check on the verify page." },
    { id: "agents", text: "AI agents get one MCP server with owner-signed caps and a kill switch." },
  ];
  if (live.npmPublished) claims.push({ id: "npm", text: "Install the TypeScript SDK from npm: capstan-sdk." });
  if (live.sourcePublic) claims.push({ id: "source", text: "The API, SDK, MCP server and contracts are open source." });
  return claims;
}

export const LANDING = {
  oneLiner: "One API for perps on Hyperliquid, Lighter and Aster, signed in your own wallet, with every venue's liquidation price shown on its own.",
  threeSentences: [
    "Capstan quotes Hyperliquid (HIP-3 equities included), Lighter on mainnet and Robinhood Chain, and Aster side by side, with venue fee, builder fee, slippage and funding shown before you sign.",
    "Your trade-only key is generated on your device, your main wallet approves the capped builder fee once, and Capstan never sees a key or asks for withdraw rights.",
    "Agents get one MCP server with owner-signed caps and a kill switch, premium data is paid per call, and every routed order comes with a signed receipt.",
  ],
  howTitle: "How it works",
  how: [
    { title: "Quote", text: "Ask for a quote. Each venue comes back with its fee, the integration fee, slippage from the live book, funding over your holding time and the liquidation price at your leverage." },
    { title: "Onboard once per venue", text: "The SDK makes a trade-only key on your device. Your main wallet approves that key and a capped integration fee. The key cannot withdraw." },
    { title: "Build, check, sign", text: "Capstan returns the venue's own order payload. The SDK checks every field against what you asked for and signs it locally." },
    { title: "Relay and receipt", text: "Capstan relays the signed order, or your host posts it to the venue itself. Either way you get a signed receipt." },
  ],
  venuesTitle: "Venues",
  feesTitle: "Integration fees",
  feesNote: "Fees are charged by the venue on each fill and paid to Capstan's builder address. Lighter has no builder program, so Lighter routes cost nothing extra.",
  claimsTitle: "What Capstan does",
  neverTitle: "What Capstan never does",
  never: ["Hold or import your key or seed phrase.", "Ask for withdraw or transfer permission.", "Pool margin or collateral across venues.", "Route a request from a refused region."],
  cta: "Read the API docs",
} as const;

export interface VenueRow {
  venue: string;
  markets: string;
  access: "Orders and data" | "Data only";
}

export const VENUES: VenueRow[] = [
  { venue: "Hyperliquid", markets: "Core perps and HIP-3 markets (xyz, io and para reviewed, others after review)", access: "Orders and data" },
  { venue: "Lighter", markets: "Lighter mainnet perps", access: "Orders and data" },
  { venue: "Lighter on Robinhood Chain", markets: "Lighter perps settled on Robinhood Chain", access: "Orders and data" },
  { venue: "Aster", markets: "Aster perps through Aster Code", access: "Orders and data" },
  { venue: "Variational", markets: "Prices and funding for comparison", access: "Data only" },
  { venue: "Arcus", markets: "Prices and funding for comparison", access: "Data only" },
];

export interface FeeRow {
  venue: string;
  approval: string;
  charge: string;
  lockCharge: string;
}

/** DECISIONS #15. */
export const FEES: FeeRow[] = [
  { venue: "Hyperliquid core and HIP-3", approval: "ApproveBuilderFee, max 0.03%", charge: "2 bps", lockCharge: "1 bp" },
  { venue: "Aster", approval: "approveBuilder, maxFeeRate 0.0003 (0.03%)", charge: "2 bps", lockCharge: "1 bp" },
  { venue: "Lighter (mainnet and Robinhood Chain)", approval: "None", charge: "0 bps", lockCharge: "0 bps" },
  { venue: "Variational, Arcus", approval: "None (data only)", charge: "No orders", lockCharge: "No orders" },
];

export interface PriceRow {
  group: string;
  price: string;
}

/** DECISIONS #16 and #57: only the history route that ships is priced. */
export const PRICES: PriceRow[] = [
  { group: "Markets, books, marks, current funding, quotes, order build and submit, receipts", price: "Free, rate limited" },
  { group: "Funding forecast (next 8 settlements, all venues)", price: "$0.01 per call" },
  { group: "Spread scanner (ranked pairs with cost and breakeven time)", price: "$0.02 per call" },
  { group: "Risk snapshot for any set of public addresses", price: "$0.01 per call" },
  { group: "Liquidation heatmap per canonical asset", price: "$0.02 per call" },
  { group: "Historical funding (per 1,000 rows)", price: "$0.05" },
];

export function paymentRails(live: LiveFlags): string[] {
  const rails = ["USDC on Base", "USDC on Solana"];
  if (live.x402UsdgSettled) rails.push("USDG on Robinhood Chain");
  return rails;
}

export const PRICING = {
  title: "Pricing",
  intro: "Reads, quotes and order routing are free. A few data endpoints are paid per call with x402, with no account.",
  pricesTitle: "Pay per call",
  railsLabel: "Pay with",
  executionNote: "Execution stays free because the integration fee pays for it.",
  plansTitle: "Plans",
  plans: [
    { name: "Free", text: "Keyless reads and quotes, order build and relay, 6 MCP tools, IP and wallet rate limits." },
    { name: "Pay as you go", text: "x402 per call on the paid endpoints, with higher limits." },
    { name: "Pro", text: "Prepaid credits for paid calls, WebSocket fan-out and a priority relay lane. The price is set before general availability." },
  ],
  lockTitle: "Lock perks",
  lockIntro: "Locking $CPST on Robinhood Chain is never required to use the API, the SDK or the MCP server. Unlocking always works.",
  lockTiers: [
    { name: "Lock Holder", need: "100,000 or more locked", perks: "2x rate limits and a 1 bp integration fee" },
    { name: "Lock Whale", need: "1,000,000 or more locked", perks: "5x rate limits, a 1 bp integration fee and a monthly allowance of paid calls" },
  ],
  lockNote: "Locked tokens also carry an advisory vote on the venue list.",
} as const;

export const STATUS_COPY = {
  title: "Status",
  intro: "Read from the API when this page loads. Refresh the page for a new reading.",
  api: "API",
  up: "Responding",
  down: "Not responding",
  checking: "Checking",
  venues: "Venues",
  orders: "Orders and data",
  dataOnly: "Data only",
  off: "Paused",
} as const;

export const VERIFY_COPY = {
  title: "Verify a receipt",
  intro: "Paste a receipt id or the receipt JSON. The check runs in your browser: the signature, the Merkle leaf, the proof and the hourly root posted on Robinhood Chain.",
  label: "Receipt id or JSON",
  button: "Verify",
  signature: "Signature",
  leaf: "Leaf",
  proof: "Proof",
  root: "On-chain root",
  hour: "Proof hour",
  notPosted: "not posted yet",
  unanchored: "no root was posted for this hour, and none can be now",
  unchecked: "not checked (no anchor address yet)",
  rootMatches: "matches the posted root",
  rootDiffers: "differs from the posted root",
  valid: "The receipt is valid.",
  pending: "The receipt is not valid yet: its hourly root is not posted. Check again after the hour is anchored.",
  uncheckedHeadline: "The receipt is not verified: this build has no anchor address, so the posted root was not read.",
  invalid: "The receipt is not valid.",
  limits: "A valid receipt proves what Capstan did. It does not prove that a venue filled fairly.",
} as const;

export const LEGAL = {
  title: "Legal and risk",
  riskTitle: "Risk disclaimer",
  risk: [
    "Perpetual futures are leveraged. You can lose more than you expect, quickly.",
    "Each venue liquidates independently. A long on one venue and a short on another can both be liquidated.",
    "Legging risk is yours. A paired order has two venues, two signatures and two fills. Leg B can fail or slip after leg A fills.",
    "A trade-only key cannot withdraw, but it can still trade and liquidate the account it is bound to. Expiry, owner-signed caps and the kill switch reduce that risk. They do not remove it.",
    "Capstan can stop its own relay at once. It cannot revoke a venue key; only your main wallet can.",
    "Receipts prove what Capstan did, not venue fill quality.",
    "Venue APIs can change, rate limit or block regions without notice.",
  ],
  regionsTitle: "Restricted regions",
  regions: "Capstan refuses traffic from regions that a venue or Capstan restricts, and it never routes a refused request. Eligibility is best effort: an IP check and a signed declaration. Capstan does no identity checks. A refused request sees this message:",
  dbipTitle: "IP data",
  dbip: "IP geolocation by DB-IP",
  dbipLicense: "DB-IP Lite data is used under the Creative Commons Attribution 4.0 license.",
  nothingTitle: "Not advice",
  nothing: "Nothing on this site is investment, legal or tax advice. Funding rates are observed and change every hour.",
} as const;

export const NAV = [
  { to: "/", label: "Home" },
  { to: "/docs", label: "Docs" },
  { to: "/pricing", label: "Pricing" },
  { to: "/status", label: "Status" },
  { to: "/verify", label: "Verify" },
  { to: "/app", label: "Dashboard" },
  { to: "/legal", label: "Legal" },
] as const;

export const FORK_BANNER = "Local test network";
