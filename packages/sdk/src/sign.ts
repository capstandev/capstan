// Turning a CHECKED build into a signed envelope with the local key. The digest signed is the one checkBuild computed,
// never the server's. Lighter: the WASM signer recomputes the tx hash at sign time and it must equal the build digest.
import type { Hex, SignedEnvelope, UnsignedVenuePayload } from "@capstan/schema";
import { payloadHashOf, queryString, type Param } from "@capstan/signer-aster";
import { sigToHl, type HlL1Action } from "@capstan/signer-hl";
import type { LighterChainId } from "@capstan/signer-lighter-wasm";
import { sha256Jcs } from "./bytes";
import { SdkError } from "./errors";
import type { KeyStore, LighterSignResult } from "./keys/types";

export interface SignContext {
  keystore: KeyStore;
  keyRef: string;
  /** The local key's public part (agent address, or the Lighter account:key reference). */
  signerRef: string;
  /** The digest checkBuild computed. */
  digest: Hex;
  lighterChainId?: LighterChainId;
}

const isSig = (x: unknown): x is Hex => typeof x === "string" && /^0x[0-9a-fA-F]{130}$/.test(x);

export async function signEnvelope(b: UnsignedVenuePayload, c: SignContext): Promise<SignedEnvelope> {
  if (b.digest.toLowerCase() !== c.digest.toLowerCase()) throw new SdkError("PAYLOAD_MISMATCH", "the build digest is not the checked digest", { field: "digest" });
  if (b.encoding === "hl_l1_action") {
    const p = b.payload as { action: HlL1Action; nonce: number; vaultAddress: null; expiresAfter: number };
    const sig = await c.keystore.sign(c.keyRef, c.digest);
    if (!isSig(sig)) throw new SdkError("INVALID_INPUT", "the key store returned no signature");
    const body = { action: p.action, nonce: p.nonce, signature: sigToHl(sig), vaultAddress: null, expiresAfter: p.expiresAfter };
    return { buildId: b.buildId, venue: b.venue, encoding: b.encoding, signedBody: body, signature: sig, signerRef: c.signerRef, payloadHash: sha256Jcs(body) };
  }
  if (b.encoding === "aster_v3_params") {
    const p = b.payload as { params: Param[] };
    const query = queryString(p.params);
    const sig = await c.keystore.sign(c.keyRef, c.digest);
    if (!isSig(sig)) throw new SdkError("INVALID_INPUT", "the key store returned no signature");
    return { buildId: b.buildId, venue: b.venue, encoding: b.encoding, signedBody: query, signature: sig, signerRef: c.signerRef, payloadHash: payloadHashOf(query) };
  }
  if (b.encoding === "lighter_tx") {
    if (!c.lighterChainId) throw new SdkError("INVALID_INPUT", "a Lighter signature needs its signing chain id");
    const p = b.payload as { txType: 14 | 15; args: Record<string, unknown> };
    const op = p.txType === 14 ? "createOrder" : p.txType === 15 ? "cancelOrder" : null;
    if (!op) throw new SdkError("UNSUPPORTED", "only order and cancel transactions are signed here", { field: "txType" });
    const r = (await c.keystore.sign(c.keyRef, { op, chainId: c.lighterChainId, args: p.args })) as LighterSignResult;
    const hash = `0x${String(r.txHash ?? "").replace(/^0x/i, "")}`.toLowerCase();
    if (hash !== c.digest.toLowerCase()) throw new SdkError("PAYLOAD_MISMATCH", "the local signer's tx hash differs from the build digest", { field: "digest" });
    let sigField = "";
    try {
      sigField = String((JSON.parse(r.txInfo) as { Sig?: unknown }).Sig ?? "");
    } catch {
      throw new SdkError("INVALID_INPUT", "the signer returned unreadable tx info");
    }
    return { buildId: b.buildId, venue: b.venue, encoding: b.encoding, signedBody: { txType: r.txType, txInfo: r.txInfo }, signature: sigField, signerRef: c.signerRef, payloadHash: hash as Hex };
  }
  throw new SdkError("UNSUPPORTED", "unknown encoding", { field: "encoding" });
}
