// WalletSigner: the user's MAIN wallet, reached through an interface only. The SDK never accepts a main-wallet key:
// it asks an EIP-1193 provider (eth_signTypedData_v4, personal_sign) or a viem-style account the caller owns.
// Hyperliquid's user-signed types carry a colon (HyperliquidTransaction:ApproveAgent), which viem's typed-data
// helpers refuse, so the EIP-1193 path sends the payload to eth_signTypedData_v4 as JSON, unchanged.
import type { Hex, TypedDataPayload } from "@capstan/schema";
import { digestTypedData } from "@capstan/signer-aster";
import { hashTypedPayload } from "@capstan/signer-hl";

/** EIP-712 digest of a payload: Hyperliquid's colon type names through the HL hasher, everything else through viem. */
export function typedDataDigest(td: TypedDataPayload): Hex {
  return td.primaryType.includes(":") ? hashTypedPayload(td) : digestTypedData(td);
}

export interface WalletSigner {
  address(): Promise<Hex>;
  signTypedData(td: TypedDataPayload): Promise<Hex>;
  signMessage(text: string): Promise<Hex>;
  /** Shown before every prompt: one plain sentence per step, the approval ceiling included. Return false to decline. */
  confirm?(lines: string[]): Promise<boolean>;
}

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const isSig = (x: unknown): x is Hex => typeof x === "string" && /^0x[0-9a-fA-F]{130}$/.test(x);

function jsonTyped(td: TypedDataPayload): string {
  const types = { ...td.types };
  if (!types.EIP712Domain) {
    const d = td.domain;
    const fields: { name: string; type: string }[] = [];
    if (d.name !== undefined) fields.push({ name: "name", type: "string" });
    if (d.version !== undefined) fields.push({ name: "version", type: "string" });
    if (d.chainId !== undefined) fields.push({ name: "chainId", type: "uint256" });
    if (d.verifyingContract !== undefined) fields.push({ name: "verifyingContract", type: "address" });
    if (d.salt !== undefined) fields.push({ name: "salt", type: "bytes32" });
    types.EIP712Domain = fields;
  }
  return JSON.stringify({ ...td, types }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** A browser or WalletConnect wallet. `confirm` defaults to the wallet's own prompt (no extra dialog). */
export function eip1193Wallet(provider: Eip1193Provider, opts: { confirm?: (lines: string[]) => Promise<boolean> } = {}): WalletSigner {
  let addr: Hex | null = null;
  const address = async (): Promise<Hex> => {
    if (addr) return addr;
    const a = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    if (!Array.isArray(a) || typeof a[0] !== "string") throw new Error("the wallet returned no account");
    addr = a[0].toLowerCase() as Hex;
    return addr;
  };
  return {
    address,
    async signTypedData(td) {
      const sig = await provider.request({ method: "eth_signTypedData_v4", params: [await address(), jsonTyped(td)] });
      if (!isSig(sig)) throw new Error("the wallet returned no 65-byte signature");
      return sig;
    },
    async signMessage(text) {
      const hex = `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      const sig = await provider.request({ method: "personal_sign", params: [hex, await address()] });
      if (!isSig(sig)) throw new Error("the wallet returned no 65-byte signature");
      return sig;
    },
    ...(opts.confirm ? { confirm: opts.confirm } : {}),
  };
}

/** A viem-style account the caller owns (local account, hardware account). The SDK never sees its key. */
export interface AccountLike {
  address: Hex;
  signMessage(a: { message: string }): Promise<Hex>;
  /** Raw digest signing, used for Hyperliquid's colon type names that typed-data helpers refuse. */
  sign?(a: { hash: Hex }): Promise<Hex>;
  signTypedData?(td: unknown): Promise<Hex>;
}

export function accountWallet(account: AccountLike, hashTyped: (td: TypedDataPayload) => Hex = typedDataDigest, opts: { confirm?: (lines: string[]) => Promise<boolean> } = {}): WalletSigner {
  return {
    async address() {
      return account.address.toLowerCase() as Hex;
    },
    async signTypedData(td) {
      if (account.sign) return account.sign({ hash: hashTyped(td) });
      if (!account.signTypedData) throw new Error("the account cannot sign typed data");
      return account.signTypedData(td);
    },
    signMessage: (text) => account.signMessage({ message: text }),
    ...(opts.confirm ? { confirm: opts.confirm } : {}),
  };
}
