// The testnet wallet list: one entry per wallet, read by make-wallets.sh, doctor.ts, run-all.ts and the runbook.
// Addresses are public and live in <home>/addresses.json; keys stay in encrypted keystores; passwords stay in chmod-600
// files under <home> (default ~/.capstan-testnet, outside every repo). Testnet only: nothing here is ever a mainnet key.
import { homedir } from "node:os";
import { join } from "node:path";

export type WalletKind = "evm" | "solana";

/** What a wallet must hold before the suites that use it run. */
export interface Need {
  network: "rhc-testnet" | "base-sepolia" | "hl-testnet" | "lighter-testnet" | "lighter-rh-testnet" | "solana-devnet";
  asset: string;
  /** Minimum in whole units (ETH, USDC, SOL). 0 means "an account must exist". */
  min: number;
  backlog: string;
  faucet: string;
}

export interface WalletSpec {
  /** Short role name; the keystore file is capstan-testnet-<role>. */
  role: string;
  kind: WalletKind;
  purpose: string;
  needs: Need[];
}

export const RHC_FAUCET = "https://faucet.testnet.chain.robinhood.com";
export const HL_FAUCET = "https://app.hyperliquid-testnet.xyz/drip";
export const LIGHTER_TESTNET_APP = "https://testnet.app.lighter.xyz";
export const CIRCLE_FAUCET = "https://faucet.circle.com";
export const BASE_SEPOLIA_FAUCET = "https://portal.cdp.coinbase.com/products/faucet";
export const SOLANA_DEVNET_FAUCET = "https://faucet.solana.com";

export const WALLETS: readonly WalletSpec[] = [
  { role: "deployer", kind: "evm", purpose: "deploys CPST, CPSTLock and CapstanReceiptAnchor on RHC testnet, creates the testnet brand Safe", needs: [{ network: "rhc-testnet", asset: "ETH", min: 0.002, backlog: "A1", faucet: RHC_FAUCET }] },
  { role: "anchor-poster", kind: "evm", purpose: "posts the hourly receipt root to the testnet anchor", needs: [{ network: "rhc-testnet", asset: "ETH", min: 0.0005, backlog: "A6", faucet: RHC_FAUCET }] },
  { role: "safe-1", kind: "evm", purpose: "testnet brand Safe signer 1 of 3 (holds nothing)", needs: [] },
  { role: "safe-2", kind: "evm", purpose: "testnet brand Safe signer 2 of 3 (holds nothing)", needs: [] },
  { role: "safe-3", kind: "evm", purpose: "testnet brand Safe signer 3 of 3 (holds nothing)", needs: [] },
  {
    role: "facilitator",
    kind: "evm",
    purpose: "x402 facilitator gas on Base Sepolia and RHC testnet",
    needs: [
      { network: "base-sepolia", asset: "ETH", min: 0.001, backlog: "A6", faucet: BASE_SEPOLIA_FAUCET },
      { network: "rhc-testnet", asset: "ETH", min: 0.0005, backlog: "A6", faucet: RHC_FAUCET },
    ],
  },
  {
    role: "x402-payer",
    kind: "evm",
    purpose: "pays x402 calls on Base Sepolia (USDC) and RHC testnet (USDG)",
    needs: [
      { network: "base-sepolia", asset: "USDC", min: 1, backlog: "A5", faucet: CIRCLE_FAUCET },
      { network: "rhc-testnet", asset: "USDG", min: 0.1, backlog: "A5", faucet: "no public USDG faucet: a small test transfer from any RHC testnet USDG holder" },
    ],
  },
  { role: "x402-payto", kind: "evm", purpose: "receives the x402 test payments (holds nothing to start)", needs: [] },
  { role: "hl-main", kind: "evm", purpose: "Hyperliquid testnet main wallet: onboarding, orders, HIP-3, revokes", needs: [{ network: "hl-testnet", asset: "USDC", min: 20, backlog: "A2", faucet: HL_FAUCET }] },
  { role: "hl-builder", kind: "evm", purpose: "Hyperliquid testnet builder (needs 100 USDC in perps to receive builder fees)", needs: [{ network: "hl-testnet", asset: "USDC", min: 100, backlog: "A2", faucet: HL_FAUCET }] },
  { role: "lighter", kind: "evm", purpose: "Lighter testnet (signing id 300, testnet.zklighter.elliot.ai) L1 wallet", needs: [{ network: "lighter-testnet", asset: "USDC", min: 0, backlog: "A3", faucet: LIGHTER_TESTNET_APP }] },
  { role: "lighter-rh", kind: "evm", purpose: "Lighter RH testnet (signing id 300, api.rh-testnet.lighter.xyz) L1 wallet, a separate account", needs: [{ network: "lighter-rh-testnet", asset: "USDC", min: 0, backlog: "A3", faucet: "no public app found for the RH testnet: ask in the Lighter Discord" }] },
  { role: "sol-facilitator", kind: "solana", purpose: "x402 Solana devnet fee payer", needs: [{ network: "solana-devnet", asset: "SOL", min: 0.05, backlog: "A6", faucet: SOLANA_DEVNET_FAUCET }] },
  { role: "sol-payer", kind: "solana", purpose: "pays x402 calls with Solana devnet USDC", needs: [{ network: "solana-devnet", asset: "USDC", min: 1, backlog: "A5", faucet: CIRCLE_FAUCET }] },
  { role: "sol-payto", kind: "solana", purpose: "receives the Solana devnet test payments (needs its own USDC token account)", needs: [{ network: "solana-devnet", asset: "USDC account", min: 1, backlog: "A5", faucet: "run `bun ops/testnet/make-solana.ts --payto-ata` (sol-facilitator pays about 0.00204 SOL rent)" }] },
];

