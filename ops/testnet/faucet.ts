// Keyless faucets this runner may use by itself (todo 41): only a faucet with a public API and no sign-in, CAPTCHA or
// mainnet balance. Checked 2026-11-06, none qualifies today:
//   Solana devnet requestAirdrop (public JSON-RPC on api.devnet.solana.com): CLOSED, HTTP 410 "The RPC faucet is
//   closed on this cluster"; faucet.solana.com needs a GitHub sign-in. run-all still tries it once per run.
//   RHC testnet faucet: Vercel bot check (CAPTCHA). Hyperliquid testnet drip: needs a wallet sign-in and a mainnet
//   deposit on the same address. Circle USDC faucet (Base Sepolia, Solana devnet): reCAPTCHA. Base Sepolia ETH
//   faucets: sign-in or a mainnet balance. Lighter testnet: the testnet app with a wallet sign-in.
// Those go to the owner as one combined BACKLOG item. The devnet genesis is asserted before any request.
import { assertSolanaDevnet, rpcCall, type Fetch } from "./guard";
import { RPC } from "./doctor";

export interface AirdropResult {
  address: string;
  sol: number;
  signature: string | null;
  error: string | null;
}

/** One devnet SOL airdrop (testnet only). Waits up to ~60 s for confirmation. */
export async function solanaAirdrop(address: string, sol: number, f: Fetch = fetch, rpc = RPC.solanaDevnet, sleep = (ms: number) => Bun.sleep(ms)): Promise<AirdropResult> {
  await assertSolanaDevnet(rpc, f);
  if (sol <= 0 || sol > 2) throw new Error("airdrop amount must be above 0 and at most 2 SOL");
  let signature: string;
  try {
    signature = await rpcCall<string>(rpc, "requestAirdrop", [address, Math.round(sol * 1e9)], f);
  } catch (e) {
    return { address, sol, signature: null, error: (e as Error).message };
  }
  for (let i = 0; i < 30; i++) {
    const st = await rpcCall<{ value: ({ confirmationStatus?: string; err?: unknown } | null)[] }>(rpc, "getSignatureStatuses", [[signature]], f).catch(() => null);
    const s = st?.value?.[0];
    if (s?.err) return { address, sol, signature, error: "airdrop transaction failed" };
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return { address, sol, signature, error: null };
    await sleep(2000);
  }
  return { address, sol, signature, error: "not confirmed within 60 s" };
}

export interface FaucetCheck {
  faucet: string;
  url: string;
  usable: boolean;
  why: string;
}

/** The faucet survey, as recorded in the report and the runbook. */
export const FAUCETS: readonly FaucetCheck[] = [
  { faucet: "Solana devnet SOL (RPC airdrop)", url: "https://api.devnet.solana.com (requestAirdrop)", usable: false, why: "HTTP 410: the RPC faucet is closed on devnet (checked 2026-11-06)" },
  { faucet: "Solana devnet SOL (web)", url: "https://faucet.solana.com", usable: false, why: "GitHub sign-in" },
  { faucet: "RHC testnet ETH", url: "https://faucet.testnet.chain.robinhood.com", usable: false, why: "Vercel bot check (CAPTCHA); HTTP 429 to scripts" },
  { faucet: "Hyperliquid testnet USDC", url: "https://app.hyperliquid-testnet.xyz/drip", usable: false, why: "wallet sign-in, and the address needs a mainnet deposit" },
  { faucet: "Circle USDC (Base Sepolia, Solana devnet)", url: "https://faucet.circle.com", usable: false, why: "reCAPTCHA" },
  { faucet: "Base Sepolia ETH", url: "https://portal.cdp.coinbase.com/products/faucet", usable: false, why: "account sign-in (other faucets need a mainnet balance)" },
  { faucet: "Lighter testnet", url: "https://testnet.app.lighter.xyz", usable: false, why: "wallet sign-in in the testnet app" },
  { faucet: "Lighter RH testnet", url: "(no public app found)", usable: false, why: "no onboarding path found; ask Lighter" },
  { faucet: "RHC testnet USDG", url: "(none)", usable: false, why: "no faucet; USDG cannot be minted on testnet" },
];
