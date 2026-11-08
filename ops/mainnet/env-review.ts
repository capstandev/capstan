// Mainnet env review (todo 47 R3, audit lessons S-2 and DEP-6). For every service: the server template
// (ops/server/etc/<svc>.env) with the mainnet overlay (ops/mainnet/env/<svc>.env) on top, the public mainnet inputs
// filled in, then:
//   - the diff against .env.example (keys the example does not list are named);
//   - flags that must be OFF at first deploy are absent or 0 everywhere;
//   - values that must match do: RELAY_EGRESS_IP = the VPS static IP, builder addresses = the SDK pins, x402 payTo =
//     the brand Safe (an input not known yet is "pending", which fails only with --strict);
//   - no security setting is empty, every chain id is a mainnet one (or the unused dev pair 31337), no testnet RPC;
//   - every merged value is printed with its sha (sha256 of "<svc>:<KEY>=<value>", first 12 hex) and each file's
//     git blob sha, so a reviewer signs off a value, not a file name.
// Inputs (env or --inputs FILE with KEY=value lines): MAINNET_VPS_IP, MAINNET_BRAND_SAFE, MAINNET_HL_BUILDER,
// MAINNET_ASTER_BUILDER. Usage: bun ops/mainnet/env-review.ts [--strict] [--quiet] [--inputs FILE]
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { args, ROOT } from "./lib";

export const OFF_AT_FIRST_DEPLOY = ["STAKER_BUCKET_ENABLED", "X402_USDG_EIP3009_MAINNET", "EQ_EXECUTION_ALLOWED", "LIGHTER_MAKER_ONLY", "HL_BUILDER_REVOKE_CONFIRMED"] as const;
/** Keys whose empty value is unsafe or ambiguous (DEP-6). */
export const SECURITY_KEY = /(_SIGNER|_KEYSTORE_PATH|_PASSWORD_FILE|_CHAIN_ID|_ARMED|_ARMED_FILE|_RPC_URL)$|^(CAPSTAN_NETWORK|CAPSTAN_TRUST_FORWARDED_FOR|RELAY_EGRESS_IP|RELAY_SUBMIT_ARMED|DATABASE_URL|REDIS_URL)$|^RATE_LIMIT_/;
const SERVER_FILLED = /@(DB_PASSWORD|API_HOST|SVC)@/g;
const MAINNET_CHAINS = new Set(["4663", "8453"]);

export type Env = Map<string, string>;
export interface Inputs {
  vpsIp?: string;
  brandSafe?: string;
  hlBuilder?: string;
  asterBuilder?: string;
}
export interface Pins {
  hyperliquid: string | null;
  aster: string | null;
}
export interface Finding {
  svc: string;
  key: string;
  kind: "fail" | "pending";
  why: string;
}

export function parseEnv(text: string): Env {
  const m: Env = new Map();
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    if (i <= 0) continue;
    m.set(l.slice(0, i).trim(), l.slice(i + 1).trim());
  }
  return m;
}

export function merge(template: Env, overlay: Env): Env {
  const m = new Map(template);
  for (const [k, v] of overlay) m.set(k, v);
  return m;
}

const lc = (s: string | undefined) => (s ?? "").toLowerCase();
const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

/** Fill the public inputs; a placeholder with no input stays as it is (pending). */
export function fill(env: Env, i: Inputs): Env {
  const map: Record<string, string | undefined> = { "@RELAY_EGRESS_IP@": i.vpsIp, "@BRAND_SAFE@": i.brandSafe, "@HL_BUILDER@": i.hlBuilder, "@ASTER_BUILDER@": i.asterBuilder };
  const out: Env = new Map();
  for (const [k, v] of env) out.set(k, map[v] !== undefined && map[v] !== "" ? map[v]! : v);
  return out;
}

const pending = (v: string | undefined) => v !== undefined && /^@[A-Z_]+@$/.test(v);

