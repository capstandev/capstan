// Dashboard test harness: the SDK's local stack (a fake Hyperliquid venue and a stand-in API running the REAL
// Hyperliquid adapter and the REAL receipts library), an EIP-1193 test wallet over a seed-derived test key, the
// browser key store on an in-memory IndexedDB, and the dashboard mounted at a path.
import { Route, Routes } from "react-router";
import { fakeIndexedDB } from "../../../packages/sdk/test/fake-idb";
import { BUILDER_ASTER, BUILDER_HL, T0, testKey } from "../../../packages/sdk/test/helpers";
import { hlTemplatePin, startStack, type StackOptions } from "../../../packages/sdk/test/stack";
import { addressOfSecret, personalDigest, signDigestRsv } from "../../../packages/sdk/src/keys/secp";
import { asterTemplateHash } from "../../../packages/sdk/src/onboard";
import { Dashboard } from "../../src/app/Dashboard";
import type { SpreadsDeps } from "../../src/app/screens/Spreads";
import type { DiscoveredWallet } from "../../src/app/wallet";
import type { AppConfig } from "../../src/config";
import { browserKeyStore, PINS, typedDataDigest, type Eip1193Provider, type Hex, type KeyStore, type PinsOverride } from "../../src/lib/capstan";
import { byText, click, mount, waitFor, type Mounted } from "../helpers";

export { T0 };

export interface WalletCall {
  method: string;
  params: unknown[];
  primaryType?: string;
}

export interface TestWallet extends DiscoveredWallet {
  owner: Hex;
  calls: WalletCall[];
  /** Sign requests only (typed data and messages). */
  signs(): WalletCall[];
  chainId: number;
  /** Make the wallet refuse (code 4001) when asked to sign a typed-data type matching this. */
  rejectType: RegExp | null;
}

