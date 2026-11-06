// The Capstan EIP-191 text format (the API's one signed-message shape: kills, reads, API requests). Same eight lines
// as the server's verifier; a parity test keeps the two equal.
import type { Hex } from "@capstan/schema";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

export type SignedPurpose = "api_request" | "read" | "ws_subscribe" | "kill" | "spread_ack" | "api_key_create" | "webhook_register";

export interface CapstanMessageFields {
  purpose: SignedPurpose;
  owner: Hex;
  host: string;
  chainId: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  body?: string;
}

export function bodyHash(body: string | undefined): string {
  return body === undefined || body === "" ? "-" : bytesToHex(sha256(new TextEncoder().encode(body)));
}

export function capstanMessage(m: CapstanMessageFields): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(m.owner)) throw new Error("owner must be an address");
  if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(m.host)) throw new Error("host must be a lowercase host name");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(m.nonce)) throw new Error("nonce must be 8 to 80 url-safe characters");
  return [
    `Capstan ${m.purpose}`,
    `owner: ${m.owner.toLowerCase()}`,
    `host: ${m.host}`,
    `chain: ${m.chainId}`,
    `nonce: ${m.nonce}`,
    `issued: ${new Date(m.issuedAt).toISOString()}`,
    `expires: ${new Date(m.expiresAt).toISOString()}`,
    `body: ${bodyHash(m.body)}`,
  ].join("\n");
}
