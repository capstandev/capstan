// The deployment file is the source of truth for our own contract addresses: contracts/deployments/<chainId>.json.
// gen-deployments.ts writes the copies (generated TS module, README and SECURITY.md tables between markers);
// check-deployments.ts fails when a copy differs or a file is malformed.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEPLOYMENTS_DIR = "contracts/deployments";
export const GENERATED_TS = "packages/schema/src/generated/deployments.ts";
export const TABLE_FILES = ["README.md", "SECURITY.md"] as const;
/** Token-address box data for the web app (todo 38 renders it; hidden while `cpst` is empty). */
export const WEB_JSON = "web/public/contracts.json";
export const START = "<!-- deployments:start -->";
export const END = "<!-- deployments:end -->";
const CONTRACT_NAMES = ["CapstanReceiptAnchor", "CPSTLock", "CPST"] as const;

export interface DeploymentContract {
  address: string;
  txHash?: string;
  block?: number;
  poster?: string;
  symbol?: string;
  decimals?: number;
  supply?: string;
}
export interface Deployment {
  chainId: number;
  contracts: Partial<Record<(typeof CONTRACT_NAMES)[number], DeploymentContract>>;
  deployer: string;
  sourcify: { verified: boolean; url?: string };
  updatedAt: string;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TXH = /^0x[0-9a-fA-F]{64}$/;

export function validateDeployment(file: string, d: unknown): string[] {
  const errs: string[] = [];
  const x = d as Partial<Deployment> | null;
  if (!x || typeof x !== "object") return [`${file}: not an object`];
  if (!Number.isInteger(x.chainId) || (x.chainId as number) <= 0) errs.push(`${file}: chainId must be a positive integer`);
  if (file.endsWith(".json") && String(x.chainId) !== file.replace(/^.*\//, "").replace(/\.json$/, "")) errs.push(`${file}: file name must equal chainId`);
  if (typeof x.deployer !== "string" || !ADDR.test(x.deployer)) errs.push(`${file}: deployer must be an address`);
  if (!x.sourcify || typeof x.sourcify.verified !== "boolean") errs.push(`${file}: sourcify.verified must be a boolean`);
  if (typeof x.updatedAt !== "string" || Number.isNaN(Date.parse(x.updatedAt))) errs.push(`${file}: updatedAt must be an ISO time`);
  if (!x.contracts || typeof x.contracts !== "object") errs.push(`${file}: contracts must be an object`);
  else {
    for (const [name, c] of Object.entries(x.contracts)) {
      if (!CONTRACT_NAMES.includes(name as (typeof CONTRACT_NAMES)[number])) errs.push(`${file}: unknown contract ${name}`);
      const cc = c as DeploymentContract;
      if (!cc || !ADDR.test(cc.address ?? "")) errs.push(`${file}: ${name}.address must be an address`);
      if (cc?.txHash !== undefined && !TXH.test(cc.txHash)) errs.push(`${file}: ${name}.txHash must be a 32-byte hash`);
      if (cc?.poster !== undefined && !ADDR.test(cc.poster)) errs.push(`${file}: ${name}.poster must be an address`);
      if (cc?.block !== undefined && !Number.isInteger(cc.block)) errs.push(`${file}: ${name}.block must be an integer`);
      if (cc?.decimals !== undefined && !Number.isInteger(cc.decimals)) errs.push(`${file}: ${name}.decimals must be an integer`);
      if (name === "CPST" && cc) {
        // the token's fixed facts (todo 26): every copy (web, SDK) reads these generated values
        if (cc.symbol !== "CPST") errs.push(`${file}: CPST.symbol must be "CPST"`);
        if (cc.decimals !== 18) errs.push(`${file}: CPST.decimals must be 18`);
        if (cc.supply !== "1000000000") errs.push(`${file}: CPST.supply must be "1000000000" (whole tokens)`);
      }
    }
  }
  return errs;
}

export function loadDeployments(root: string): { deployments: Deployment[]; errors: string[] } {
  const dir = join(root, DEPLOYMENTS_DIR);
  const deployments: Deployment[] = [];
  const errors: string[] = [];
  if (!existsSync(dir)) return { deployments, errors };
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const rel = `${DEPLOYMENTS_DIR}/${f}`;
    let d: unknown;
    try {
      d = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      errors.push(`${rel}: not valid JSON`);
      continue;
    }
    const e = validateDeployment(rel, d);
    if (e.length) errors.push(...e);
    else deployments.push(d as Deployment);
  }
  deployments.sort((a, b) => a.chainId - b.chainId);
  return { deployments, errors };
}

const CHAIN_NAMES: Record<number, string> = { 4663: "Robinhood Chain", 46630: "Robinhood Chain testnet", 31337: "local" };

export function renderTable(deps: Deployment[]): string {
  const rows: string[] = [];
  for (const d of deps) {
    for (const name of CONTRACT_NAMES) {
      const c = d.contracts[name];
      if (!c) continue;
      const sourcify = d.sourcify.verified ? (d.sourcify.url ? `[verified](${d.sourcify.url})` : "verified") : "not yet";
      rows.push(`| ${CHAIN_NAMES[d.chainId] ?? "chain"} (\`${d.chainId}\`) | \`${name}\` | \`${c.address}\` | ${sourcify} |`);
    }
  }
  if (!rows.length) return "No contracts are deployed yet.";
  return ["| Chain | Contract | Address | Sourcify |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

export function renderTs(deps: Deployment[]): string {
  const head = readFileSync(join(import.meta.dir, "deployments.header.ts.txt"), "utf8");
  const body: Record<number, Deployment> = {};
  for (const d of deps) body[d.chainId] = d;
  return `${head}export const DEPLOYMENTS: Record<number, Deployment> = ${JSON.stringify(body, null, 2)};\n`;
}

/** web/public/contracts.json: CPST per chain plus the lock and anchor addresses; `cpst` is empty until deployed. */
export function renderWebJson(deps: Deployment[]): string {
  const cpst: Record<string, { address: string; symbol: string; decimals: number; supply: string; lock?: string; anchor?: string }> = {};
  for (const d of deps) {
    const c = d.contracts.CPST;
    if (!c) continue;
    cpst[String(d.chainId)] = {
      address: c.address,
      symbol: c.symbol ?? "CPST",
      decimals: c.decimals ?? 18,
      supply: c.supply ?? "1000000000",
      ...(d.contracts.CPSTLock ? { lock: d.contracts.CPSTLock.address } : {}),
      ...(d.contracts.CapstanReceiptAnchor ? { anchor: d.contracts.CapstanReceiptAnchor.address } : {}),
    };
  }
  return `${JSON.stringify({ generatedBy: "ops/ci/gen-deployments.ts", cpst }, null, 2)}\n`;
}

export function replaceBetweenMarkers(text: string, inner: string): string | null {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < 0 || b < a) return null;
  return `${text.slice(0, a + START.length)}\n${inner}\n${text.slice(b)}`;
}

/** Every copy that differs from what the JSON files produce. */
export function deploymentDrift(root: string): string[] {
  const { deployments, errors } = loadDeployments(root);
  const out = [...errors];
  const ts = join(root, GENERATED_TS);
  if (!existsSync(ts) || readFileSync(ts, "utf8") !== renderTs(deployments)) out.push(`${GENERATED_TS} differs from ${DEPLOYMENTS_DIR} (run bun ops/ci/gen-deployments.ts)`);
  const web = join(root, WEB_JSON);
  if (!existsSync(web) || readFileSync(web, "utf8") !== renderWebJson(deployments)) out.push(`${WEB_JSON} differs from ${DEPLOYMENTS_DIR} (run bun ops/ci/gen-deployments.ts)`);
  const table = renderTable(deployments);
  for (const f of TABLE_FILES) {
    const p = join(root, f);
    if (!existsSync(p)) {
      out.push(`${f}: missing`);
      continue;
    }
    const text = readFileSync(p, "utf8");
    const want = replaceBetweenMarkers(text, table);
    if (want === null) out.push(`${f}: no ${START} ... ${END} markers`);
    else if (want !== text) out.push(`${f}: deployment table differs from ${DEPLOYMENTS_DIR} (run bun ops/ci/gen-deployments.ts)`);
  }
  return out;
}
