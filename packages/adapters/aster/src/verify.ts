// verifySigned (spec 2 adapter rules, C3): the envelope's signed string must be exactly the query string of the
// build, and its signature must recover to the build's signer. Any changed, reordered, added or missing parameter is
// refused with the field named. The relay never forwards an unmatched payload.
import type { SignedEnvelope, UnsignedVenuePayload, VerifyResult } from "@capstan/schema";
import { digestTrade, parseQuery, payloadHashOf, queryString, recoverDigestSigner } from "@capstan/signer-aster";
import type { AsterOrderPayload } from "./orders";

/** The first field where the sent query differs from the built one, or null when equal. */
export function firstDifference(sent: string, built: string): string | null {
  if (sent === built) return null;
  let a: [string, string][];
  try {
    a = parseQuery(sent);
  } catch {
    return "signedBody";
  }
  const b = parseQuery(built);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!x) return y![0]; // missing
    if (!y) return x[0]; // added
    if (x[0] !== y[0]) return b.some(([k]) => k === x[0]) ? y[0] : x[0]; // reordered -> expected key; added -> new key
    if (x[1] !== y[1]) return x[0]; // changed value
  }
  return "signedBody"; // same pairs, different text (encoding, separators)
}

export function verifyAsterSigned(env: SignedEnvelope, build: UnsignedVenuePayload, nowMs = Date.now()): VerifyResult {
  if (env.venue !== "aster" || build.venue !== "aster") return { ok: false, code: "PAYLOAD_MISMATCH", field: "venue" };
  if (env.encoding !== "aster_v3_params" || build.encoding !== "aster_v3_params") return { ok: false, code: "PAYLOAD_MISMATCH", field: "encoding" };
  if (env.buildId !== build.buildId) return { ok: false, code: "PAYLOAD_MISMATCH", field: "buildId" };
  if (nowMs > build.expiresAt) return { ok: false, code: "BUILD_EXPIRED" };
  const p = build.payload as AsterOrderPayload;
  if (typeof env.signedBody !== "string") return { ok: false, code: "PAYLOAD_MISMATCH", field: "signedBody" };
  const built = queryString(p.params);
  const diff = firstDifference(env.signedBody, built);
  if (diff) return { ok: false, code: "PAYLOAD_MISMATCH", field: diff };
  const digest = digestTrade(built, p.chainId);
  if (digest !== build.digest) return { ok: false, code: "PAYLOAD_MISMATCH", field: "digest" };
  if (env.payloadHash !== payloadHashOf(built)) return { ok: false, code: "PAYLOAD_MISMATCH", field: "payloadHash" };
  if (String(env.signerRef).toLowerCase() !== p.signer.toLowerCase()) return { ok: false, code: "BAD_SIGNATURE", field: "signerRef" };
  const who = recoverDigestSigner(digest, String(env.signature));
  if (!who || who.toLowerCase() !== p.signer.toLowerCase()) return { ok: false, code: "BAD_SIGNATURE", field: "signature" };
  return { ok: true };
}
