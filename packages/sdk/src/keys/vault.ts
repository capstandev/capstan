// The shared KeyStore logic. A backend persists sealed records; a sealer encrypts them (AES-256-GCM, key never
// extractable). The plain secret exists only for the length of one signature and is zeroed after.
// Lighter keys are made inside the WASM Worker and leave it only through exportEncrypted, straight into the sealer.
import type { VenueId } from "@capstan/schema";
import type { LighterChainId } from "@capstan/signer-lighter-wasm";
import { b64decode, b64encode, toHex } from "../bytes";
import { SdkError } from "../errors";
import { addressOfSecret, defaultRandom, newSecretKey, signDigestRsv } from "./secp";
import { isHex32, type KeyInfo, type KeyKind, type KeyStore, type KeyStoreOptions, type LighterSignerFactory, type LighterSignRequest, type LighterSignResult } from "./types";

export interface SealedRecord {
  ref: string;
  venue: VenueId;
  kind: KeyKind;
  publicPart: string;
  createdAt: number;
  /** base64 of iv (12 bytes) || ciphertext+tag; absent once wiped (the tombstone keeps publicPart: no reuse). */
  sealed?: string;
  wipedAt?: number;
  tags?: Record<string, string>;
}

export interface RecordBackend {
  load(): Promise<SealedRecord[]>;
  save(records: SealedRecord[]): Promise<void>;
}

export interface Sealer {
  seal(plain: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  open(blob: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
}

/** AES-256-GCM with a WebCrypto key the caller made non-extractable. */
export function aesGcmSealer(key: CryptoKey, random: (n: number) => Uint8Array = defaultRandom): Sealer {
  if (key.extractable) throw new Error("the wrapping key must be non-extractable");
  return {
    async seal(plain, aad) {
      const iv = random(12);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource }, key, plain as BufferSource));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv, 0);
      out.set(ct, 12);
      return out;
    },
    async open(blob, aad) {
      if (blob.length < 12 + 16) throw new SdkError("UNLOCK_FAILED", "the key record is damaged");
      try {
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12) as BufferSource, additionalData: aad as BufferSource }, key, blob.slice(12) as BufferSource));
      } catch {
        throw new SdkError("UNLOCK_FAILED", "could not unlock the key");
      }
    },
  };
}

export async function newWrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const aadOf = (r: Pick<SealedRecord, "ref" | "venue" | "kind" | "publicPart">): Uint8Array => new TextEncoder().encode(`capstan-key-v1|${r.ref}|${r.venue}|${r.kind}|${r.publicPart.toLowerCase()}`);

const LIGHTER_VENUES = new Set<VenueId>(["lighter-mainnet", "lighter-rh"]);
const SECP_VENUES = new Set<VenueId>(["hyperliquid", "aster"]);

async function defaultLighterFactory(chainId: LighterChainId) {
  // lazy: the WASM loads only when a Lighter route is used
  const m = await import("@capstan/signer-lighter-wasm");
  return m.createLighterSigner(chainId);
}

