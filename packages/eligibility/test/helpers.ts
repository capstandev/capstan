// Test helpers: a migrated throwaway database, wallets derived from public labels (worthless keys), real DB-IP rows
// (a sample of the 2026-11 Lite file) and a receipt service with a label signer.
import { closeDb, createDb, createTempDatabase, schema, type Db } from "@capstan/core";
import { createReceiptService, nobleSigner, type ReceiptService } from "@capstan/receipts";
import type { Hex, TypedDataPayload, VenueId } from "@capstan/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes, keccak256, toBytes } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { declarationTypedData, DECLARATION_DOMAIN, declarationList, loadDbIpLite, storeDeclaration, type GeoLookup } from "../src";

export const PG = process.env.DATABASE_URL;
export const FIXTURE_CSV = join(import.meta.dir, "fixtures/dbip-country-lite-2026-11.sample.csv");
// In the past on purpose: ids are ULIDs from the injected clock, and future ids would break the shared ulid order.
export const NOW = Date.parse("2026-05-01T12:00:00Z");
/** The real clock, for the rule validator (a rule source date may not be in the future). */
export const REAL_NOW = () => Date.now();

/** A wallet whose key is keccak256 of a public label: tests only. */
export function wallet(label: string): PrivateKeyAccount {
  return privateKeyToAccount(keccak256(toBytes(`capstan-eligibility-test:${label}`))); // test-key (derived from a public label)
}

export function receiptSigner(label: string) {
  return nobleSigner(hexToBytes(keccak256(toBytes(`capstan-eligibility-receipts:${label}`)))); // test-key (derived from a public label)
}

/** First address of each country's first range in the real DB-IP sample: one real IP per country. */
export function ipByCountry(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(FIXTURE_CSV, "utf8").split("\n")) {
    const [start, , c] = line.split(",");
    if (!start || !c) continue;
    const key = start.includes(":") ? `${c}6` : c;
    if (!(key in out)) out[key] = start;
  }
  return out;
}

export const geo: GeoLookup = loadDbIpLite(FIXTURE_CSV);
export const IP = ipByCountry();

export async function signDeclaration(w: PrivateKeyAccount, venues: VenueId[], issuedAtS: number, refused?: string[]): Promise<{ td: TypedDataPayload; sig: Hex }> {
  const td = declarationTypedData(w.address, venues, refused ?? declarationList(venues), issuedAtS);
  const m = td.message as Record<string, unknown>;
  const sig = await w.signTypedData({
    domain: DECLARATION_DOMAIN,
    types: { Declaration: td.types.Declaration! },
    primaryType: "Declaration",
    message: { ...m, issuedAt: BigInt(m.issuedAt as number), expiresAt: BigInt(m.expiresAt as number) },
  });
  return { td, sig };
}

export interface DbFixture {
  db: Db;
  receipts: ReceiptService;
  declare(w: PrivateKeyAccount, venues: VenueId[], atMs?: number): Promise<string>;
  agent(id: string, owner: Hex, venue: VenueId, state?: string): Promise<void>;
  drop(): Promise<void>;
}

export async function dbFixture(label: string, now: () => Date = () => new Date(NOW)): Promise<DbFixture> {
  const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_el" });
  const db = createDb(t.url, { max: 4 });
  const receipts = createReceiptService({ db, signer: receiptSigner(label), now });
  return {
    db,
    receipts,
    async declare(w, venues, atMs = NOW) {
      const { td, sig } = await signDeclaration(w, venues, Math.floor(atMs / 1000));
      return (await storeDeclaration(td, sig, db, atMs)).id;
    },
    async agent(id, owner, venue, state = "active") {
      await db.insert(schema.delegations).values({ id, venue, owner: owner.toLowerCase(), agentAddress: wallet(`agent:${id}`).address.toLowerCase(), state });
    },
    async drop() {
      await closeDb(db);
      await t.drop();
    },
  };
}
