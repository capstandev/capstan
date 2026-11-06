// What is live today. Copy that depends on a milestone reads these flags, so the site never claims something before
// an outsider can check it (web/CLAIMS.md). Each flag flips only when its check passes; the token box reads
// contracts.json instead of a flag.
export interface LiveFlags {
  /** capstan-sdk and capstan-mcp are on the npm registry. */
  npmPublished: boolean;
  /** An x402 USDG payment on Robinhood Chain testnet settled end to end. */
  x402UsdgSettled: boolean;
  /** The source repository is public. */
  sourcePublic: boolean;
}

export const LIVE: LiveFlags = { npmPublished: false, x402UsdgSettled: false, sourcePublic: false };
