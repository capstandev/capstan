// VPS-only testnet helpers. This Mac never runs them (Aster's terms list Canada; README rule 8): every test that uses
// them skips unless CAPSTAN_RUNNER=vps and ASTER_TESTNET_KEYSTORE are set. The main wallet signs through Foundry cast
// from an encrypted keystore with a password file, so this process never sees the key.
import type { Hex } from "@capstan/schema";
import { queryString, type DigestSigner, type Param } from "@capstan/signer-aster";
import { createMemoryGovernor, type VenueHttp } from "@capstan/venue-client";
import { homedir } from "node:os";
import { join } from "node:path";
import { ASTER_TESTNET, validateAsterConfig } from "../../src/config";
import { asterHttp } from "../../src/read";

export const VPS = process.env.CAPSTAN_RUNNER === "vps" && !!process.env.ASTER_TESTNET_KEYSTORE;
export const SKIP_REASON = "VPS only: needs CAPSTAN_RUNNER=vps and ASTER_TESTNET_KEYSTORE (BACKLOG A4)";
const CAST = join(homedir(), ".foundry/bin/cast");

/** Refuses to run against anything but the Aster testnet host with chain ids 714 and 56. */
export function testnetOnly(): { http: VenueHttp } {
  validateAsterConfig(ASTER_TESTNET);
  if (ASTER_TESTNET.rest !== "https://fapi.asterdex-testnet.com" || ASTER_TESTNET.tradeChainId !== 714 || ASTER_TESTNET.mgmtChainId !== 56) throw new Error("not the Aster testnet");
  return { http: asterHttp(ASTER_TESTNET, createMemoryGovernor(process.env.RELAY_EGRESS_IP ?? "vps")) };
}

function keystoreArgs(): string[] {
  const ks = process.env.ASTER_TESTNET_KEYSTORE!;
  const pw = process.env.ASTER_TESTNET_PASSWORD_FILE;
  if (!pw) throw new Error("ASTER_TESTNET_PASSWORD_FILE must point at the keystore password file");
  return ["--keystore", ks, "--password-file", pw];
}

export function castAddress(): Hex {
  const r = Bun.spawnSync([CAST, "wallet", "address", ...keystoreArgs()]);
  if (r.exitCode !== 0) throw new Error("cast wallet address failed");
  return r.stdout.toString().trim() as Hex;
}

/** Signs a raw digest with the keystore wallet (cast --no-hash). */
export const castSigner: DigestSigner = async (digest) => {
  const r = Bun.spawnSync([CAST, "wallet", "sign", "--no-hash", ...keystoreArgs(), digest]);
  if (r.exitCode !== 0) throw new Error("cast wallet sign failed");
  return r.stdout.toString().trim() as Hex;
};

export async function serverTimeMs(http: VenueHttp): Promise<number> {
  return (await http.getJson<{ serverTime: number }>("/fapi/v3/time")).serverTime;
}

/** Mode B signed GET (user data): params, then the signature, as one exact query string. */
export async function signedGet(http: VenueHttp, path: string, params: Param[], sign: DigestSigner, digest: (qs: string) => Hex): Promise<{ status: number; body: unknown }> {
  const qs = queryString(params);
  const sig = await sign(digest(qs));
  const raw = await http.request("GET", `${path}?${qs}&signature=${sig}`, { cost: 5 });
  return { status: raw.httpStatus, body: raw.body };
}

export async function record(name: string, data: unknown): Promise<void> {
  const dir = process.env.CAPSTAN_VPS_REPORT_DIR;
  console.log(`[aster-vps] ${name}: ${JSON.stringify(data)}`);
  if (dir) await Bun.write(join(dir, `aster-${name}.json`), JSON.stringify({ at: new Date().toISOString(), data }, null, 2));
}
