// Gateway test helpers: label-derived test keys, owner_sig headers (the 01 capstanMessage, purpose api_request) and a
// small app with the real verifiers. Keys here are public test labels, never real.
import { capstanMessage, memoryNonceStore, type RouteSpec } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashMessage } from "viem";
import { addressOfSecret, signDigestRsv } from "../../../packages/sdk/src/keys/secp";
import { createApp, type CreateAppOptions } from "../src/app";
import { apiRequestBody, MESSAGE_HEADER, SIGNATURE_HEADER } from "../src/auth";

export const HOST = "api.capstan.test";
// in the past on purpose: receipt ids are ULIDs from this clock, and a future time would move the shared ulid order
export const T = Date.parse("2026-05-01T12:00:00.000Z");
export const gwKey = (l: string) => keccak_256(utf8ToBytes(`capstan-gateway-test:${l}`)); // test-key
export const addr = (sk: Uint8Array) => addressOfSecret(sk).toLowerCase() as Hex;

let n = 0;
/** Headers for an api_request signature over method, path with query and the raw body. */
export function signed(sk: Uint8Array, o: { method: string; path: string; body?: string; owner?: Hex; ts?: number; nonce?: string; host?: string; ttlMs?: number; purpose?: "api_request" | "read" }): Record<string, string> {
  const ts = o.ts ?? T;
  const owner = o.owner ?? addr(sk);
  const body = o.purpose === "read" ? `${o.method} ${o.path}` : apiRequestBody(o.method, o.path, o.body ?? "");
  const text = capstanMessage({ purpose: o.purpose ?? "api_request", owner, host: o.host ?? HOST, chainId: 4663, nonce: o.nonce ?? `gw-nonce-${++n}-${ts}`, issuedAt: ts, expiresAt: ts + (o.ttlMs ?? 60_000), body });
  return { [MESSAGE_HEADER]: Buffer.from(text, "utf8").toString("base64"), [SIGNATURE_HEADER]: signDigestRsv(hashMessage(text), sk) };
}

export async function smallApp(routes: RouteSpec[], o: Omit<CreateAppOptions, "routesDir" | "extraRoutes"> = {}) {
  return createApp({ routesDir: mkdtempSync(join(tmpdir(), "capstan-gw-")), extraRoutes: routes, edge: () => async (c, next) => { (c as unknown as { set(k: string, v: unknown): void }).set("eligibilityDecisionId", "elig-gw"); await next(); }, ...o });
}

export { memoryNonceStore };
