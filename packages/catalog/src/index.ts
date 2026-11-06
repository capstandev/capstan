// @capstan/catalog: canonical-asset map, alias proposals, reviewed equivalences and the nightly market sync.
export { baseSymbol, CRYPTO_MAJORS, proposeCanonical, type Proposal } from "./propose";
export { DATA_ONLY_VENUES, emptyReport, ensureCanonicalAsset, executableAllowedByShape, REVIEWABLE_DEXES, syncMarkets, type MarketSource, type SyncReport } from "./sync";
export {
  approvedEquivalences,
  contractSpecDiff,
  equivalenceDiffs,
  isExecutable,
  pendingReviews,
  proposeEquivalence,
  ReviewError,
  reviewEquivalence,
  rowToMarket,
  setDexExecutable,
  setExecutable,
  type Equivalence,
  type ReviewResult,
  type SpecDiff,
} from "./review";
