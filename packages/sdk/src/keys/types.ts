// KeyStore: where the delegated trade-only key lives on the user's side (spec 4.1 step 1). The interface never
// exposes raw key bytes: callers create a key, ask it to sign, and wipe it. Agent TEEs may supply their own store.
import type { Hex, VenueId } from "@capstan/schema";
import type { LighterApproveIntegratorArgs, LighterCancelArgs, LighterChainId, LighterChangePubKeyArgs, LighterOrderArgs, LighterSigner } from "@capstan/signer-lighter-wasm";

export type KeyKind = "secp256k1" | "lighter";

export interface KeyInfo {
  ref: string;
  venue: VenueId;
  publicPart: string; // secp256k1: the agent address; lighter: 0x + 40-byte public key
  createdAt: number;
  kind?: KeyKind;
  tags?: Record<string, string>;
}

/** What a Lighter key can be asked to sign. Every request names its signing chain id explicitly. */
export type LighterSignRequest =
  | { op: "createOrder"; chainId: LighterChainId; args: LighterOrderArgs }
  | { op: "cancelOrder"; chainId: LighterChainId; args: LighterCancelArgs }
  | { op: "changePubKey"; chainId: LighterChainId; args: LighterChangePubKeyArgs }
  | { op: "approveIntegrator"; chainId: LighterChainId; args: LighterApproveIntegratorArgs };

export type LighterSignResult = { txType: number; txInfo: string; txHash?: string; messageToSign?: string };

export interface KeyStore {
  create(venue: VenueId, kind: "secp256k1" | "lighter"): Promise<{ ref: string; publicPart: string }>;
  /** secp256k1: a 32-byte digest (0x hex) in, a 65-byte r||s||v signature out. lighter: a LighterSignRequest in. */
  sign(ref: string, digestOrArgs: unknown): Promise<unknown>;
  wipe(ref: string): Promise<void>;
  list(): Promise<{ ref: string; venue: VenueId; publicPart: string; createdAt: number }[]>;
  /** Every public part this store ever made, wiped ones included (no agent address is ever reused). Optional. */
  usedPublicParts?(): Promise<string[]>;
  /** Attach public labels (agentRef, owner, account index). Optional; never holds secrets. */
  tag?(ref: string, tags: Record<string, string>): Promise<void>;
  /** Stop any Worker the store started (the Lighter signer). Optional. */
  close?(): void;
}

/** Lazily starts the Lighter WASM signer for one signing chain id (only when a Lighter route is used). */
export type LighterSignerFactory = (chainId: LighterChainId) => Promise<Pick<LighterSigner, "generateApiKey" | "exportEncrypted" | "importEncrypted" | "signCreateOrder" | "signCancelOrder" | "signChangePubKey" | "signApproveIntegrator" | "close">>;

export interface KeyStoreOptions {
  /** Randomness for key generation. Default crypto.getRandomValues. Tests pass a recorder. */
  random?: (n: number) => Uint8Array;
  /** Lighter signer factory. Default: the pinned WASM build, loaded on first use. */
  lighter?: LighterSignerFactory;
  clock?: () => number;
}

export const isHex32 = (x: unknown): x is Hex => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
