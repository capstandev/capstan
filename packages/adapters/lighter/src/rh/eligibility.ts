// Refused regions on Lighter-RH get data only: quotes come back refused with the code, nothing is built, and the
// stream to use is the venue's read-only one. GEO_REFUSED and the UAE rule (DECISIONS #18, BACKLOG C12) both apply.
import { CapstanError, type EligibilityCode, type VenueQuote } from "@capstan/schema";
import { LIGHTER_CONFIGS } from "../config";

export interface RhEligibilityDecision {
  decisionId: string;
  allowed: boolean;
  code?: EligibilityCode;
  country?: string | null;
  reason?: string;
}

/** Countries refused for Lighter-RH beyond the general geo list (DECISIONS #18: AE until the lawyer clears it). */
export const LIGHTER_RH_EXTRA_REFUSED = ["AE"] as const;

export function isRefused(d: RhEligibilityDecision): boolean {
  if (!d.allowed) return true;
  return !!d.country && (LIGHTER_RH_EXTRA_REFUSED as readonly string[]).includes(d.country.toUpperCase());
}

export function readOnlyMode(decision: RhEligibilityDecision): { wsUrl: string; executable: false } | null {
  return isRefused(decision) ? { wsUrl: LIGHTER_CONFIGS.rh.readonlyWs, executable: false } : null;
}

export function refusalCode(d: RhEligibilityDecision): EligibilityCode {
  return d.code ?? "GEO_REFUSED";
}

/** A quote for a refused user: same data, status refused with the code. */
export function refusedQuote(q: VenueQuote, d: RhEligibilityDecision): VenueQuote {
  return { ...q, status: "refused", refusal: { code: refusalCode(d), reason: d.reason ?? "Lighter on Robinhood Chain is data only from this region." } };
}

/** Refuse a build for a refused user before anything is made. */
export function assertMayBuild(d: RhEligibilityDecision): void {
  if (isRefused(d)) throw new CapstanError(refusalCode(d) === "GEO_REFUSED" ? "GEO_REFUSED" : "VENUE_DATA_ONLY", "Lighter on Robinhood Chain is data only from this region");
}
