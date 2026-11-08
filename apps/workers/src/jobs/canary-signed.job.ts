// Signed canary (hourly, TESTNETS ONLY, todo 41 R9): per venue with a funded testnet wallet, one tiny resting order far
// from the book and its cancel. It refuses unless CAPSTAN_NETWORK=testnet, and each probe asserts the testnet host and
// network before anything is signed. Signing goes through Foundry cast with an encrypted keystore and a password file
// (`cast wallet sign --no-hash`), so this process never holds the key.
//   hyperliquid: HL_TESTNET_KEYSTORE + HL_TESTNET_PASSWORD_FILE (the testnet main wallet signs its own L1 actions)
//   lighter    : skipped until the testnet run is wired (BACKLOG A3: account and API key on signing id 300)
//   aster      : VPS only (CAPSTAN_RUNNER=vps, BACKLOG A4); this job reports it skipped elsewhere
// A failed probe publishes `canary.signed_failed` on the ops alert channel (alerts only notify).
import { buildCancel, buildOrder, createHlReader, HL_TESTNET, NonceSource, payloadHash, submit } from "@capstan/adapter-hyperliquid";
import { memoryMarketDataCache, type JobDef, type JobDeps } from "@capstan/core";
import type { Hex, SignedEnvelope, SubmitResult } from "@capstan/schema";
import { createMemoryGovernor, venueHttp, type VenueHttp } from "@capstan/venue-client";
import { homedir } from "node:os";
import { join } from "node:path";

export const OPS_ALERT_CHANNEL = "ops.alert";
export const HL_TESTNET_HOST = "api.hyperliquid-testnet.xyz";

export interface SignedResult {
  venue: "hyperliquid" | "lighter" | "aster";
  status: "ok" | "failed" | "skipped";
  detail: string;
  orderId?: string | null;
}

export type DigestSigner = (digest: Hex) => Promise<{ r: Hex; s: Hex; v: number }>;

/** cast wallet sign --no-hash over a keystore + password file; returns r, s, v. */
export function castDigestSigner(keystore: string, passwordFile: string, cast = join(homedir(), ".foundry/bin/cast")): DigestSigner {
  return async (digest) => {
    const p = Bun.spawn([cast, "wallet", "sign", "--no-hash", "--keystore", keystore, "--password-file", passwordFile, digest], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(p.stdout).text()).trim();
    if ((await p.exited) !== 0 || !/^0x[0-9a-fA-F]{130}$/.test(out)) throw new Error("cast wallet sign failed");
    const v = Number.parseInt(out.slice(130, 132), 16);
    return { r: `0x${out.slice(2, 66)}` as Hex, s: `0x${out.slice(66, 130)}` as Hex, v: v < 27 ? v + 27 : v };
  };
}

