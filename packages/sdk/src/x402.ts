// x402 client with spend controls (research x402-and-stack.md section 4 item 10). A 402 is paid only when one of its
// payment options is on the allowed list (network + asset) AND asks no more than the per-call cap. RHC USDG is not a
// default x402 asset, so it is payable only when listed here (the default list includes it with the same cap).
// The payer (the user's wallet through @x402 schemes, or the x402 package's paying client) is a port: this module
// decides WHETHER to pay; the payer only signs the one option chosen.
import { ADDRESSES } from "@capstan/schema";
import { b64decode, b64encode } from "./bytes";
import { SdkError } from "./errors";
import type { Network } from "./pins";

export const X402_NETWORKS = {
  base: "eip155:8453",
  baseSepolia: "eip155:84532",
  rhc: "eip155:4663",
  rhcTestnet: "eip155:46630",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  solanaDevnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
} as const;

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string; // atomic units
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}
export interface PaymentRequired {
  x402Version: number;
  resource?: unknown;
  accepts: PaymentRequirements[];
  error?: string;
}
export interface SpendControls {
  allowedAssets: { network: string; asset: string; maxAmountPerPayment: string }[];
}
export interface X402Payer {
  /** Sign a payment for exactly this requirement. Returns the PaymentPayload object. */
  createPaymentPayload(chosen: PaymentRequirements, required: PaymentRequired): Promise<unknown>;
}

/** Decimal dollars to 6-decimal atomic units, exactly. */
export function usdToAtomic(usd: string, decimals = 6): bigint {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(usd)) throw new SdkError("INVALID_INPUT", "maxUsdPerCall must be a plain decimal string", { field: "maxUsdPerCall" });
  const [i, f = ""] = usd.split(".");
  if (f.length > decimals) throw new SdkError("INVALID_INPUT", `maxUsdPerCall has more than ${decimals} decimals`, { field: "maxUsdPerCall" });
  return BigInt(i! + f.padEnd(decimals, "0"));
}

/** Base USDC, Solana USDC and (unless excluded) RHC USDG, each capped at maxUsdPerCall. */
export function sdkSpendControls(network: Network, maxUsdPerCall: string, opts: { includeRhcUsdg?: boolean } = {}): SpendControls {
  const cap = usdToAtomic(maxUsdPerCall).toString();
  const main = network === "mainnet";
  const list: SpendControls["allowedAssets"] = [
    { network: main ? X402_NETWORKS.base : X402_NETWORKS.baseSepolia, asset: (main ? ADDRESSES.usdcBase : ADDRESSES.usdcBaseSepolia).address, maxAmountPerPayment: cap },
    { network: main ? X402_NETWORKS.solana : X402_NETWORKS.solanaDevnet, asset: (main ? ADDRESSES.usdcSolana : ADDRESSES.usdcSolanaDevnet).address, maxAmountPerPayment: cap },
  ];
  if (opts.includeRhcUsdg !== false) list.push({ network: main ? X402_NETWORKS.rhc : X402_NETWORKS.rhcTestnet, asset: (main ? ADDRESSES.usdgRhc : ADDRESSES.usdgRhcTestnet).address, maxAmountPerPayment: cap });
  return { allowedAssets: list };
}

const sameAsset = (a: string, b: string, network: string) => (network.startsWith("eip155:") ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The first option (server order) that the controls allow and that fits under both caps; null when none does. */
export function selectPayment(req: PaymentRequired, controls: SpendControls, maxUsdPerCall: string): PaymentRequirements | null {
  const global = usdToAtomic(maxUsdPerCall);
  for (const o of req.accepts ?? []) {
    if (!o || typeof o.amount !== "string" || !/^\d+$/.test(o.amount)) continue;
    const allow = controls.allowedAssets.find((a) => a.network === o.network && sameAsset(a.asset, o.asset, o.network));
    if (!allow) continue;
    const amt = BigInt(o.amount);
    if (amt > global || amt > BigInt(allow.maxAmountPerPayment)) continue;
    return o;
  }
  return null;
}

export function decodePaymentRequired(res: Response, bodyText: string | null): PaymentRequired | null {
  const h = res.headers.get("PAYMENT-REQUIRED");
  try {
    if (h) return JSON.parse(new TextDecoder().decode(b64decode(h))) as PaymentRequired;
    if (bodyText) {
      const j = JSON.parse(bodyText) as Partial<PaymentRequired>;
      if (Array.isArray(j.accepts)) return j as PaymentRequired;
    }
  } catch {
    return null;
  }
  return null;
}

/** fetch that answers a 402 by paying once within the controls, or throws X402_REFUSED without paying. */
export function payingFetch(f: typeof fetch, payer: X402Payer, controls: SpendControls, maxUsdPerCall: string): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const first = await f(input, init);
    if (first.status !== 402) return first;
    const text = await first.text().catch(() => null);
    const req = decodePaymentRequired(first, text);
    if (!req) throw new SdkError("X402_REFUSED", "the 402 answer carries no readable payment requirements");
    const chosen = selectPayment(req, controls, maxUsdPerCall);
    if (!chosen) throw new SdkError("X402_REFUSED", `no payment option fits the spend controls (cap ${maxUsdPerCall} USD per call)`);
    const payload = await payer.createPaymentPayload(chosen, req);
    const headers = new Headers(init?.headers);
    headers.set("PAYMENT-SIGNATURE", b64encode(new TextEncoder().encode(JSON.stringify(payload))));
    return f(input, { ...init, headers });
  };
  return wrapped as typeof fetch;
}
