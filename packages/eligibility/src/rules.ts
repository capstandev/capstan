// Venue eligibility matrix (spec 10), versioned and tighten-only. Version 1 is the union list: US, CA and GB (from the
// Arcus list, applied to every venue), the comprehensively sanctioned countries and regions, and every country on a
// retrieved venue list (Aster's Terms add CN and UA). AE is refused for the whole Lighter-RH venue (Stock Token
// collateral) and for Hyperliquid equity markets until legal review clears it. Rules only get stricter; a version
// that removes a country needs a source dated after the version it loosens.
import type { VenueId } from "@capstan/schema";
import { VENUE_IDS } from "@capstan/schema";

export const UNION_LIST_V1 = ["US", "CA", "GB", "CN", "KP", "RU", "UA", "CU", "IR", "VE", "SY"] as const;
/** ISO 3166-2 codes: Crimea, Donetsk, Luhansk. The country-level geo source cannot see them; UA is refused anyway. */
export const SANCTIONED_REGIONS = ["UA-43", "UA-14", "UA-09"] as const;

export type Kyc = "none" | "none_found" | "third_party" | "n/a";

export interface EligibilityRule {
  venue: VenueId;
  version: number;
  refusedCountries: string[]; // ISO 3166-1 alpha-2, upper case
  kyc: Kyc;
  source: string;
  sourceDate: string; // YYYY-MM-DD
  extra?: {
    refusedRegions?: string[]; // ISO 3166-2
    refuseForEquity?: string[]; // refused only for equity (stock) markets
    dataOnly?: boolean; // no write of any kind is routed
  };
}

const UNION = [...UNION_LIST_V1];
const REGIONS = [...SANCTIONED_REGIONS];

export const RULES_V1: EligibilityRule[] = [
  {
    venue: "hyperliquid",
    version: 1,
    refusedCountries: UNION,
    kyc: "none",
    source: "Hyperliquid terms bar US persons; union list v1 applied (spec 10)",
    sourceDate: "2026-11-05",
    extra: { refusedRegions: REGIONS, refuseForEquity: ["AE"] },
  },
  {
    venue: "lighter-mainnet",
    version: 1,
    refusedCountries: UNION,
    kyc: "none_found",
    source: "Lighter country list not published; union list v1 applied (spec 10)",
    sourceDate: "2026-11-05",
    extra: { refusedRegions: REGIONS },
  },
  {
    venue: "lighter-rh",
    version: 1,
    refusedCountries: [...UNION, "AE"],
    kyc: "none_found",
    source: "Union list v1 plus AE for Stock Token collateral (decision 18)",
    sourceDate: "2026-11-05",
    extra: { refusedRegions: REGIONS },
  },
  {
    venue: "aster",
    version: 1,
    refusedCountries: UNION,
    kyc: "none_found",
    source: "Aster Terms and Conditions, Prohibited Jurisdictions (last updated 2026-02-25)",
    sourceDate: "2026-11-05",
    extra: { refusedRegions: REGIONS },
  },
  {
    venue: "variational",
    version: 1,
    refusedCountries: UNION,
    kyc: "n/a",
    source: "Read-only venue in v1",
    sourceDate: "2026-11-05",
    extra: { refusedRegions: REGIONS, dataOnly: true },
  },
  {
    venue: "arcus",
    version: 1,
    refusedCountries: UNION,
    kyc: "third_party",
    source: "Arcus disclaimer excludes US, CA and GB; read-only venue in v1",
    sourceDate: "2026-11-05",
    extra: { refusedRegions: REGIONS, dataOnly: true },
  },
];

/** The newest compiled rule set. The database copy (eligibility_rules) can only be the same or stricter. */
export const CURRENT_RULES: EligibilityRule[] = RULES_V1;

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}

