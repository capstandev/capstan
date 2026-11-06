// Capstan API keys (account keys for the gateway, never wallet keys). The plain key is returned once; only an
// argon2id hash (Bun.password) is stored in api_accounts.key_hash. Format: cpst_<accountId>_<secret>, so a lookup is
// one row and the secret is checked with a constant-time hash verify.
// Creating a key for a wallet needs that wallet's capstanMessage signature with purpose api_key_create (SIG-1); a
// signature made for any other purpose is refused.
import { schema, ulid, verifyCapstanMessage, type Db, type NonceStore } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { eq } from "drizzle-orm";

export const API_KEY_PREFIX = "cpst_";
const KEY_RE = /^cpst_([0-9A-HJKMNP-TV-Z]{26})_([A-Za-z0-9_-]{43})$/;

export class ApiKeyError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`api key: ${reason}`);
    this.name = "ApiKeyError";
    this.reason = reason;
  }
}

export interface OwnerProof {
  message: string;
  sig: Hex;
}
export interface KeyDeps {
  host: string;
  nonces: NonceStore;
  nowMs?: number;
}

function secret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/**
 * Create an account and its API key. ownerWallet null = an anonymous free key. With an owner wallet, `ownerSig` must
 * be a capstanMessage (purpose api_key_create, this host) signed by that wallet.
 */
export async function createApiKey(db: Db, ownerWallet: Hex | null, ownerSig?: OwnerProof, deps?: KeyDeps): Promise<{ id: string; key: string }> {
  if (ownerWallet !== null) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(ownerWallet)) throw new ApiKeyError("owner must be an address");
    if (!ownerSig || !deps) throw new ApiKeyError("an owner signature is required");
    const v = await verifyCapstanMessage(ownerSig.message, ownerSig.sig, { purpose: "api_key_create", signers: [ownerWallet], host: deps.host, nowMs: deps.nowMs ?? Date.now() }, deps.nonces);
    if (!v.ok) throw new ApiKeyError(`owner signature refused (${v.reason})`);
  }
  const id = ulid();
  const plain = `${API_KEY_PREFIX}${id}_${secret()}`;
  const keyHash = await Bun.password.hash(plain, { algorithm: "argon2id" });
  await db.insert(schema.apiAccounts).values({ id, keyHash, ownerWallet: ownerWallet ? ownerWallet.toLowerCase() : null, tier: "free", credits: "0" });
  return { id, key: plain };
}

/** The account id for a presented key, or null (unknown account, malformed key or wrong secret). */
export async function verifyApiKey(db: Db, presented: string): Promise<{ id: string; ownerWallet: string | null; tier: string } | null> {
  const m = KEY_RE.exec(presented);
  if (!m) return null;
  const rows = await db.select().from(schema.apiAccounts).where(eq(schema.apiAccounts.id, m[1]!));
  const row = rows[0];
  if (!row) return null;
  const ok = await Bun.password.verify(presented, row.keyHash, "argon2id").catch(() => false);
  return ok ? { id: row.id, ownerWallet: row.ownerWallet, tier: row.tier } : null;
}
