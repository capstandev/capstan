// Dashboard session: the connected main wallet, the SDK client over it (keys in the SDK's browserKeyStore, never in
// this file), the per-venue onboarding state and the receipts made in this session. The dashboard is a thin UI over
// the SDK: it never builds or edits a payload, and it shows the SDK's check results, never a server digest as final.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useConfig, type AppConfig } from "../config";
import { browserKeyStore, createClient, PINS, mergePins, type AgentPolicy, type CapstanClient, type Eip1193Provider, type Hex, type KeyStore, type VenueId, type WalletSigner } from "../lib/capstan";
import { createDashApi, type DashApi } from "./api";
import { discoverWallets, guardedWallet, requestOwner, walletChainId, type DiscoveredWallet, type WalletInfo } from "./wallet";

export type VenueStatus = "none" | "onboarding" | "active" | "fee_free_unavailable" | "error";

export interface VenueState {
  status: VenueStatus;
  agentRef?: string;
  agentAddress?: string;
  expiresAt?: string;
  mode?: "relay" | "direct";
  policyId?: string;
  receiptId?: string;
  message?: string;
}

export interface SessionReceipt {
  receiptId: string;
  what: string;
  venue: VenueId | null;
}

export interface ConfirmRequest {
  venue: VenueId;
  lines: string[];
  /** True once the user chose to continue: the lines stay on screen while the wallet prompts. */
  answered?: boolean;
}

export interface Connected {
  info: WalletInfo;
  provider: Eip1193Provider;
  owner: Hex;
  chainId: number;
}

export interface Session {
  cfg: AppConfig;
  wallets: DiscoveredWallet[] | null;
  findWallets(): Promise<void>;
  connect(w: DiscoveredWallet): Promise<void>;
  connected: Connected | null;
  connectError: string | null;
  eligibility: { allowed: boolean; code: string | null } | null;
  client: CapstanClient | null;
  /** The main wallet behind the chain guard (the SDK gets the same object). */
  wallet: WalletSigner | null;
  keystore: KeyStore;
  api: DashApi;
  venues: Partial<Record<VenueId, VenueState>>;
  setVenue(v: VenueId, s: VenueState): void;
  receipts: SessionReceipt[];
  addReceipt(r: SessionReceipt): void;
  /** The SDK's lines for a checked bundle, waiting for the user before the wallet prompts. */
  confirm: ConfirmRequest | null;
  answerConfirm(ok: boolean, reason?: "declined_builder" | "cancelled"): void;
  clearConfirm(): void;
  lastDecline: React.MutableRefObject<"declined_builder" | "cancelled" | null>;
  onboardingVenue: React.MutableRefObject<VenueId | null>;
  /** Wallet prompts shown so far (each signature request counts once). */
  prompts: React.MutableRefObject<number>;
  policyDraft: AgentPolicy | null;
  setPolicyDraft(p: AgentPolicy | null): void;
  apiKey: string | null;
  setApiKey(k: string | null): void;
  /** Tests record the page at each wallet prompt. */
  onPrompt?: (kind: string) => void;
}

const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

export interface SessionDeps {
  discover?: () => Promise<DiscoveredWallet[]>;
  onPrompt?: (kind: string) => void;
}

