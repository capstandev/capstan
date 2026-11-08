// The decision engine (spec 10). Order: data-only venue, IP country (unknown country refuses a write), equity-only
// countries, agent default-deny, owner declaration, else allowed. Reads and quotes are never refused for geography:
// a refused or unknown country gets them marked readOnly. Every call writes one eligibility_decisions row holding the
// country code only; the IP itself is never stored.
import { schema, ulid, type Db } from "@capstan/core";
import { CapstanError, type Hex, type VenueId, VENUE_IDS } from "@capstan/schema";
import { and, desc, eq } from "drizzle-orm";
import { findValidDeclaration } from "./declaration";
import type { GeoLookup } from "./geo";
import { CURRENT_RULES, checkRuleSet, ruleFor, validateRuleUpgrade, type EligibilityRule, type Kyc } from "./rules";

export type EligibilityAction = "quote" | "onboarding" | "order" | "spread_leg" | "read";
export const WRITE_ACTIONS: readonly EligibilityAction[] = ["onboarding", "order", "spread_leg"];
export type DecisionCode = "GEO_REFUSED" | "DECLARATION_MISSING" | "VENUE_DATA_ONLY";

export interface EligibilityInput {
  ip: string;
  owner?: Hex;
  agentRef?: string;
  venue: VenueId;
  marketId?: string;
  isEquityMarket?: boolean;
  action: EligibilityAction;
  /** false: evaluate with the owner but write the decision row with owner null (the owner was not authenticated). */
  recordOwner?: boolean;
  /** false: compute only, write no decision row (the public eligibility probe, r1 ELIG-2). */
  persist?: boolean;
}

export type EligibilityDecision = {
  id: string;
  allowed: boolean;
  code?: DecisionCode;
  rulesVersion: number;
  ipCountry: string | null;
  declarationId: string | null;
  readOnly?: boolean;
};

export interface DecideDeps {
  geo: GeoLookup;
  db: Db;
  now: () => Date;
  /** Rule source; defaults to the newest set in eligibility_rules, never older than the compiled set. */
  rules?: () => Promise<EligibilityRule[]>;
}

export const isWrite = (a: EligibilityAction): boolean => WRITE_ACTIONS.includes(a);

// ---------------------------------------------------------------- rules in the database
type RuleRow = typeof schema.eligibilityRules.$inferSelect;

function fromRow(r: RuleRow): EligibilityRule {
  const extra = (r.extra ?? {}) as EligibilityRule["extra"];
  return { venue: r.venue as VenueId, version: r.version, refusedCountries: [...r.refusedCountries], kyc: r.kyc as Kyc, source: r.source, sourceDate: r.sourceDate, ...(extra && Object.keys(extra).length ? { extra } : {}) };
}

/** The newest complete rule set stored, or null when the table is empty. */
export async function storedRules(db: Db): Promise<EligibilityRule[] | null> {
  const t = schema.eligibilityRules;
  const top = await db.select({ version: t.version }).from(t).orderBy(desc(t.version)).limit(1);
  if (top.length === 0) return null;
  const rows = await db.select().from(t).where(eq(t.version, top[0]!.version));
  return rows.map(fromRow);
}

/**
 * Store a rule set. The first set must equal or tighten the compiled one; each later set must pass the tighten-only
 * validator against the stored set. Storing the same version twice is a no-op when nothing differs.
 */
export async function installRules(db: Db, set: EligibilityRule[], nowMs = Date.now()): Promise<{ version: number; installed: boolean }> {
  checkRuleSet(set, nowMs);
  const prev = (await storedRules(db)) ?? null;
  const version = set[0]!.version;
  if (prev && prev[0]!.version === version) {
    const same = normSet(prev) === normSet(set);
    if (!same) throw new CapstanError("INVALID_INPUT", `rules v${version} are already stored with different contents`);
    return { version, installed: false };
  }
  if (prev) validateRuleUpgrade(prev, set, nowMs);
  else if (version !== CURRENT_RULES[0]!.version) validateRuleUpgrade(CURRENT_RULES, set, nowMs);
  await db.insert(schema.eligibilityRules).values(set.map(toRow));
  cache.delete(db);
  return { version, installed: true };
}

function normSet(set: EligibilityRule[]): string {
  const sorted = (xs: string[] | undefined) => [...(xs ?? [])].sort();
  return JSON.stringify(
    [...set]
      .sort((a, b) => a.venue.localeCompare(b.venue))
      .map((r) => [r.venue, r.version, sorted(r.refusedCountries), r.kyc, r.source, r.sourceDate, sorted(r.extra?.refusedRegions), sorted(r.extra?.refuseForEquity), r.extra?.dataOnly === true]),
  );
}

function toRow(r: EligibilityRule): RuleRow {
  return { version: r.version, venue: r.venue, refusedCountries: [...r.refusedCountries], kyc: r.kyc, source: r.source, sourceDate: r.sourceDate, extra: r.extra ?? {} };
}

const RULES_TTL_MS = 60_000;
const cache = new WeakMap<Db, { at: number; set: EligibilityRule[] }>();