/** Aster wallets are made on the VPS only (make-wallets-vps.sh); listed here so the doctor and runbook name them. */
export const VPS_WALLETS: readonly WalletSpec[] = [
  { role: "aster-main", kind: "evm", purpose: "Aster testnet main wallet (deposit clears the -5050 gate), VPS only", needs: [] },
  { role: "aster-builder", kind: "evm", purpose: "Aster testnet builder (at least 100 testnet ASTER in Futures), VPS only", needs: [] },
];

export interface Paths {
  home: string;
  keystores: string;
  solana: string;
  addresses: string;
}

export function paths(env: Record<string, string | undefined> = process.env): Paths {
  const home = env.CAPSTAN_TESTNET_HOME ?? join(homedir(), ".capstan-testnet");
  return {
    home,
    keystores: env.CAPSTAN_TESTNET_KEYSTORES ?? join(homedir(), ".foundry", "keystores"),
    solana: join(home, "solana"),
    addresses: join(home, "addresses.json"),
  };
}

export const keystoreName = (role: string) => `capstan-testnet-${role}`;

export function keystorePath(w: Pick<WalletSpec, "role" | "kind">, p: Paths): string {
  return w.kind === "evm" ? join(p.keystores, keystoreName(w.role)) : join(p.solana, `${keystoreName(w.role)}.json`);
}

export function passwordPath(w: Pick<WalletSpec, "role">, p: Paths): string {
  return join(p.home, `${keystoreName(w.role)}.password`);
}

/** role -> address, from the public addresses file (empty when make-wallets has not run). */
export async function readAddresses(p: Paths): Promise<Record<string, string>> {
  const f = Bun.file(p.addresses);
  if (!(await f.exists())) return {};
  return JSON.parse(await f.text()) as Record<string, string>;
}

/** Merge role -> address into the public addresses file. */
export async function recordAddress(p: Paths, role: string, address: string): Promise<void> {
  const all = await readAddresses(p);
  all[role] = address;
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
  await Bun.write(p.addresses, `${JSON.stringify(sorted, null, 2)}\n`);
}

// CLI for the shell scripts: `bun wallets.ts roles evm|solana|vps` prints one role per line;
// `bun wallets.ts record <role> <address>` merges one address into addresses.json.
if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "roles") {
    const list = a === "vps" ? VPS_WALLETS : WALLETS.filter((w) => w.kind === a);
    for (const w of list) console.log(w.role);
  } else if (cmd === "record" && a && b) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(b) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b)) throw new Error("not an address");
    await recordAddress(paths(), a, b);
  } else {
    console.error("usage: bun wallets.ts roles evm|solana|vps | record <role> <address>");
    process.exit(2);
  }
}