export function SessionProvider({ children, deps = {} }: { children: ReactNode; deps?: SessionDeps }) {
  const cfg = useConfig();
  const now = cfg.now ?? Date.now;
  const keystore = useMemo<KeyStore>(() => cfg.keystore?.() ?? browserKeyStore(), [cfg]);
  const [wallets, setWallets] = useState<DiscoveredWallet[] | null>(null);
  const [connected, setConnected] = useState<Connected | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [eligibility, setEligibility] = useState<Session["eligibility"]>(null);
  const [venues, setVenues] = useState<Session["venues"]>({});
  const [receipts, setReceipts] = useState<SessionReceipt[]>([]);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [policyDraft, setPolicyDraft] = useState<AgentPolicy | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const lastDecline = useRef<"declined_builder" | "cancelled" | null>(null);
  const onboardingVenue = useRef<VenueId | null>(null);
  const prompts = useRef(0);
  const clientRef = useRef<CapstanClient | null>(null);
  const apiKeyRef = useRef<string | null>(null);
  apiKeyRef.current = apiKey;

  // stable across renders: a new fetch function would rebuild the SDK client and drop its onboarded agents
  const baseFetch = useMemo<typeof fetch>(() => cfg.fetch ?? fetch.bind(globalThis), [cfg]);
  /** API fetch: adds the Capstan API key (memory only) to calls on the API host. */
  const apiFetch = useCallback(
    ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (apiKeyRef.current && url.startsWith(cfg.apiBase.replace(/\/v1\/?$/, ""))) {
        const h = new Headers(init?.headers);
        h.set("authorization", `Bearer ${apiKeyRef.current}`);
        return baseFetch(input, { ...init, headers: h });
      }
      return baseFetch(input, init);
    }) as typeof fetch,
    [cfg, baseFetch],
  );

  const chainForMessages = mergePins(PINS, cfg.pinned).networks[cfg.network].anchor.chainId;

  const walletSigner = useMemo(() => {
    if (!connected) return null;
    return guardedWallet(connected.provider, cfg, {
      confirm: (lines) =>
        new Promise<boolean>((resolve) => {
          lastDecline.current = null;
          resolver.current = resolve;
          setConfirm({ venue: onboardingVenue.current ?? "hyperliquid", lines });
        }),
      onPrompt: (kind) => {
        prompts.current++;
        deps.onPrompt?.(kind);
      },
    });
  }, [connected, cfg, deps.onPrompt]);

  const client = useMemo<CapstanClient | null>(() => {
    if (!walletSigner) return null;
    const c = createClient({
      apiBase: cfg.apiBase,
      network: cfg.network,
      keystore,
      walletSigner,
      fetch: apiFetch,
      venueFetch: baseFetch,
      ...(cfg.pinned ? { pinned: cfg.pinned } : {}),
      ...(cfg.venueHosts ? { venueHosts: cfg.venueHosts } : {}),
      ...(cfg.anchorAddress ? { anchor: { rpcUrl: cfg.rpcUrl, address: cfg.anchorAddress } } : {}),
      ...(cfg.now ? { now: cfg.now } : {}),
    });
    clientRef.current = c;
    return c;
  }, [walletSigner, cfg, keystore, apiFetch, baseFetch]);

  const api = useMemo(() => createDashApi({ apiBase: cfg.apiBase, fetch: apiFetch, wallet: walletSigner, owner: connected?.owner ?? null, chainId: chainForMessages, now }), [cfg, apiFetch, walletSigner, connected, chainForMessages, now]);

  const findWallets = useCallback(async () => {
    setWallets(await (deps.discover ?? (() => discoverWallets()))());
  }, [deps.discover]);

  const connect = useCallback(
    async (w: DiscoveredWallet) => {
      setConnectError(null);
      try {
        const owner = await requestOwner(w.provider);
        const chainId = await walletChainId(w.provider);
        setConnected({ info: w.info, provider: w.provider, owner, chainId });
        try {
          const r = await apiFetch(`${cfg.apiBase.replace(/\/$/, "")}/eligibility`, { headers: { accept: "application/json" } });
          if (r.ok) {
            const j = (await r.json()) as { allowed?: boolean; code?: string | null };
            setEligibility({ allowed: j.allowed !== false, code: j.code ?? null });
          }
        } catch {
          // the server checks eligibility on every routed action; this read only explains a refusal early
        }
      } catch (e) {
        setConnectError((e as Error).message || "The wallet did not connect.");
      }
    },
    [apiFetch, cfg],
  );

  const session: Session = {
    cfg,
    wallets,
    findWallets,
    connect,
    connected,
    connectError,
    eligibility,
    client,
    wallet: walletSigner,
    keystore,
    api,
    venues,
    setVenue: (v, s) => setVenues((old) => ({ ...old, [v]: s })),
    receipts,
    addReceipt: (r) => setReceipts((old) => (old.some((x) => x.receiptId === r.receiptId) ? old : [r, ...old])),
    confirm,
    answerConfirm(ok, reason) {
      lastDecline.current = ok ? null : (reason ?? "cancelled");
      setConfirm((c) => (ok && c ? { ...c, answered: true } : null));
      const r = resolver.current;
      resolver.current = null;
      r?.(ok);
    },
    clearConfirm: () => setConfirm(null),
    lastDecline,
    onboardingVenue,
    prompts,
    policyDraft,
    setPolicyDraft,
    apiKey,
    setApiKey,
    ...(deps.onPrompt ? { onPrompt: deps.onPrompt } : {}),
  };
  return <Ctx.Provider value={session}>{children}</Ctx.Provider>;
}