export function castAddress(keystore: string, passwordFile: string, cast = join(homedir(), ".foundry/bin/cast")): Hex {
  const r = Bun.spawnSync([cast, "wallet", "address", "--keystore", keystore, "--password-file", passwordFile], { stderr: "ignore" });
  const a = r.stdout.toString().trim();
  if (r.exitCode !== 0 || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("cast wallet address failed");
  return a.toLowerCase() as Hex;
}

export function assertHlTestnetConfig(cfg: { network: string; infoUrl: string; exchangeUrl: string }): void {
  if (cfg.network !== "Testnet") throw new Error(`refusing: hyperliquidChain ${cfg.network} is not Testnet`);
  for (const u of [cfg.infoUrl, cfg.exchangeUrl]) if (new URL(u).host !== HL_TESTNET_HOST) throw new Error(`refusing: ${u} is not the Hyperliquid testnet host`);
}

/**
 * HL testnet probe: a BTC buy at half the mid (ALO, so it rests and never fills), then a cancel by client id. Both
 * must be accepted. Inputs are injected for tests; production builds them from the env.
 */
export async function hlSignedProbe(o: { owner: Hex; sign: DigestSigner; http?: VenueHttp; cfg?: typeof HL_TESTNET; now?: () => number }): Promise<SignedResult> {
  const base = o.cfg ?? HL_TESTNET;
  assertHlTestnetConfig(base);
  const cfg = { ...base, builderAddress: null };
  const http = o.http ?? venueHttp("hyperliquid-testnet", new URL(base.infoUrl).origin, createMemoryGovernor("canary-signed"));
  const cache = memoryMarketDataCache();
  const reader = createHlReader(cfg, http, cache);
  const now = o.now ?? Date.now;
  const book = await http.postJson<{ levels: { px: string }[][] }>("/info", { type: "l2Book", coin: "BTC" }, 2);
  const bid = Number(book.levels?.[0]?.[0]?.px ?? 0);
  if (!(bid > 0)) return { venue: "hyperliquid", status: "failed", detail: "no BTC bid on the testnet book" };
  const px = String(Math.floor(bid / 2));
  const cloid = `0x${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
  const ctx = { owner: o.owner, agentRef: `hl:${o.owner}`, identity: { venue: "hyperliquid" as const, owner: o.owner, agentAddress: o.owner }, builderFee: null, approvedMaxBps: null, nowMs: now(), eligibilityDecisionId: "canary", policyId: null };
  const deps = { cfg, reader, cache, nonces: new NonceSource(), enabled: () => true };
  const send = async (b: Awaited<ReturnType<typeof buildOrder>>): Promise<SubmitResult> => {
    const sig = await o.sign(b.digest);
    const body = { action: b.payload.action, nonce: b.payload.nonce, signature: sig, vaultAddress: null, expiresAfter: b.payload.expiresAfter };
    const env: SignedEnvelope = { buildId: b.buildId, venue: "hyperliquid", encoding: "hl_l1_action", signedBody: body, signature: "0x", signerRef: o.owner, payloadHash: payloadHash(body) };
    return submit(env, http);
  };
  const order = await buildOrder({ marketId: "hyperliquid:-:BTC", side: "buy", size: "0.0002", type: "limit", limitPx: px, tif: "alo", reduceOnly: false, clientOrderId: cloid, maxSlippageBps: 100 }, ctx, deps);
  const placed = await send(order);
  if (placed.status !== "accepted") return { venue: "hyperliquid", status: "failed", detail: `order ${placed.status}: ${placed.code ?? ""} ${placed.message ?? ""}`.trim() };
  const cancel = await buildCancel({ marketId: "hyperliquid:-:BTC", clientOrderId: cloid }, { ...ctx, nowMs: now() }, deps);
  const cancelled = await send(cancel);
  if (cancelled.status !== "accepted") return { venue: "hyperliquid", status: "failed", detail: `cancel ${cancelled.status}: ${cancelled.code ?? ""} ${cancelled.message ?? ""}`.trim(), orderId: placed.venueOrderId };
  return { venue: "hyperliquid", status: "ok", detail: `order at ${px} placed and cancelled`, orderId: placed.venueOrderId };
}

export interface SignedCanaryOptions {
  env?: Record<string, string | undefined>;
  hl?: () => Promise<SignedResult>;
}

export async function runSignedCanary(deps: Pick<JobDeps, "log" | "publish">, o: SignedCanaryOptions = {}): Promise<SignedResult[]> {
  const env = o.env ?? process.env;
  if (env.CAPSTAN_NETWORK !== "testnet") {
    deps.log.info("signed canary refused: CAPSTAN_NETWORK is not testnet", {});
    return [{ venue: "hyperliquid", status: "skipped", detail: "refused: not testnet" }];
  }
  const out: SignedResult[] = [];
  if (o.hl || (env.HL_TESTNET_KEYSTORE && env.HL_TESTNET_PASSWORD_FILE)) {
    try {
      const run = o.hl ?? (() => hlSignedProbe({ owner: castAddress(env.HL_TESTNET_KEYSTORE!, env.HL_TESTNET_PASSWORD_FILE!), sign: castDigestSigner(env.HL_TESTNET_KEYSTORE!, env.HL_TESTNET_PASSWORD_FILE!) }));
      out.push(await run());
    } catch (e) {
      out.push({ venue: "hyperliquid", status: "failed", detail: (e as Error).message });
    }
  } else out.push({ venue: "hyperliquid", status: "skipped", detail: "no funded testnet wallet (BACKLOG A2)" });
  out.push({ venue: "lighter", status: "skipped", detail: "testnet order path not wired yet (BACKLOG A3)" });
  out.push({ venue: "aster", status: "skipped", detail: env.CAPSTAN_RUNNER === "vps" ? "run the VPS suite: packages/adapters/aster/test/vps (BACKLOG A4)" : "VPS only (BACKLOG A4, D1)" });
  for (const r of out.filter((x) => x.status === "failed")) {
    const alert = { kind: "canary.signed_failed", detail: { venue: r.venue, error: r.detail } };
    if (deps.publish) await deps.publish(OPS_ALERT_CHANNEL, alert);
    else deps.log.warn("ops alert", alert);
  }
  deps.log.info("signed canary", { results: out.map((r) => `${r.venue}:${r.status}`) });
  return out;
}

export const job: JobDef = {
  name: "canary-signed",
  queue: "alertsDispatch",
  schedule: { pattern: "7 * * * *" },
  concurrency: 1,
  handler: (_job, deps) => runSignedCanary(deps),
};