/** The KeyStore over a backend and a sealer. Calls are serialised so a Worker never signs with the wrong key. */
export function vaultKeyStore(backend: RecordBackend, sealerFor: () => Promise<Sealer>, opts: KeyStoreOptions = {}): KeyStore {
  const random = opts.random ?? defaultRandom;
  const clock = opts.clock ?? Date.now;
  const lighterFactory: LighterSignerFactory = opts.lighter ?? defaultLighterFactory;
  const lighterSigners = new Map<number, Promise<Awaited<ReturnType<LighterSignerFactory>>>>();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => undefined);
    return p;
  };
  const lighterFor = (chainId: LighterChainId) => {
    let s = lighterSigners.get(chainId);
    if (!s) {
      s = lighterFactory(chainId);
      lighterSigners.set(chainId, s);
      s.catch(() => lighterSigners.delete(chainId));
    }
    return s;
  };
  const newRef = (venue: VenueId, kind: KeyKind) => `${venue}:${kind}:${toHex(random(10)).slice(2)}`;

  async function findActive(ref: string): Promise<SealedRecord> {
    const recs = await backend.load();
    const r = recs.find((x) => x.ref === ref && x.sealed !== undefined);
    if (!r) throw new SdkError("KEY_NOT_FOUND", "no such key in the local store");
    return r;
  }

  const store: KeyStore = {
    create(venue, kind) {
      return serial(async () => {
        if (kind === "secp256k1" && !SECP_VENUES.has(venue)) throw new SdkError("INVALID_INPUT", `${venue} does not use a secp256k1 delegated key`);
        if (kind === "lighter" && !LIGHTER_VENUES.has(venue)) throw new SdkError("INVALID_INPUT", `${venue} does not use a Lighter key`);
        if (kind !== "secp256k1" && kind !== "lighter") throw new SdkError("INVALID_INPUT", "unknown key kind");
        const sealer = await sealerFor();
        const recs = await backend.load();
        const used = new Set(recs.map((r) => r.publicPart.toLowerCase()));
        const ref = newRef(venue, kind);
        let publicPart: string;
        let sealed: Uint8Array;
        if (kind === "secp256k1") {
          const sk = newSecretKey(random);
          try {
            publicPart = addressOfSecret(sk);
            if (used.has(publicPart.toLowerCase())) throw new SdkError("KEY_REUSED", "the new key matches one made before; refusing to reuse it");
            sealed = await sealer.seal(sk, aadOf({ ref, venue, kind, publicPart }));
          } finally {
            sk.fill(0);
          }
        } else {
          const chainId: LighterChainId = venue === "lighter-rh" ? 466324 : 304;
          const signer = await lighterFor(chainId);
          const { publicKey } = signer.generateApiKey();
          publicPart = `0x${publicKey.replace(/^0x/i, "").toLowerCase()}`;
          if (used.has(publicPart)) throw new SdkError("KEY_REUSED", "the new key matches one made before; refusing to reuse it");
          sealed = await signer.exportEncrypted((raw) => sealer.seal(raw, aadOf({ ref, venue, kind, publicPart })));
        }
        recs.push({ ref, venue, kind, publicPart, createdAt: clock(), sealed: b64encode(sealed) });
        await backend.save(recs);
        return { ref, publicPart };
      });
    },

    sign(ref, digestOrArgs) {
      return serial(async () => {
        const r = await findActive(ref);
        const sealer = await sealerFor();
        const aad = aadOf(r);
        const blob = b64decode(r.sealed!);
        if (r.kind === "secp256k1") {
          if (!isHex32(digestOrArgs)) throw new SdkError("INVALID_INPUT", "a secp256k1 key signs a 32-byte digest only");
          const sk = await sealer.open(blob, aad);
          try {
            if (addressOfSecret(sk).toLowerCase() !== r.publicPart.toLowerCase()) throw new SdkError("UNLOCK_FAILED", "the key record is damaged");
            return signDigestRsv(digestOrArgs, sk);
          } finally {
            sk.fill(0);
          }
        }
        const req = digestOrArgs as LighterSignRequest;
        if (!req || typeof req !== "object" || typeof req.op !== "string") throw new SdkError("INVALID_INPUT", "a Lighter key signs a LighterSignRequest");
        const signer = await lighterFor(req.chainId);
        const a = req.args as { accountIndex: number; apiKeyIndex: number };
        await signer.importEncrypted(blob, (b) => sealer.open(b, aad), a.accountIndex, a.apiKeyIndex);
        let out: LighterSignResult;
        switch (req.op) {
          case "createOrder":
            out = await signer.signCreateOrder(req.args);
            break;
          case "cancelOrder":
            out = await signer.signCancelOrder(req.args);
            break;
          case "changePubKey":
            if (req.args.pubKeyHex.toLowerCase() !== r.publicPart.toLowerCase()) throw new SdkError("PAYLOAD_MISMATCH", "the key registration names another public key", { field: "pubKeyHex" });
            out = await signer.signChangePubKey(req.args);
            break;
          case "approveIntegrator":
            out = await signer.signApproveIntegrator(req.args);
            break;
          default:
            throw new SdkError("UNSUPPORTED", "this Lighter operation is not signed by the SDK");
        }
        return out;
      });
    },

    wipe(ref) {
      return serial(async () => {
        const recs = await backend.load();
        const r = recs.find((x) => x.ref === ref);
        if (!r) return;
        delete r.sealed;
        r.wipedAt = clock();
        await backend.save(recs);
      });
    },

    async list() {
      const recs = await backend.load();
      return recs.filter((r) => r.sealed !== undefined).map(infoOf);
    },

    async usedPublicParts() {
      return (await backend.load()).map((r) => r.publicPart.toLowerCase());
    },

    tag(ref, tags) {
      return serial(async () => {
        const recs = await backend.load();
        const r = recs.find((x) => x.ref === ref);
        if (!r) throw new SdkError("KEY_NOT_FOUND", "no such key in the local store");
        for (const v of Object.values(tags)) if (typeof v !== "string" || /^(0x)?[0-9a-fA-F]{64,}$/.test(v)) throw new SdkError("INVALID_INPUT", "tags hold short public labels only");
        r.tags = { ...(r.tags ?? {}), ...tags };
        await backend.save(recs);
      });
    },

    close() {
      for (const s of lighterSigners.values()) s.then((x) => x.close(), () => undefined);
      lighterSigners.clear();
    },
  };
  return store;
}

function infoOf(r: SealedRecord): KeyInfo & { kind: KeyKind } {
  return { ref: r.ref, venue: r.venue, publicPart: r.publicPart, createdAt: r.createdAt, kind: r.kind, ...(r.tags ? { tags: { ...r.tags } } : {}) };
}

/** In-memory backend (memoryKeyStore). Records are deep-copied so callers never hold the live array. */
export function memoryBackend(): RecordBackend {
  let recs: SealedRecord[] = [];
  return {
    async load() {
      return structuredClone(recs);
    },
    async save(r) {
      recs = structuredClone(r);
    },
  };
}
