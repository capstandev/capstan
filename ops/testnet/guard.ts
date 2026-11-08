// Network guards for every testnet sender and reader (todo 41 R1) and the secret scan for outputs and reports (R2).
// A sender asserts the network first: RHC testnet 46630, Base Sepolia 84532, Solana devnet genesis, Hyperliquid
// "Testnet", Lighter signing id 300 on a testnet host, Aster 714. Every mainnet chain id and host is refused, and so is
// any host that is not on the testnet list (loopback is allowed for anvil forks, which still pass the chain-id check).

export class NetworkRefused extends Error {
  constructor(message: string) {
    super(`refusing: ${message}`);
    this.name = "NetworkRefused";
  }
}

export const TESTNET_EVM_CHAINS: Readonly<Record<number, string>> = Object.freeze({ 46630: "Robinhood Chain testnet", 84532: "Base Sepolia" });
/** Mainnet chain ids named for a clear refusal message (any id not in TESTNET_EVM_CHAINS is refused anyway). */
export const MAINNET_EVM_CHAINS: Readonly<Record<number, string>> = Object.freeze({ 1: "Ethereum", 4663: "Robinhood Chain", 8453: "Base", 42161: "Arbitrum One", 56: "BNB Chain", 10: "Optimism", 137: "Polygon", 1337: "Hyperliquid L1" });

export const TESTNET_HOSTS = Object.freeze({
  rhc: "rpc.testnet.chain.robinhood.com",
  baseSepolia: "sepolia.base.org",
  solanaDevnet: "api.devnet.solana.com",
  hl: "api.hyperliquid-testnet.xyz",
  lighter: "testnet.zklighter.elliot.ai",
  lighterRh: "api.rh-testnet.lighter.xyz",
  aster: "fapi.asterdex-testnet.com",
});

export const MAINNET_HOSTS: readonly string[] = Object.freeze([
  "rpc.mainnet.chain.robinhood.com",
  "mainnet.base.org",
  "api.mainnet-beta.solana.com",
  "api.mainnet.solana.com",
  "api.hyperliquid.xyz",
  "mainnet.zklighter.elliot.ai",
  "api.rh.lighter.xyz",
  "fapi.asterdex.com",
  "api.arcus.xyz",
]);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Solana devnet genesis hash (getGenesisHash); the caip2 id is its first 32 characters. Mainnet starts 5eykt4Us. */
export const SOLANA_DEVNET_GENESIS_PREFIX = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new NetworkRefused(`${url} is not a URL`);
  }
}

/** Any URL a testnet script talks to: refuses mainnet hosts and every host not on the testnet list. */
export function assertTestnetHost(url: string, allowed: readonly string[] = Object.values(TESTNET_HOSTS)): void {
  const host = hostOf(url);
  const bare = host.replace(/:\d+$/, "");
  if (MAINNET_HOSTS.includes(bare)) throw new NetworkRefused(`${host} is a mainnet host`);
  if (LOOPBACK.has(bare) || bare === "[::1]") return;
  if (!allowed.includes(bare)) throw new NetworkRefused(`${host} is not a known testnet host`);
}

/** An EVM chain id read from the RPC must equal the wanted testnet id, and the wanted id must be a testnet id. */
export function assertTestnetChainId(got: number, want: number): void {
  if (MAINNET_EVM_CHAINS[want] || !TESTNET_EVM_CHAINS[want]) throw new NetworkRefused(`chain ${want} is not a testnet this runner may use`);
  if (MAINNET_EVM_CHAINS[got]) throw new NetworkRefused(`the RPC answers chain ${got} (${MAINNET_EVM_CHAINS[got]} mainnet)`);
  if (got !== want) throw new NetworkRefused(`the RPC answers chain ${got}, expected ${want}`);
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function rpcCall<T>(rpc: string, method: string, params: unknown[], f: Fetch = fetch): Promise<T> {
  const r = await f(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message?: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message ?? "rpc error"}`);
  return j.result as T;
}

/** Host check plus eth_chainId check. Returns the chain id. */
export async function assertEvmTestnet(rpc: string, want: number, f: Fetch = fetch): Promise<number> {
  assertTestnetHost(rpc);
  const got = Number.parseInt(await rpcCall<string>(rpc, "eth_chainId", [], f), 16);
  assertTestnetChainId(got, want);
  return got;
}

export async function assertSolanaDevnet(rpc: string, f: Fetch = fetch): Promise<void> {
  assertTestnetHost(rpc);
  const g = await rpcCall<string>(rpc, "getGenesisHash", [], f);
  if (!g.startsWith(SOLANA_DEVNET_GENESIS_PREFIX)) throw new NetworkRefused(`genesis ${g} is not Solana devnet`);
}

export function assertHlTestnet(url: string, chain: string): void {
  if (hostOf(url) !== TESTNET_HOSTS.hl) throw new NetworkRefused(`${url} is not the Hyperliquid testnet host`);
  if (chain !== "Testnet") throw new NetworkRefused(`hyperliquidChain ${chain} is not Testnet`);
}

/** Both Lighter testnets use signing id 300, so the host is what tells them apart: it must be a testnet host. */
export function assertLighterTestnet(url: string, signingChainId: number): void {
  const h = hostOf(url);
  if (h !== TESTNET_HOSTS.lighter && h !== TESTNET_HOSTS.lighterRh) throw new NetworkRefused(`${url} is not a Lighter testnet host`);
  if (signingChainId !== 300) throw new NetworkRefused(`Lighter signing id ${signingChainId} is not the testnet id 300`);
}

export function assertAsterTestnet(url: string, chainId: number): void {
  if (hostOf(url) !== TESTNET_HOSTS.aster) throw new NetworkRefused(`${url} is not the Aster testnet host`);
  if (chainId !== 714) throw new NetworkRefused(`Aster chain id ${chainId} is not the testnet id 714`);
}

/**
 * R2 scan: returns a list of problems. A problem is any given secret (a password file's content) found in the text,
 * or any 64-hex value (a possible private key) that is not a transaction hash inside an explorer /tx/ link.
 */
export function findSecrets(text: string, secrets: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const s of secrets) {
    const t = s.trim();
    if (t.length >= 8 && text.includes(t)) out.push("a password value appears in the text");
  }
  const re = /(\/tx\/)?(?<![0-9a-zA-Z])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
  for (const m of text.matchAll(re)) if (!m[1]) out.push(`a 64-hex value at offset ${m.index}`);
  return out;
}