/** Rules in force: the stored set when it is at least the compiled version, else the compiled set (fail strict). */
export async function rulesInForce(db: Db, nowMs: number): Promise<EligibilityRule[]> {
  const hit = cache.get(db);
  if (hit && nowMs - hit.at < RULES_TTL_MS) return hit.set;
  const stored = await storedRules(db);
  const set = stored && stored[0]!.version >= CURRENT_RULES[0]!.version && stored.length === VENUE_IDS.length ? stored : CURRENT_RULES;
  cache.set(db, { at: nowMs, set });
  return set;
}

export function clearRulesCache(db: Db): void {
  cache.delete(db);
}

// ---------------------------------------------------------------- agents
/** The owner of an active agent on this venue, or null when the agent is unknown, on another venue, retired, killed or expired. */
async function agentOwner(db: Db, agentRef: string, venue: VenueId, now: Date): Promise<Hex | null> {
  const t = schema.delegations;
  const rows = await db.select().from(t).where(and(eq(t.id, agentRef), eq(t.state, "active"), eq(t.venue, venue))).limit(1);
  const r = rows[0];
  if (!r) return null;
  if (r.expiresAt && r.expiresAt.getTime() <= now.getTime()) return null;
  return r.owner.toLowerCase() as Hex;
}

// ---------------------------------------------------------------- decide
export async function decide(input: EligibilityInput, deps: DecideDeps): Promise<EligibilityDecision> {
  if (!(VENUE_IDS as readonly string[]).includes(input.venue)) throw new CapstanError("UNSUPPORTED_VENUE");
  if (!WRITE_ACTIONS.includes(input.action) && input.action !== "quote" && input.action !== "read") throw new CapstanError("INVALID_INPUT", "unknown action");
  const now = deps.now();
  const set = deps.rules ? await deps.rules() : await rulesInForce(deps.db, now.getTime());
  const rule = ruleFor(set, input.venue);
  const rulesVersion = rule.version;
  const ipCountry = normCountry(deps.geo.country(input.ip));
  const region = deps.geo.region ? normRegion(deps.geo.region(input.ip)) : null;
  const write = isWrite(input.action);
  const geoRefused = ipCountry === null || rule.refusedCountries.includes(ipCountry) || (region !== null && (rule.extra?.refusedRegions ?? []).includes(region));
  const equityRefused = input.isEquityMarket === true && ipCountry !== null && (rule.extra?.refuseForEquity ?? []).includes(ipCountry);
  const owner = input.owner && /^0x[0-9a-fA-F]{40}$/.test(input.owner) ? (input.owner.toLowerCase() as Hex) : null;

  let code: DecisionCode | undefined;
  let declarationId: string | null = null;
  let readOnly: boolean | undefined;

  if (write) {
    if (rule.extra?.dataOnly) code = "VENUE_DATA_ONLY";
    else if (geoRefused || equityRefused) code = "GEO_REFUSED";
    else {
      let who = owner;
      if (input.agentRef !== undefined) {
        // default-deny: the agent must be active and bound to the owner the declaration belongs to
        const bound = await agentOwner(deps.db, input.agentRef, input.venue, now);
        if (bound === null || (who !== null && bound !== who)) who = null;
        else who = bound;
      }
      const dcl = who ? await findValidDeclaration(deps.db, who, input.venue, rule, now) : null;
      if (dcl) declarationId = dcl.id;
      // The owner's first onboarding is where the declaration is signed (it is step 0 of the bundle, spec 10 item 2),
      // so an owner onboarding needs no stored one yet: the submit stores the signed declaration before any venue
      // step is sent (apps/api onboarding.routes.ts). An agent never onboards without one (default-deny).
      else if (!(input.action === "onboarding" && input.agentRef === undefined && owner !== null)) code = "DECLARATION_MISSING";
    }
  } else if (geoRefused || equityRefused) {
    readOnly = true;
  }

  const decision: EligibilityDecision = { id: `eld_${ulid(now.getTime())}`, allowed: code === undefined, rulesVersion, ipCountry, declarationId };
  if (code) decision.code = code;
  if (readOnly) decision.readOnly = true;
  if (input.persist === false) return decision;
  const recorded = input.recordOwner === false ? null : owner;
  await deps.db.insert(schema.eligibilityDecisions).values({
    id: decision.id,
    owner: recorded,
    agentRef: recorded === null && input.recordOwner === false ? null : (input.agentRef ?? null),
    ipCountry,
    declarationId,
    venue: input.venue,
    rulesVersion,
    allowed: decision.allowed,
    code: code ?? null,
    ts: now,
  });
  return decision;
}

function normCountry(c: string | null): string | null {
  if (typeof c !== "string") return null;
  const u = c.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(u) && u !== "ZZ" && u !== "XX" ? u : null;
}

function normRegion(c: string | null): string | null {
  if (typeof c !== "string") return null;
  const u = c.trim().toUpperCase();
  return /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(u) ? u : null;
}
