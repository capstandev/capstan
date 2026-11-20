// Fills the files of the one mainnet go change from the deployment record the owner's deploy wrote. Offline: reads
// and writes files only; never signs, never sends, never opens a network connection, never commits.
// Usage: bun ops/mainnet/fill-go-commit.ts <4663.json> [repoRoot]   (the wrapper is fill-go-commit.sh)
// What it writes (the full list of go-day files; nothing else in the tree waits for the deploy):
//   1. contracts/deployments/4663.json                       the record itself, byte for byte
//   2. packages/schema/src/generated/deployments.ts          generated copy
//   3. web/public/contracts.json                             generated copy (the CPST address box on the site)
//   4. README.md and SECURITY.md                             the tables between the deployment markers
//   5. packages/sdk/src/pins.json                            networks.mainnet.anchor.address = CapstanReceiptAnchor
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deploymentDrift, validateDeployment, type Deployment } from "../ci/deployments";
import { generateDeployments } from "../ci/gen-deployments";
import { parseEnv } from "./env-review";

export const MAINNET_CHAIN_ID = 4663;
export const GO_RECORD = `contracts/deployments/${MAINNET_CHAIN_ID}.json`;
export const PINS_FILE = "packages/sdk/src/pins.json";
const NAMES = ["CapstanReceiptAnchor", "CPSTLock", "CPST"] as const;
const lc = (s: string): string => s.toLowerCase();

/** Every reason the record must not go in. `root` supplies the inputs (poster, brand Safe) and the other chains. */
export function goRecordProblems(d: Deployment, root: string, opts: { allowUnverified?: boolean } = {}): string[] {
  const errs = validateDeployment(`${MAINNET_CHAIN_ID}.json`, d);
  if (errs.length) return errs;
  if (d.chainId !== MAINNET_CHAIN_ID) errs.push(`chainId is ${d.chainId}, not ${MAINNET_CHAIN_ID}`);
  for (const n of NAMES) if (!d.contracts[n]) errs.push(`${n} is missing`);
  if (errs.length) return errs;
  const addrs = NAMES.map((n) => lc(d.contracts[n]!.address));
  if (new Set(addrs).size !== NAMES.length) errs.push("two contracts share one address");
  if (addrs.some((a) => /^0x0{40}$/.test(a))) errs.push("a contract address is the zero address");
  if (!d.sourcify.verified && !opts.allowUnverified) errs.push("sourcify.verified is false (run the deploy script again to retry Sourcify, or pass --allow-unverified)");
  const inputs = parseEnv(readFileSync(join(root, "ops/mainnet/inputs.conf"), "utf8"));
  const poster = inputs.get("POSTER_ADDRESS") ?? "";
  const got = d.contracts.CapstanReceiptAnchor!.poster;
  if (!got) errs.push("CapstanReceiptAnchor.poster is missing");
  else if (lc(got) !== lc(poster)) errs.push(`anchor poster ${got} is not POSTER_ADDRESS ${poster} of ops/mainnet/inputs.conf`);
  // an address that is also a known wallet, or an address of another chain's record, is a copy mistake
  const known = new Map<string, string>();
  for (const [k, v] of inputs) if (/^0x[0-9a-fA-F]{40}$/.test(v)) known.set(lc(v), `inputs.conf ${k}`);
  for (const other of ["46630"]) {
    const p = join(root, `contracts/deployments/${other}.json`);
    if (!existsSync(p)) continue;
    const o = JSON.parse(readFileSync(p, "utf8")) as Deployment;
    for (const [n, c] of Object.entries(o.contracts)) known.set(lc(c!.address), `${other}.json ${n}`);
  }
  NAMES.forEach((n, i) => {
    const hit = known.get(addrs[i]!);
    if (hit) errs.push(`${n} ${d.contracts[n]!.address} equals ${hit}`);
  });
  return errs;
}

/** Sets networks.mainnet.anchor.address in the pins text and nothing else. Throws when the block is not found once. */
export function pinMainnetAnchor(pinsText: string, anchor: string): string {
  const re = new RegExp(`("anchor": \\{\\s*"chainId": ${MAINNET_CHAIN_ID},\\s*"address": )(null|"0x[0-9a-fA-F]{40}")`, "g");
  const hits = pinsText.match(re)?.length ?? 0;
  if (hits !== 1) throw new Error(`${PINS_FILE}: expected one mainnet anchor block, found ${hits}`);
  const next = pinsText.replace(re, `$1"${anchor}"`);
  const parsed = JSON.parse(next) as { networks: { mainnet: { anchor: { chainId: number; address: string } } } };
  if (parsed.networks.mainnet.anchor.address !== anchor) throw new Error(`${PINS_FILE}: the mainnet anchor was not set`);
  return next;
}

/** Writes the go files under root and returns the changed paths. Throws with every problem when the record is bad. */
export function fillGoCommit(recordPath: string, root: string, opts: { allowUnverified?: boolean } = {}): string[] {
  const text = readFileSync(recordPath, "utf8");
  const d = JSON.parse(text) as Deployment;
  const errs = goRecordProblems(d, root, opts);
  if (errs.length) throw new Error(errs.map((e) => `refuse: ${e}`).join("\n"));
  const watched = [GO_RECORD, "packages/schema/src/generated/deployments.ts", "web/public/contracts.json", "README.md", "SECURITY.md", PINS_FILE];
  const before = watched.map((f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : null));
  if (resolve(recordPath) !== resolve(join(root, GO_RECORD))) writeFileSync(join(root, GO_RECORD), text);
  generateDeployments(root);
  const pins = join(root, PINS_FILE);
  writeFileSync(pins, pinMainnetAnchor(readFileSync(pins, "utf8"), d.contracts.CapstanReceiptAnchor!.address));
  const drift = deploymentDrift(root);
  if (drift.length) throw new Error(drift.map((e) => `drift: ${e}`).join("\n"));
  return watched.filter((f, i) => existsSync(join(root, f)) && readFileSync(join(root, f), "utf8") !== before[i]);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const allowUnverified = args.includes("--allow-unverified");
  const [record, rootArg] = args.filter((a) => !a.startsWith("--"));
  if (!record || !existsSync(record)) {
    console.error("usage: fill-go-commit.sh <path to the deploy's 4663.json> [repoRoot] [--allow-unverified]");
    process.exit(2);
  }
  const root = resolve(rootArg ?? join(import.meta.dir, "../.."));
  try {
    const changed = fillGoCommit(record, root, { allowUnverified });
    for (const f of changed) console.log(`wrote ${f}`);
    console.log(`fill-go-commit: ${changed.length} files written under ${root}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
