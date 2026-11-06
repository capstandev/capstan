// Regenerates the computed parts of packages/sdk/src/pins.json: the Lighter onboarding template hashes (every step
// combination this release accepts, per venue and network) and the Aster template hash for each pinned builder.
// Hyperliquid hashes depend on the eligibility declaration shape, so they are added from real bundles:
//   bun packages/sdk/scripts/gen-pins.ts --hl-bundle <bundle.json> --network mainnet
// Check mode (CI and the pins test): bun packages/sdk/scripts/gen-pins.ts --check
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asterTemplateHash, hlTemplateHash, lighterTemplateHash } from "../src/onboard";

export const PINS_FILE = join(import.meta.dir, "../src/pins.json");
type Net = "mainnet" | "testnet";
type Raw = { networks: Record<Net, { builders: { aster: string | null }; approvalCeilings: { aster: string }; lighterSigningIds: Record<string, number>; asterNetwork: string; templateHashes: Record<string, string[]> }> } & Record<string, unknown>;

const bare = (h: string) => h.replace(/^0x/, "").toLowerCase();

export function lighterKindSets(): string[][] {
  const out: string[][] = [];
  for (const elig of [false, true]) for (const integ of [false, true]) for (const pol of [false, true]) out.push([...(elig ? ["eligibility_declaration"] : []), "lighter_change_pubkey", ...(integ ? ["lighter_approve_integrator"] : []), ...(pol ? ["agent_policy"] : [])]);
  return out;
}

/** The pins file with every computed hash refreshed. Hyperliquid entries are kept (and extended by --hl-bundle). */
export function regenerate(raw: Raw, hlBundles: { network: Net; bundle: unknown }[] = []): Raw {
  const next = structuredClone(raw);
  for (const net of ["mainnet", "testnet"] as Net[]) {
    const n = next.networks[net];
    for (const venue of ["lighter-mainnet", "lighter-rh"] as const) n.templateHashes[venue] = lighterKindSets().map((k) => bare(lighterTemplateHash(venue, n.lighterSigningIds[venue]!, k)));
    n.templateHashes.aster = n.builders.aster ? [bare(asterTemplateHash(n.builders.aster as `0x${string}`, n.asterNetwork, n.approvalCeilings.aster))] : [];
    const hl = new Set(n.templateHashes.hyperliquid ?? []);
    for (const b of hlBundles.filter((x) => x.network === net)) hl.add(bare(hlTemplateHash(b.bundle as never)));
    n.templateHashes.hyperliquid = [...hl].sort();
  }
  return next;
}

export const render = (raw: Raw): string => `${JSON.stringify(raw, null, 2)}\n`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const raw = JSON.parse(readFileSync(PINS_FILE, "utf8")) as Raw;
  const hl: { network: Net; bundle: unknown }[] = [];
  const ni = args.indexOf("--network");
  const net = (ni >= 0 ? args[ni + 1] : "mainnet") as Net;
  for (let i = 0; i < args.length; i++) if (args[i] === "--hl-bundle") hl.push({ network: net, bundle: JSON.parse(readFileSync(args[++i]!, "utf8")) });
  const text = render(regenerate(raw, hl));
  if (args.includes("--check")) {
    if (text !== readFileSync(PINS_FILE, "utf8")) {
      console.error("gen-pins: pins.json is out of date; run bun packages/sdk/scripts/gen-pins.ts");
      process.exit(1);
    }
    console.log("gen-pins: pins.json is current");
  } else {
    writeFileSync(PINS_FILE, text);
    console.log("gen-pins: wrote pins.json");
  }
}
