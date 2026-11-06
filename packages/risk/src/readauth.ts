// Owner-signed reads (SIG-1): GET /v1/positions and the private parts of GET /v1/risk need the 01 capstanMessage with
// purpose 'read', signed by the owner named in the query, at most 5 minutes valid, nonce not replayed. The body hash
// binds the exact request: `<METHOD> <path>?<query>` as sent. Headers: x-capstan-message (base64 of the message text)
// and x-capstan-signature.
import { verifyCapstanMessage, type NonceStore, type VerifyFailure } from "@capstan/core";
import type { Hex } from "@capstan/schema";

export const READ_MESSAGE_HEADER = "x-capstan-message";
export const READ_SIGNATURE_HEADER = "x-capstan-signature";

export const readRequestBody = (method: string, pathWithQuery: string) => `${method.toUpperCase()} ${pathWithQuery}`;

export function encodeReadMessage(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

export async function verifyOwnerRead(
  headers: { get(name: string): string | null | undefined },
  expect: { owner: Hex; method: string; pathWithQuery: string; host: string; nowMs: number },
  nonces: NonceStore,
): Promise<{ ok: true } | { ok: false; reason: VerifyFailure | "missing" }> {
  const b64 = headers.get(READ_MESSAGE_HEADER);
  const sig = headers.get(READ_SIGNATURE_HEADER);
  if (!b64 || !sig) return { ok: false, reason: "missing" };
  let text: string;
  try {
    text = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return { ok: false, reason: "format" };
  }
  const r = await verifyCapstanMessage(text, sig as Hex, { purpose: "read", signers: [expect.owner], host: expect.host, nowMs: expect.nowMs, body: readRequestBody(expect.method, expect.pathWithQuery) }, nonces);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}
