# Catalog sources (drop-in)

Each venue adapter adds one file here, `<venue>.source.ts`, exporting `source`:

```ts
import type { MarketSource } from "@capstan/catalog";

export const source: MarketSource = {
  venue: "hyperliquid",
  async listMarkets() { /* every market the venue lists, including delisted ones, as Market[] */ },
  async listDexes() { /* Hyperliquid only: perpDexs entries as { dex, index, liveMarkets } */ },
};
```

The nightly `catalog-sync` job (00:15 UTC) loads every `*.source.ts` in this folder by glob, in name order. Nobody
edits a shared list.

Rules for a source:
- Return markets with `id = marketId(venue, dex, venueSymbol)` from `@capstan/schema`. Lighter ids differ per config
  (`lighter-mainnet` and `lighter-rh`); never reuse a mainnet market index on the other config.
- Set `marketType` from the venue's own field (`perp`, `spot`, `other`); only `perp` can ever execute.
- Keep the raw universe index in `venueIndex` (Hyperliquid asset ids count delisted entries). Never recompute it from
  a filtered list.
- Set `assetClassHint` when the venue states the class (for example a stock perp) and `contractMultiplier` and
  `oracleSource` when the venue publishes them. They feed review; they never map a market by themselves.
- Leave `executable: false`. The sync never turns a market on; only a review does.
- Throw on a failed read. A source that throws is reported and skipped, and its markets are not delisted.
