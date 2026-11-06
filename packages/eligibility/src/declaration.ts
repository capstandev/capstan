// CapstanEligibility v1: the owner's signed declaration (spec 10, 7.2). EIP-712, domain
// { name: 'CapstanEligibility', version: '1', chainId: 4663 } with no verifying contract: the owner signs on any
// chain and the chain id only scopes the domain. It lasts 90 days. It is a best-effort statement, never identity
// verification: no KYC field exists.
import { schema, ulid, type Db } from "@capstan/core";
import { CapstanError, type Hex, type OnboardingStep, type TypedDataPayload, type VenueId, VENUE_IDS } from "@capstan/schema";
import { and, desc, eq, gt } from "drizzle-orm";
import { recoverTypedDataAddress } from "viem";
import { CURRENT_RULES, declarationList, type EligibilityRule } from "./rules";

export const DECLARATION_DOMAIN = { name: "CapstanEligibility", version: "1", chainId: 4663 } as const;
export const DECLARATION_STATEMENT = "I am not a resident or person of the listed countries and regions." as const;
export const DECLARATION_TTL_S = 90 * 24 * 3600;
export const DECLARATION_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
  ],
  Declaration: [
    { name: "owner", type: "address" },
    { name: "statement", type: "string" },
    { name: "refusedCountries", type: "string[]" },
    { name: "venues", type: "string[]" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const satisfies Record<string, { name: string; type: string }[]>;

const VIEM_TYPES = { Declaration: DECLARATION_TYPES.Declaration } as const;

export interface DeclarationMessage {
  owner: Hex;
  statement: string;
  refusedCountries: string[];
  venues: VenueId[];
  issuedAt: number; // unix seconds
  expiresAt: number; // unix seconds
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Typed data for the owner's main wallet. `issuedAt` is unix seconds. */
export function declarationTypedData(owner: Hex, venues: VenueId[], refusedList: string[], issuedAt: number): TypedDataPayload {
  if (!ADDR.test(owner)) throw new CapstanError("INVALID_INPUT", "owner must be an address");
  if (venues.length === 0 || venues.some((v) => !(VENUE_IDS as readonly string[]).includes(v))) throw new CapstanError("INVALID_INPUT", "venues must be known venue ids");
  if (!Number.isInteger(issuedAt) || issuedAt <= 0 || issuedAt > 2 ** 40) throw new CapstanError("INVALID_INPUT", "issuedAt must be unix seconds");
  const message: DeclarationMessage = {
    owner: owner.toLowerCase() as Hex,
    statement: DECLARATION_STATEMENT,
    refusedCountries: [...new Set(refusedList)].sort(),
    venues: [...new Set(venues)].sort() as VenueId[],
    issuedAt,
    expiresAt: issuedAt + DECLARATION_TTL_S,
  };
  return { domain: { ...DECLARATION_DOMAIN }, types: JSON.parse(JSON.stringify(DECLARATION_TYPES)) as TypedDataPayload["types"], primaryType: "Declaration", message: message as unknown as Record<string, unknown> };
}

/** The first onboarding step of every venue bundle (todos 06, 11, 14). */
export function declarationStep(owner: Hex, venues: VenueId[], nowMs: number, rules: EligibilityRule[] = CURRENT_RULES): OnboardingStep {
  return { kind: "eligibility_declaration", signer: "main_wallet", typedData: declarationTypedData(owner, venues, declarationList(venues, rules), Math.floor(nowMs / 1000)) };
}

function asMessage(td: TypedDataPayload): DeclarationMessage {
  const m = td.message as Partial<DeclarationMessage>;
  const strs = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");
  if (
    td.primaryType !== "Declaration" ||
    td.domain?.name !== DECLARATION_DOMAIN.name ||
    td.domain?.version !== DECLARATION_DOMAIN.version ||
    Number(td.domain?.chainId) !== DECLARATION_DOMAIN.chainId ||
    td.domain?.verifyingContract !== undefined ||
    typeof m.owner !== "string" ||
    !ADDR.test(m.owner) ||
    m.statement !== DECLARATION_STATEMENT ||
    !strs(m.refusedCountries) ||
    !strs(m.venues) ||
    !Number.isInteger(m.issuedAt) ||
    !Number.isInteger(m.expiresAt) ||
    m.expiresAt !== m.issuedAt! + DECLARATION_TTL_S
  ) {
    throw new CapstanError("INVALID_INPUT", "not a CapstanEligibility v1 declaration");
  }
  if (m.venues.some((v) => !(VENUE_IDS as readonly string[]).includes(v))) throw new CapstanError("INVALID_INPUT", "unknown venue in the declaration");
  return m as DeclarationMessage;
}

/** Rebuild the typed data from our own template, so stored fields and types can never differ from what we hash. */
function canonical(m: DeclarationMessage): TypedDataPayload {
  return declarationTypedData(m.owner, m.venues, m.refusedCountries, m.issuedAt);
}

/** The address that signed the declaration, or null when the signature does not parse. */
export async function recoverDeclarationSigner(td: TypedDataPayload, sig: Hex): Promise<Hex | null> {
  const m = asMessage(td);
  try {
    const a = await recoverTypedDataAddress({
      domain: DECLARATION_DOMAIN,
      types: VIEM_TYPES,
      primaryType: "Declaration",
      message: { owner: m.owner, statement: m.statement, refusedCountries: [...new Set(m.refusedCountries)].sort(), venues: [...new Set(m.venues)].sort(), issuedAt: BigInt(m.issuedAt), expiresAt: BigInt(m.expiresAt) },
      signature: sig,
    });
    return a.toLowerCase() as Hex;
  } catch {
    return null;
  }
}

/** Check the signature recovers to the owner and the declaration is current; store it. */
export async function storeDeclaration(td: TypedDataPayload, sig: Hex, db: Db, nowMs = Date.now()): Promise<{ id: string; expiresAt: Date }> {
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new CapstanError("INVALID_INPUT", "sig must be a 65-byte hex signature");
  const m = asMessage(td);
  const signer = await recoverDeclarationSigner(td, sig);
  if (signer === null || signer !== m.owner.toLowerCase()) throw new CapstanError("UNAUTHORIZED", "the declaration signature does not match the owner");
  const nowS = Math.floor(nowMs / 1000);
  if (m.issuedAt > nowS + 300) throw new CapstanError("INVALID_INPUT", "the declaration is dated in the future");
  if (m.expiresAt <= nowS) throw new CapstanError("DECLARATION_MISSING", "the declaration has expired; sign a new one");
  const id = `dcl_${ulid(nowMs)}`;
  const expiresAt = new Date(m.expiresAt * 1000);
  await db.insert(schema.declarations).values({ id, owner: m.owner.toLowerCase(), typedData: canonical(m), sig: sig.toLowerCase(), expiresAt });
  return { id, expiresAt };
}

/**
 * A declaration that lets `owner` write on `venue` now: signed by the owner, not expired, naming the venue, and listing
 * every country and region the venue's current rule refuses (a stricter rule set needs a fresh signature).
 */
export async function findValidDeclaration(db: Db, owner: Hex, venue: VenueId, rule: EligibilityRule, now: Date): Promise<{ id: string; expiresAt: Date } | null> {
  const t = schema.declarations;
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.owner, owner.toLowerCase()), gt(t.expiresAt, now)))
    .orderBy(desc(t.expiresAt))
    .limit(20);
  const needed = [...rule.refusedCountries, ...(rule.extra?.refusedRegions ?? [])];
  const nowS = Math.floor(now.getTime() / 1000);
  for (const r of rows) {
    let m: DeclarationMessage;
    try {
      m = asMessage(r.typedData as TypedDataPayload);
    } catch {
      continue;
    }
    if (m.owner.toLowerCase() !== owner.toLowerCase() || m.expiresAt <= nowS || m.issuedAt > nowS + 300) continue;
    if (!m.venues.includes(venue)) continue;
    const listed = new Set(m.refusedCountries);
    if (!needed.every((c) => listed.has(c))) continue;
    const signer = await recoverDeclarationSigner(r.typedData as TypedDataPayload, r.sig as Hex);
    if (signer !== owner.toLowerCase()) continue;
    return { id: r.id, expiresAt: r.expiresAt };
  }
  return null;
}
