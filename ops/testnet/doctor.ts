// Testnet doctor (todo 41): one line per wallet need: role, address, network, balance, what is missing, which BACKLOG
// item. Read-only: eth_chainId, eth_getBalance, eth_call balanceOf, Hyperliquid testnet /info, Lighter testnet
// accountsByL1Address, Solana devnet getBalance / getTokenAccountsByOwner. Every read asserts the testnet host and
// chain first. It reads only the public addresses file: never a keystore, never a password file.
// Writes <home>/doctor.json, which run-all.ts reads to decide which suites have funded wallets.
import { assertEvmTestnet, assertHlTestnet, assertLighterTestnet, assertSolanaDevnet, rpcCall, TESTNET_HOSTS, type Fetch } from "./guard";
import { paths, readAddresses, VPS_WALLETS, WALLETS, type Need, type WalletSpec } from "./wallets";

export const RPC = {
  rhc: process.env.RHC_TESTNET_RPC_URL ?? `https://${TESTNET_HOSTS.rhc}`,
  baseSepolia: process.env.BASE_SEPOLIA_RPC_URL ?? `https://${TESTNET_HOSTS.baseSepolia}`,
  solanaDevnet: process.env.SOLANA_DEVNET_RPC_URL ?? `https://${TESTNET_HOSTS.solanaDevnet}`,
  hl: `https://${TESTNET_HOSTS.hl}`,
  lighter: `https://${TESTNET_HOSTS.lighter}`,
  lighterRh: `https://${TESTNET_HOSTS.lighterRh}`,
};

/** Token facts (packages/schema constants/chains.ts rows usdgRhcTestnet, usdcBaseSepolia, usdcSolanaDevnet). */
export const TOKENS = {
  usdgRhcTestnet: { address: "0x7E955252E15c84f5768B83c41a71F9eba181802F", decimals: 6 },
  usdcBaseSepolia: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
  usdcSolanaDevnet: { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6 },
};

export interface NeedResult {
  role: string;
  address: string | null;
  network: Need["network"];
  asset: string;
  balance: number | null;
  min: number;
  ok: boolean;
  missing: string | null;
  backlog: string;
  faucet: string;
  /** Extra public facts (Lighter account index, HL spot balance). */
  detail?: Record<string, unknown>;
}

export interface DoctorReport {
  at: string;
  rows: NeedResult[];
  /** role -> every need met (a wallet with no needs counts as ready once it exists). */
  funded: Record<string, boolean>;
  addresses: Record<string, string>;
}

const pad32 = (addr: string) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const units = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

export interface Readers {
  evmNative(rpc: string, chainId: number, address: string): Promise<number>;
  erc20(rpc: string, chainId: number, token: string, decimals: number, address: string): Promise<number>;
  hlPerps(address: string): Promise<{ perps: number; spotUsdc: number }>;
  lighter(host: string, address: string): Promise<{ index: number | null; collateral: number }>;
  solNative(address: string): Promise<number>;
  splBalance(mint: string, address: string): Promise<number>;
  /** Number of token accounts the owner holds for the mint (0 = no account: payments to it are refused). */
  splAccounts(mint: string, address: string): Promise<number>;
}