const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function validDay(s: string): boolean {
  if (!DAY.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const removed = (prev: readonly string[] | undefined, next: readonly string[] | undefined): string[] => {
  const n = new Set(next ?? []);
  return (prev ?? []).filter((c) => !n.has(c));
};

/** Shape checks for one rule set: one rule per venue, every venue covered, codes well formed, one version. */
export function checkRuleSet(set: EligibilityRule[], nowMs = Date.now()): void {
  if (set.length === 0) throw new RuleError("rule set is empty");
  const version = set[0]!.version;
  const seen = new Set<string>();
  for (const r of set) {
    if (!(VENUE_IDS as readonly string[]).includes(r.venue)) throw new RuleError(`unknown venue ${r.venue}`);
    if (seen.has(r.venue)) throw new RuleError(`venue ${r.venue} listed twice`);
    seen.add(r.venue);
    if (!Number.isInteger(r.version) || r.version < 1 || r.version !== version) throw new RuleError(`${r.venue}: every rule in a set has the same integer version`);
    for (const c of r.refusedCountries) if (!COUNTRY.test(c)) throw new RuleError(`${r.venue}: bad country code ${c}`);
    for (const c of r.extra?.refuseForEquity ?? []) if (!COUNTRY.test(c)) throw new RuleError(`${r.venue}: bad equity country code ${c}`);
    for (const c of r.extra?.refusedRegions ?? []) if (!REGION.test(c)) throw new RuleError(`${r.venue}: bad region code ${c}`);
    if (!r.source || r.source.trim().length < 3) throw new RuleError(`${r.venue}: source is required`);
    if (!validDay(r.sourceDate)) throw new RuleError(`${r.venue}: sourceDate must be YYYY-MM-DD`);
    if (Date.parse(`${r.sourceDate}T00:00:00Z`) > nowMs) throw new RuleError(`${r.venue}: sourceDate is in the future`);
  }
  for (const v of VENUE_IDS) if (!seen.has(v)) throw new RuleError(`venue ${v} has no rule`);
}

/**
 * Tighten-only (spec 10): `next` must have a higher version. Any loosening (a country, region or equity country
 * removed, or a data-only venue opened) needs that venue's sourceDate to be strictly newer than in `prev`.
 */
export function validateRuleUpgrade(prev: EligibilityRule[], next: EligibilityRule[], nowMs = Date.now()): void {
  checkRuleSet(prev, nowMs);
  checkRuleSet(next, nowMs);
  if (next[0]!.version <= prev[0]!.version) throw new RuleError(`version ${next[0]!.version} must be higher than ${prev[0]!.version}`);
  const byVenue = new Map(next.map((r) => [r.venue, r]));
  for (const p of prev) {
    const n = byVenue.get(p.venue)!;
    const loosened = [
      ...removed(p.refusedCountries, n.refusedCountries),
      ...removed(p.extra?.refusedRegions, n.extra?.refusedRegions),
      ...removed(p.extra?.refuseForEquity, n.extra?.refuseForEquity).map((c) => `${c} (equity)`),
      ...(p.extra?.dataOnly && !n.extra?.dataOnly ? ["data-only flag"] : []),
    ];
    if (loosened.length > 0 && !(n.sourceDate > p.sourceDate)) {
      throw new RuleError(`${p.venue}: v${n.version} loosens ${loosened.join(", ")} without a source dated after ${p.sourceDate}`);
    }
  }
}

export function ruleFor(set: EligibilityRule[], venue: VenueId): EligibilityRule {
  const r = set.find((x) => x.venue === venue);
  if (!r) throw new RuleError(`no rule for venue ${venue}`);
  return r;
}

/** Countries and regions a declaration for these venues must list (the equity-only list is not part of it). */
export function declarationList(venues: VenueId[], set: EligibilityRule[] = CURRENT_RULES): string[] {
  const out = new Set<string>();
  for (const v of venues) {
    const r = ruleFor(set, v);
    for (const c of r.refusedCountries) out.add(c);
    for (const c of r.extra?.refusedRegions ?? []) out.add(c);
  }
  return [...out].sort();
}
