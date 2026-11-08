// The user's main wallet. EIP-6963 discovery of injected wallets (BACKLOG B8: WalletConnect through Reown only once a
// project id exists), and a guard around the SDK's EIP-1193 bridge: before any signature the wallet's current chain
// is read and checked against the profile (the fork profile never signs a write from chain 4663). The chain is never
// switched for the user: Hyperliquid user-signed actions use the wallet's own chain as signatureChainId.
import type { AppConfig } from "../config";
import { eip1193Wallet, type Eip1193Provider, type Hex, type WalletSigner } from "../lib/capstan";

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface DiscoveredWallet {
  info: WalletInfo;
  provider: Eip1193Provider;
}

/** EIP-6963: ask every injected wallet to announce itself; collect the answers for `waitMs`. */
export function discoverWallets(win: Window = window, waitMs = 300): Promise<DiscoveredWallet[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredWallet>();
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<DiscoveredWallet>).detail;
      if (d?.info?.uuid && d.provider && typeof d.provider.request === "function") found.set(d.info.uuid, d);
    };
    win.addEventListener("eip6963:announceProvider", onAnnounce);
    win.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      win.removeEventListener("eip6963:announceProvider", onAnnounce);
      resolve([...found.values()]);
    }, waitMs);
  });
}

/** WalletConnect through the Reown AppKit picker is offered only when the build has a project id (BACKLOG B8). */
export function reownEnabled(cfg: Pick<AppConfig, "reownProjectId">): boolean {
  return typeof cfg.reownProjectId === "string" && cfg.reownProjectId.length > 0;
}

export const REOWN_WALLET_ID = "reown-appkit";

/**
 * One entry that stands for the official Reown AppKit picker. AppKit loads only when the user asks to connect (its
 * code is a separate chunk); the picker lists WalletConnect and the wallets injected in this browser, and the
 * provider it hands back goes through the same chain guard and SDK bridge as an EIP-6963 wallet.
 */
export function reownWallet(cfg: Pick<AppConfig, "reownProjectId" | "profile">, open: (projectId: string) => Promise<Eip1193Provider> = async (id) => (await import("./reown")).openReown(id, cfg)): DiscoveredWallet {
  let real: Promise<Eip1193Provider> | null = null;
  const provider: Eip1193Provider = {
    async request(a) {
      if (!cfg.reownProjectId) throw new Error("No WalletConnect project id in this build.");
      real ??= open(cfg.reownProjectId).catch((e) => {
        real = null;
        throw e;
      });
      return (await real).request(a);
    },
  };
  return { info: { uuid: REOWN_WALLET_ID, name: "a wallet (WalletConnect or browser)", icon: "", rdns: "com.reown.appkit" }, provider };
}

export class WriteRefused extends Error {
  constructor(
    message: string,
    readonly chainId: number,
  ) {
    super(message);
  }
}

/** A wallet error raised while a given step was being signed (the builder step is told apart from the others). */
export class WalletStepError extends Error {
  constructor(
    message: string,
    readonly step: string,
    readonly declined: boolean,
  ) {
    super(message);
  }
}

export const isBuilderStep = (primaryType: string) => /ApproveBuilderFee|approveBuilder/i.test(primaryType);

export async function walletChainId(p: Eip1193Provider): Promise<number> {
  const raw = await p.request({ method: "eth_chainId" });
  return Number(BigInt(String(raw)));
}

/** Throws WriteRefused when the profile forbids signing a write from the wallet's current chain. */
export async function assertWriteChain(p: Eip1193Provider, cfg: Pick<AppConfig, "writeChainAllowlist" | "writeChainDenylist" | "profile">): Promise<number> {
  const id = await walletChainId(p);
  if (cfg.writeChainDenylist.includes(id)) throw new WriteRefused(`Your wallet is on chain ${id}. This ${cfg.profile === "fork" ? "local test network build" : "build"} never signs a write from that chain. Switch your wallet to a test chain yourself, then try again.`, id);
  if (cfg.writeChainAllowlist.length > 0 && !cfg.writeChainAllowlist.includes(id)) throw new WriteRefused(`Your wallet is on chain ${id}, which this build does not sign writes from. Allowed: ${cfg.writeChainAllowlist.join(", ")}.`, id);
  return id;
}

const declinedCode = (e: unknown) => (e as { code?: number })?.code === 4001 || /reject|denied|declin/i.test(String((e as Error)?.message ?? ""));

export interface GuardHooks {
  /** Shown before the wallet prompts: the SDK's plain lines for the checked bundle. */
  confirm(lines: string[]): Promise<boolean>;
  /** Called just before each wallet prompt (tests record the page at that moment). */
  onPrompt?(kind: string): void;
}

/** The SDK's EIP-1193 bridge with the chain guard in front of every signature. */
export function guardedWallet(provider: Eip1193Provider, cfg: Pick<AppConfig, "writeChainAllowlist" | "writeChainDenylist" | "profile">, hooks: GuardHooks): WalletSigner {
  const base = eip1193Wallet(provider, { confirm: hooks.confirm });
  return {
    address: base.address,
    confirm: base.confirm!,
    async signTypedData(td) {
      await assertWriteChain(provider, cfg);
      hooks.onPrompt?.(td.primaryType);
      try {
        return await base.signTypedData(td);
      } catch (e) {
        throw new WalletStepError((e as Error)?.message ?? "the wallet did not sign", td.primaryType, declinedCode(e));
      }
    },
    async signMessage(text) {
      await assertWriteChain(provider, cfg);
      hooks.onPrompt?.("message");
      try {
        return await base.signMessage(text);
      } catch (e) {
        throw new WalletStepError((e as Error)?.message ?? "the wallet did not sign", "message", declinedCode(e));
      }
    },
  };
}

export async function requestOwner(p: Eip1193Provider): Promise<Hex> {
  const a = (await p.request({ method: "eth_requestAccounts" })) as string[];
  if (!Array.isArray(a) || typeof a[0] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a[0])) throw new Error("The wallet returned no account.");
  return a[0].toLowerCase() as Hex;
}