export function liveReaders(f: Fetch = fetch): Readers {
  const checked = new Map<string, Promise<unknown>>();
  const once = (k: string, fn: () => Promise<unknown>) => {
    if (!checked.has(k)) checked.set(k, fn());
    return checked.get(k)!;
  };
  const evm = (rpc: string, chainId: number) => once(`evm:${rpc}:${chainId}`, () => assertEvmTestnet(rpc, chainId, f));
  const sol = () => once("sol", () => assertSolanaDevnet(RPC.solanaDevnet, f));
  return {
    async evmNative(rpc, chainId, address) {
      await evm(rpc, chainId);
      return units(BigInt(await rpcCall<string>(rpc, "eth_getBalance", [address, "latest"], f)), 18);
    },
    async erc20(rpc, chainId, token, decimals, address) {
      await evm(rpc, chainId);
      const r = await rpcCall<string>(rpc, "eth_call", [{ to: token, data: `0x70a08231${pad32(address)}` }, "latest"], f);
      return units(BigInt(r === "0x" ? 0 : r), decimals);
    },
    async hlPerps(address) {
      assertHlTestnet(RPC.hl, "Testnet");
      const post = async (body: unknown) => {
        const r = await f(`${RPC.hl}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new Error(`hl info HTTP ${r.status}`);
        return r.json() as Promise<any>;
      };
      const ch = await post({ type: "clearinghouseState", user: address });
      const sp = await post({ type: "spotClearinghouseState", user: address });
      const usdc = (sp?.balances ?? []).find((b: { coin?: string }) => b.coin === "USDC");
      return { perps: Number(ch?.marginSummary?.accountValue ?? 0), spotUsdc: Number(usdc?.total ?? 0) };
    },
    async lighter(host, address) {
      assertLighterTestnet(host, 300);
      const r = await f(`${host}/api/v1/accountsByL1Address?l1_address=${address}`, { signal: AbortSignal.timeout(20_000) });
      const j = (await r.json().catch(() => ({}))) as { code?: number; sub_accounts?: { index: number; account_type?: number; collateral?: string }[] };
      if (j.code === 21100 || !j.sub_accounts?.length) return { index: null, collateral: 0 };
      const main = j.sub_accounts.find((a) => a.account_type === 0) ?? j.sub_accounts[0]!;
      return { index: main.index, collateral: Number(main.collateral ?? 0) };
    },
    async solNative(address) {
      await sol();
      const r = await rpcCall<{ value: number }>(RPC.solanaDevnet, "getBalance", [address], f);
      return r.value / 1e9;
    },
    async splBalance(mint, address) {
      await sol();
      const r = await rpcCall<{ value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }[] }>(
        RPC.solanaDevnet,
        "getTokenAccountsByOwner",
        [address, { mint }, { encoding: "jsonParsed" }],
        f,
      );
      return r.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
    },
    async splAccounts(mint, address) {
      await sol();
      const r = await rpcCall<{ value: unknown[] }>(RPC.solanaDevnet, "getTokenAccountsByOwner", [address, { mint }, { encoding: "jsonParsed" }], f);
      return r.value.length;
    },
  };
}

async function readNeed(r: Readers, n: Need, address: string): Promise<{ balance: number; detail?: Record<string, unknown> }> {
  switch (n.network) {
    case "rhc-testnet":
      if (n.asset === "ETH") return { balance: await r.evmNative(RPC.rhc, 46630, address) };
      return { balance: await r.erc20(RPC.rhc, 46630, TOKENS.usdgRhcTestnet.address, TOKENS.usdgRhcTestnet.decimals, address) };
    case "base-sepolia":
      if (n.asset === "ETH") return { balance: await r.evmNative(RPC.baseSepolia, 84532, address) };
      return { balance: await r.erc20(RPC.baseSepolia, 84532, TOKENS.usdcBaseSepolia.address, TOKENS.usdcBaseSepolia.decimals, address) };
    case "hl-testnet": {
      const h = await r.hlPerps(address);
      return { balance: h.perps, detail: { spotUsdc: h.spotUsdc } };
    }
    case "lighter-testnet":
    case "lighter-rh-testnet": {
      const l = await r.lighter(n.network === "lighter-testnet" ? RPC.lighter : RPC.lighterRh, address);
      return { balance: l.index === null ? -1 : l.collateral, detail: { accountIndex: l.index } };
    }
    case "solana-devnet":
      if (n.asset === "SOL") return { balance: await r.solNative(address) };
      if (n.asset === ACCOUNT_ASSET) return { balance: await r.splAccounts(TOKENS.usdcSolanaDevnet.mint, address) };
      return { balance: await r.splBalance(TOKENS.usdcSolanaDevnet.mint, address) };
  }
}

/** A need that is an account, not a balance: "sol-payto USDC account exists". */
export const ACCOUNT_ASSET = "USDC account";

/** -1 from a Lighter read means "no account". */
function missingText(n: Need, balance: number | null): string | null {
  if (balance === null) return "read failed";
  if (n.asset === ACCOUNT_ASSET) return balance >= 1 ? null : "no USDC account yet";
  if (balance < 0) return "no account yet";
  if (balance < n.min) return `needs ${n.min} ${n.asset}`;
  return null;
}

export async function runDoctor(opts: { readers?: Readers; env?: Record<string, string | undefined>; wallets?: readonly WalletSpec[] } = {}): Promise<DoctorReport> {
  const p = paths(opts.env);
  const addresses = await readAddresses(p);
  const r = opts.readers ?? liveReaders();
  const rows: NeedResult[] = [];
  const funded: Record<string, boolean> = {};
  for (const w of opts.wallets ?? WALLETS) {
    const address = addresses[w.role] ?? null;
    funded[w.role] = !!address;
    for (const n of w.needs) {
      let balance: number | null = null;
      let detail: Record<string, unknown> | undefined;
      let err: string | null = null;
      if (address) {
        try {
          ({ balance, detail } = await readNeed(r, n, address));
        } catch (e) {
          err = (e as Error).message;
        }
      }
      const missing = !address ? "wallet not made (run make-wallets.sh)" : err ? `read failed: ${err}` : missingText(n, balance);
      const ok = missing === null;
      if (!ok) funded[w.role] = false;
      rows.push({ role: w.role, address, network: n.network, asset: n.asset, balance: balance !== null && balance < 0 ? null : balance, min: n.min, ok, missing, backlog: n.backlog, faucet: n.faucet, ...(detail ? { detail } : {}) });
    }
  }
  const report: DoctorReport = { at: new Date().toISOString(), rows, funded, addresses };
  await Bun.write(`${p.home}/doctor.json`, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function formatRow(x: NeedResult): string {
  const account = x.asset === ACCOUNT_ASSET;
  const bal = x.balance === null ? "n/a" : account ? (x.balance >= 1 ? "account" : "no account") : `${x.balance} ${x.asset}`;
  return `${x.ok ? "ok  " : "MISS"} ${x.role.padEnd(16)} ${(x.address ?? "-").padEnd(44)} ${x.network.padEnd(18)} ${bal.padEnd(16)} ${x.missing ?? (account ? `${x.role} ${x.asset} exists` : "funded")}${x.ok ? "" : ` (BACKLOG ${x.backlog}: ${x.faucet})`}`;
}

if (import.meta.main) {
  const rep = await runDoctor();
  for (const x of rep.rows) console.log(formatRow(x));
  const noNeeds = WALLETS.filter((w) => !w.needs.length).map((w) => `${w.role} ${rep.addresses[w.role] ?? "(not made)"}`);
  console.log(`no funds needed: ${noNeeds.join(", ")}`);
  console.log(`VPS only (make-wallets-vps.sh, BACKLOG A4, D1): ${VPS_WALLETS.map((w) => w.role).join(", ")}`);
  const ready = Object.entries(rep.funded).filter(([, v]) => v).map(([k]) => k);
  console.log(`ready: ${ready.length}/${WALLETS.length} wallets (${ready.join(", ") || "none"})`);
}
