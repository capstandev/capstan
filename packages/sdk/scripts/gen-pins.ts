// Regenerates the computed parts of packages/sdk/src/pins.json: the Lighter onboarding template hashes (every step
// combination this release accepts, per venue and network), the Aster template hash for each pinned builder and the
// Hyperliquid template hashes (the plain and the agent-safe bundle per network, built offline by the production
// adapter code in ./hl-template). Any change to the shape of a signed onboarding step makes --check fail until
// pins.json is regenerated in the same commit.
//   bun packages/sdk/scripts/gen-pins.ts                      write pins.json
//   bun packages/sdk/scripts/gen-pins.ts --check              CI and the pins test
//   bun packages/sdk/scripts/gen-pins.ts --hl-bundle <bundle.json> --network mainnet
//                                                             check a bundle a live server built against the pins
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asterTemplateHash, hlTemplateHash, lighterTemplateHash } from "../src/onboard";
import { hlProbeBundles } from "./hl-template";

export const PINS_FILE = join(import.meta.dir, "../src/pins.json");
type Net = "mainnet" | "testnet";
type Raw = { networks: Record<Net, { builders: { aster: string | null }; approvalCeilings: { aster: string }; lighterSigningIds: Record<string, number>; asterNetwork: string; templateHashes: Record<string, string[]> }> } & Record<string, unknown>;

const bare = (h: string) => h.replace(/^0x/, "").toLowerCase();

export function lighterKindSets(): string[][] {
  const out: string[][] = [];
  for (const elig of [false, true]) for (const integ of [false, true]) for (const pol of [false, true]) out.push([...(elig ? ["eligibility_declaration"] : []), "lighter_change_pubkey", ...(integ ? ["lighter_approve_integrator"] : []), ...(pol ? ["agent_policy"] : [])]);
  return out;
}

/** The Hyperliquid template hashes this release accepts, per network: the plain bundle and the agent-safe one. */
export async function hlTemplateHashes(): Promise<Record<Net, string[]>> {
  const out = {} as Record<Net, string[]>;
  for (const net of ["mainnet", "testnet"] as Net[]) {
    const b = await hlProbeBundles(net);
    const hs = [b.plain, b.policy].map((x) => {
      const h = bare(hlTemplateHash(x));
      if (h !== bare(x.templateHash)) throw new Error(`gen-pins: SDK and adapter Hyperliquid template hashes differ (${net})`);
      return h;
    });
    out[net] = [...new Set(hs)].sort();
  }
  return out;
}

/** The pins file with every computed hash refreshed. Without `hl` the Hyperliquid entries are kept as they are. */
export function regenerate(raw: Raw, hl?: Record<Net, string[]>): Raw {
  const next = structuredClone(raw);
  for (const net of ["mainnet", "testnet"] as Net[]) {
    const n = next.networks[net];
    for (const venue of ["lighter-mainnet", "lighter-rh"] as const) n.templateHashes[venue] = lighterKindSets().map((k) => bare(lighterTemplateHash(venue, n.lighterSigningIds[venue]!, k)));
    n.templateHashes.aster = n.builders.aster ? [bare(asterTemplateHash(n.builders.aster as `0x${string}`, n.asterNetwork, n.approvalCeilings.aster))] : [];
    if (hl) n.templateHashes.hyperliquid = [...hl[net]];
  }
  return next;
}

export const render = (raw: Raw): string => `${JSON.stringify(raw, null, 2)}\n`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const raw = JSON.parse(readFileSync(PINS_FILE, "utf8")) as Raw;
  const bi = args.indexOf("--hl-bundle");
  if (bi >= 0) {
    const ni = args.indexOf("--network");
    const net = (ni >= 0 ? args[ni + 1] : "mainnet") as Net;
    const h = bare(hlTemplateHash(JSON.parse(readFileSync(args[bi + 1]!, "utf8")) as never));
    const ok = raw.networks[net].templateHashes.hyperliquid?.includes(h) ?? false;
    console.log(`gen-pins: bundle template ${h} is ${ok ? "pinned" : "NOT pinned"} for ${net}`);
    process.exit(ok ? 0 : 1);
  }
  const text = render(regenerate(raw, await hlTemplateHashes()));
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