/** An EIP-1193 wallet over a seed-derived test key (never a real key). Records every request. */
export function testWallet(o: { label?: string; chainId?: number; name?: string } = {}): TestWallet {
  const sk = testKey(o.label ?? "owner"); // test-key (seed-derived)
  const owner = addressOfSecret(sk).toLowerCase() as Hex;
  const calls: WalletCall[] = [];
  const w: TestWallet = {
    owner,
    calls,
    chainId: o.chainId ?? 42161,
    rejectType: null,
    signs: () => calls.filter((c) => c.method === "eth_signTypedData_v4" || c.method === "personal_sign"),
    info: { uuid: `test-${o.label ?? "owner"}`, name: o.name ?? "Test Wallet", icon: "data:image/svg+xml,", rdns: "test.capstan" },
    provider: {
      async request({ method, params = [] }) {
        const call: WalletCall = { method, params };
        calls.push(call);
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [owner];
        if (method === "eth_chainId") return `0x${w.chainId.toString(16)}`;
        if (method === "eth_signTypedData_v4") {
          const td = JSON.parse(String(params[1])) as { types: Record<string, unknown>; domain: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
          call.primaryType = td.primaryType;
          if (w.rejectType?.test(td.primaryType)) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          const { EIP712Domain: _d, ...types } = td.types;
          return signDigestRsv(typedDataDigest({ ...td, types } as never), sk);
        }
        if (method === "personal_sign") {
          const hex = String(params[0]).slice(2);
          const text = new TextDecoder().decode(Uint8Array.from(hex.match(/../g)!.map((b) => Number.parseInt(b, 16))));
          return signDigestRsv(personalDigest(text), sk);
        }
        throw Object.assign(new Error(`unsupported method ${method}`), { code: 4200 });
      },
    } as Eip1193Provider,
  };
  return w;
}

/** The pins the stack's bundles need (template hashes, builders, receipt signer), as the SDK's own tests set them. */
export async function stackPins(stack: Awaited<ReturnType<typeof startStack>>, policy?: unknown): Promise<PinsOverride> {
  const hl = [await hlTemplatePin(stack.apiBase)];
  if (policy) hl.push(await hlTemplatePin(stack.apiBase, policy));
  return {
    networks: {
      mainnet: {
        ...PINS.networks.mainnet,
        builders: { hyperliquid: BUILDER_HL, aster: BUILDER_ASTER },
        templateHashes: { ...PINS.networks.mainnet.templateHashes, hyperliquid: hl, aster: [asterTemplateHash(BUILDER_ASTER, "Mainnet", "0.0003")] },
        receiptSigners: [{ address: stack.receiptSigner }],
      },
    },
  } as PinsOverride;
}

async function cleanPins(policy?: unknown): Promise<PinsOverride> {
  const clean = await startStack();
  try {
    return await stackPins(clean, policy);
  } finally {
    clean.stop();
  }
}

export interface Dash {
  m: Mounted;
  stack: Awaited<ReturnType<typeof startStack>>;
  wallet: TestWallet;
  keystore: KeyStore;
  idb: ReturnType<typeof fakeIndexedDB>;
  /** DOM text at each wallet prompt, in order. */
  atPrompt: { kind: string; text: string }[];
  requests: { url: string; method: string; headers: Record<string, string>; body: string; response?: unknown }[];
  random: Uint8Array[];
  stop(): Promise<void>;
}

export interface DashOptions {
  path?: string;
  stack?: StackOptions;
  wallet?: TestWallet;
  config?: Partial<AppConfig>;
  /** Answer some API paths here (the stack has no spreads or risk routes). Return undefined to pass through. */
  intercept?: (url: URL, init: RequestInit | undefined) => Promise<Response | undefined> | Response | undefined;
  spreads?: SpreadsDeps;
  policy?: unknown;
}

export async function startDash(o: DashOptions = {}): Promise<Dash> {
  const stack = await startStack(o.stack ?? {});
  const wallet = o.wallet ?? testWallet();
  const idb = fakeIndexedDB();
  const random: Uint8Array[] = [];
  const keystore = browserKeyStore({
    indexedDB: idb,
    random: (n) => {
      const b = crypto.getRandomValues(new Uint8Array(n));
      random.push(b.slice());
      return b;
    },
  });
  const requests: Dash["requests"] = [];
  const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (h[k] = v));
    const rec: Dash["requests"][number] = { url, method: init?.method ?? "GET", headers: h, body: typeof init?.body === "string" ? init.body : "" };
    requests.push(rec);
    const local = o.intercept ? await o.intercept(new URL(url), init) : undefined;
    const res = local ?? (await fetch(input, init));
    try {
      rec.response = await res.clone().json();
    } catch {
      rec.response = undefined;
    }
    return res;
  }) as typeof fetch;
  // pins come from an untampered stack (a tampered one plays a compromised server; the pins are the SDK release's)
  const pinned = o.stack?.tamper ? await cleanPins(o.policy) : await stackPins(stack, o.policy);
  const atPrompt: Dash["atPrompt"] = [];
  let host: HTMLElement | null = null;
  const m = await mount(
    <Routes>
      <Route path="/app/*" element={<Dashboard deps={{ discover: async () => [wallet], onPrompt: (kind) => atPrompt.push({ kind, text: host?.textContent ?? "" }) }} {...(o.spreads ? { spreads: o.spreads } : {})} />} />
    </Routes>,
    {
      path: o.path ?? "/app",
      config: { apiBase: stack.apiBase, network: "mainnet", pinned, venueHosts: { hyperliquid: stack.venue.url, aster: stack.aster.url }, now: () => T0, fetch: spy, keystore: () => keystore, ...(o.config ?? {}) },
    },
  );
  host = m.host;
  return {
    m,
    stack,
    wallet,
    keystore,
    idb,
    atPrompt,
    requests,
    random,
    async stop() {
      await m.unmount();
      stack.stop();
    },
  };
}

export async function connect(d: Dash): Promise<void> {
  const btn = await waitFor(() => byText(d.m.host, "button", `Connect ${d.wallet.info.name}`), "the wallet button");
  await click(btn);
  await waitFor(() => d.m.host.querySelector("[data-connected]"), "connected");
}

export async function go(d: Dash, label: string): Promise<void> {
  await click(byText(d.m.host, "nav[aria-label=Dashboard] a", label) ?? byText(d.m.host, "a", label));
}

/** Connect, open the venue's onboarding screen, start, and stop at the confirm panel. */
export async function toConfirm(d: Dash, venue: "hyperliquid" | "aster" = "hyperliquid"): Promise<HTMLElement> {
  if (!d.m.host.querySelector("[data-connected]")) await connect(d);
  await click(byText(d.m.host, "a", venue === "aster" ? "Aster" : "Hyperliquid"));
  const start = await waitFor(() => byText(d.m.host, "button", "Start onboarding"), "the start button");
  await click(start);
  return waitFor(() => d.m.host.querySelector<HTMLElement>("[data-confirm]") ?? (d.m.host.querySelector<HTMLElement>("[data-onboarding-error]") as HTMLElement | null), "the confirm panel or a refusal");
}

/** Full onboarding: confirm panel, continue, wait for the active delegation. */
export async function onboard(d: Dash, venue: "hyperliquid" | "aster" = "hyperliquid"): Promise<void> {
  const panel = await toConfirm(d, venue);
  if (!panel.hasAttribute("data-confirm")) throw new Error(`onboarding refused: ${panel.textContent}`);
  await click(byText(d.m.host, "button", "Continue to your wallet"));
  await waitFor(() => d.m.host.querySelector("[data-delegation]"), "the active delegation", 15_000);
}
