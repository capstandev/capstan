// The official Reown AppKit picker (WalletConnect plus the wallets injected in this browser), loaded only when a
// build has VITE_WALLETCONNECT_PROJECT_ID and the user asks to connect. Analytics, email and social logins are off.
// The provider it returns is an EIP-1193 provider; wallet.ts puts the chain guard in front of it and the SDK's bridge
// signs through it, exactly as for an EIP-6963 wallet. The chain is never switched for the user.
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { createAppKit } from "@reown/appkit";
import { arbitrum, arbitrumSepolia, base, defineChain, mainnet } from "@reown/appkit/networks";
import type { AppConfig } from "../config";
import type { Eip1193Provider } from "../lib/capstan";
import { openWhenReady } from "./reown-open";

const robinhoodChain = defineChain({
  id: 4663,
  caipNetworkId: "eip155:4663",
  chainNamespace: "eip155",
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

let kit: ReturnType<typeof createAppKit> | null = null;

/** Opens the picker and resolves with the connected wallet's provider (rejects when the user closes it unconnected). */
export function openReown(projectId: string, cfg: Pick<AppConfig, "profile">): Promise<Eip1193Provider> {
  kit ??= createAppKit({
    adapters: [new EthersAdapter()],
    // HL user-signed actions use the wallet's own chain; the fork profile refuses writes from 4663 in wallet.ts
    networks: cfg.profile === "fork" ? [arbitrumSepolia, arbitrum, mainnet, base, robinhoodChain] : [arbitrum, mainnet, base, robinhoodChain, arbitrumSepolia],
    projectId,
    metadata: { name: "Capstan", description: "One API for on-chain perps", url: location.origin, icons: [] },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, send: false, history: false },
    allowUnsupportedChain: true,
  });
  const k = kit;
  return new Promise<Eip1193Provider>((resolve, reject) => {
    let opened = false;
    const done = (fn: () => void) => {
      offAccount();
      offState();
      fn();
    };
    const tryResolve = () => {
      const p = k.getWalletProvider() as Eip1193Provider | undefined;
      if (k.getIsConnectedState() && p && typeof p.request === "function") done(() => resolve(p));
    };
    const offAccount = k.subscribeAccount(() => tryResolve());
    const offState = k.subscribeState((st) => {
      if (st.open) opened = true;
      else if (opened && !k.getIsConnectedState()) done(() => reject(new Error("The wallet picker was closed before a wallet connected.")));
    });
    tryResolve();
    void openWhenReady(k).catch((e: unknown) => done(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });
}