/** Every rule for one service's merged mainnet env. */
export function reviewService(svc: string, env: Env, inputs: Inputs, pins: Pins): Finding[] {
  const f: Finding[] = [];
  const add = (key: string, kind: Finding["kind"], why: string) => f.push({ svc, key, kind, why });
  // flags OFF at first deploy
  for (const k of OFF_AT_FIRST_DEPLOY) {
    const v = env.get(k);
    if (v !== undefined && v !== "0") add(k, "fail", `must be 0 at first deploy, is "${v}"`);
  }
  // mainnet profile
  if (env.get("CAPSTAN_NETWORK") !== "mainnet") add("CAPSTAN_NETWORK", "fail", `must be mainnet, is "${env.get("CAPSTAN_NETWORK") ?? ""}"`);
  for (const [k, v] of env) {
    const value = v.replace(SERVER_FILLED, "x");
    if (SECURITY_KEY.test(k) && value === "") add(k, "fail", "empty security setting");
    if (k.endsWith("_CHAIN_ID") && value !== "" && !MAINNET_CHAINS.has(value)) {
      const signer = env.get(`${k.slice(0, -"_CHAIN_ID".length)}_SIGNER`);
      if (!(value === "31337" && signer === "dev")) add(k, "fail", `chain ${value} is not a mainnet chain (4663, 8453)`);
    }
    if (k.endsWith("_SIGNER") && v === "dev") {
      const cid = env.get(`${k.slice(0, -"_SIGNER".length)}_CHAIN_ID`);
      if (cid !== "31337") add(k, "fail", `dev signer with chain ${cid ?? "unset"}`);
    }
    if (k.endsWith("_RPC_URL") && !/(TESTNET|SEPOLIA|DEVNET)/.test(k) && /testnet|sepolia|devnet/i.test(v)) add(k, "fail", `a testnet RPC in the mainnet env: ${v}`);
  }
  // must match
  if (env.has("RELAY_EGRESS_IP")) {
    const v = env.get("RELAY_EGRESS_IP")!;
    if (pending(v) || !inputs.vpsIp) add("RELAY_EGRESS_IP", "pending", "the VPS static IP is not known yet (BACKLOG D1)");
    else if (v !== inputs.vpsIp) add("RELAY_EGRESS_IP", "fail", `${v} is not the VPS IP ${inputs.vpsIp}`);
  }
  for (const [k, pin, item] of [["HL_BUILDER_ADDRESS", pins.hyperliquid, "E2"], ["ASTER_BUILDER_ADDRESS", pins.aster, "E2"]] as const) {
    if (!env.has(k)) continue;
    const v = env.get(k)!;
    if (pending(v) || v === "") {
      if (pin) add(k, "fail", `the SDK pins ${pin} but the env has none`);
      else add(k, "pending", `no builder yet (BACKLOG ${item}); the venue stays fee_free_unavailable`);
    } else if (!isAddr(v)) add(k, "fail", `not an address: ${v}`);
    else if (!pin) add(k, "fail", `${v} is set but the SDK release pins no builder`);
    else if (lc(v) !== lc(pin)) add(k, "fail", `${v} differs from the SDK pin ${pin}`);
  }
  for (const k of ["X402_PAY_TO_EVM", "X402_PAYTO_EVM"]) {
    if (!env.has(k)) continue;
    const v = env.get(k)!;
    if (pending(v) || v === "" || !inputs.brandSafe) add(k, "pending", "the brand Safe is not known yet (BACKLOG E1)");
    else if (lc(v) !== lc(inputs.brandSafe)) add(k, "fail", `${v} is not the brand Safe ${inputs.brandSafe}`);
  }
  return f;
}

export const valueSha = (svc: string, k: string, v: string) => createHash("sha256").update(`${svc}:${k}=${v}`).digest("hex").slice(0, 12);

function blobSha(p: string): string {
  if (!existsSync(p)) return "absent";
  const r = Bun.spawnSync(["git", "-C", ROOT, "hash-object", p]);
  return r.stdout.toString().trim().slice(0, 12) || "unknown";
}

export interface ReviewOptions {
  templates?: string;
  overlays?: string;
  example?: string;
  pinsFile?: string;
  inputs?: Inputs;
}

export function review(o: ReviewOptions = {}) {
  const templates = o.templates ?? join(ROOT, "ops/server/etc");
  const overlays = o.overlays ?? join(ROOT, "ops/mainnet/env");
  const example = parseEnv(readFileSync(o.example ?? join(ROOT, ".env.example"), "utf8"));
  const pinsRaw = JSON.parse(readFileSync(o.pinsFile ?? join(ROOT, "packages/sdk/src/pins.json"), "utf8")) as { networks: { mainnet: { builders: Pins } } };
  const pins = pinsRaw.networks.mainnet.builders;
  const inputs = o.inputs ?? {};
  const services = readdirSync(templates).filter((f) => f.endsWith(".env")).map((f) => basename(f, ".env")).sort();
  const findings: Finding[] = [];
  const lines: string[] = [];
  for (const svc of services) {
    const tp = join(templates, `${svc}.env`);
    const op = join(overlays, `${svc}.env`);
    if (!existsSync(op)) findings.push({ svc, key: "-", kind: "fail", why: `no mainnet overlay ${op}` });
    const env = fill(merge(parseEnv(readFileSync(tp, "utf8")), existsSync(op) ? parseEnv(readFileSync(op, "utf8")) : new Map()), inputs);
    findings.push(...reviewService(svc, env, inputs, pins));
    const notInExample = [...env.keys()].filter((k) => !example.has(k));
    lines.push(`== ${svc} (template ${blobSha(tp)}, overlay ${blobSha(op)})${notInExample.length ? `; not in .env.example: ${notInExample.join(", ")}` : ""}`);
    for (const [k, v] of [...env].sort(([a], [b]) => a.localeCompare(b))) lines.push(`  ${k}=${v}  sha ${valueSha(svc, k, v)}`);
  }
  return { findings, lines, services };
}

if (import.meta.main) {
  const a = args(process.argv.slice(2));
  const fileInputs = a.inputs ? Object.fromEntries(parseEnv(readFileSync(a.inputs, "utf8"))) : {};
  const get = (k: string) => (process.env[k] || fileInputs[k] || undefined) as string | undefined;
  const r = review({ inputs: { vpsIp: get("MAINNET_VPS_IP"), brandSafe: get("MAINNET_BRAND_SAFE"), hlBuilder: get("MAINNET_HL_BUILDER"), asterBuilder: get("MAINNET_ASTER_BUILDER") } });
  if (!a.quiet) console.log(r.lines.join("\n"));
  const fails = r.findings.filter((f) => f.kind === "fail");
  const pend = r.findings.filter((f) => f.kind === "pending");
  for (const f of fails) console.log(`FAIL ${f.svc} ${f.key}: ${f.why}`);
  for (const f of pend) console.log(`pending ${f.svc} ${f.key}: ${f.why}`);
  const strict = a.strict === "1";
  const ok = fails.length === 0 && (!strict || pend.length === 0);
  console.log(`env-review: ${ok ? "PASS" : "FAIL"} (${r.services.length} services, ${fails.length} failed, ${pend.length} pending${strict ? ", strict" : ""})`);
  process.exit(ok ? 0 : 1);
}
