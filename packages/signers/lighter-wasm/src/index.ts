// @capstan/signer-lighter-wasm: a safe TypeScript wrapper around the lighter-go `wasm/` signer, built reproducibly
// from a pinned commit (build/build.sh) and committed with its sha256 (artifacts/SHA256SUMS).
//
// Rules this wrapper keeps:
// - Trade-only surface: create order, cancel, cancel all, ChangePubKey (key registration), zero-fee ApproveIntegrator
//   and auth tokens. No transfer, withdraw, sub-account, pool, stake or margin function is reachable from here, even
//   though the WASM has them.
// - One instance = one Worker = one Go runtime = one signing chain id (the WASM keeps a global chain id).
// - Every call carries an explicit nonce: -1 would make Go fetch one over HTTP, which cannot work inside WASM.
// - The API private key stays inside the Worker. It crosses the boundary only through exportEncrypted, straight
//   into the caller's wrap function.
// - The wasm bytes and wasm_exec.js are hashed before use; a mismatch refuses to start.
// - Lazy: importing this module loads no WASM; createLighterSigner / createLighterHasher do.
//
// This file uses only erasable TypeScript syntax and no relative imports, so Node (type stripping) and Bun load it
// as is (test/timing-node.mjs relies on that).

export type LighterChainId = 304 | 466324 | 300;

export interface LighterOrderArgs {
  marketIndex: number;
  clientOrderIndex: number;
  baseAmount: number;
  price: number;
  isAsk: boolean;
  orderType: 0 | 1 | 2 | 3 | 4 | 5;
  timeInForce: 0 | 1 | 2;
  reduceOnly: boolean;
  triggerPrice: number;
  orderExpiry: number;
  integratorAccountIndex: number;
  integratorTakerFee: 0;
  integratorMakerFee: 0;
  selfTradeBehaviorMode: number;
  selfTradeEqualityMode: number;
  nonce: number;
  apiKeyIndex: number;
  accountIndex: number;
  /** Tx expiry (ms). lighter-go otherwise uses now + 10 min - 1 s; set it so a build and its hash agree. */
  expiredAt?: number;
}

export interface LighterCancelArgs {
  marketIndex: number;
  orderIndex: number;
  nonce: number;
  apiKeyIndex: number;
  accountIndex: number;
  expiredAt?: number;
}

export interface LighterCancelAllArgs {
  timeInForce: number;
  time: number;
  marketIndex: number;
  nonce: number;
  apiKeyIndex: number;
  accountIndex: number;
  expiredAt?: number;
}

export interface LighterChangePubKeyArgs {
  pubKeyHex: string;
  nonce: number;
  apiKeyIndex: number;
  accountIndex: number;
  expiredAt?: number;
}

export interface LighterApproveIntegratorArgs {
  integratorAccountIndex: number;
  maxPerpsTakerFee: 0;
  maxPerpsMakerFee: 0;
  maxSpotTakerFee: 0;
  maxSpotMakerFee: 0;
  approvalExpiryMs: number;
  nonce: number;
  apiKeyIndex: number;
  accountIndex: number;
  expiredAt?: number;
}

export interface LighterSigner {
  readonly chainId: LighterChainId;
  generateApiKey(): { publicKey: string };
  exportEncrypted(wrap: (raw: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array>;
  importEncrypted(blob: Uint8Array, unwrap: (b: Uint8Array) => Promise<Uint8Array>, accountIndex: number, apiKeyIndex: number): Promise<void>;
  signChangePubKey(a: LighterChangePubKeyArgs): Promise<{ txType: 8; txInfo: string; messageToSign: string; txHash: string }>;
  signCreateOrder(o: LighterOrderArgs): Promise<{ txType: 14; txInfo: string; txHash: string }>;
  signCancelOrder(a: LighterCancelArgs): Promise<{ txType: 15; txInfo: string; txHash: string }>;
  signCancelAll(a: LighterCancelAllArgs): Promise<{ txType: 16; txInfo: string; txHash: string }>;
  signApproveIntegrator(a: LighterApproveIntegratorArgs): Promise<{ txType: 45; txInfo: string; messageToSign?: string }>;
  createAuthToken(deadlineS: number, apiKeyIndex: number, accountIndex: number): Promise<string>;
  close(): void;
}

export interface LighterHasher {
  txHashForOrder(o: LighterOrderArgs): Promise<string>;
  txHashForCancel(a: LighterCancelArgs): Promise<string>;
  close(): void;
}

export interface LighterWasmOptions {
  /** Where to load lighter-signer.wasm from (file: or http(s): URL). Default: the committed artifact. */
  wasmUrl?: string | URL;
  /** Where to load wasm_exec.js from. Default: the committed artifact. */
  wasmExecUrl?: string | URL;
  /** Worker script URL, for bundlers that relocate src/worker.mjs. */
  workerUrl?: string | URL;
  /** Audit and test hook: sees every message that crosses the Worker boundary, in both directions. */
  inspect?: (direction: "to-worker" | "from-worker", message: unknown) => void;
}

/** sha256 of artifacts/lighter-signer.wasm (also in artifacts/SHA256SUMS; build/build.sh reproduces it). */
export const WASM_SHA256 = "eb70331474e4e6b9b241e0e06297c2d407e1b0e24e5184ff6d31b3e588d90a70";
/** sha256 of artifacts/wasm_exec.js from the pinned Go 1.26.8 toolchain. */
export const WASM_EXEC_SHA256 = "0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14";
export const LIGHTER_GO_COMMIT = "aefa96848a105d82a6bbb55d3d05663293a71713";

const CHAIN_IDS: readonly number[] = [304, 466324, 300];
const MAX_48 = 2 ** 48 - 1; // lighter-go MaxTimestamp, MaxMarketIndex, MaxOrderBaseAmount; nonce absolute cap
const MAX_ACCOUNT_INDEX = 2 ** 48 - 2;
const MAX_U32 = 2 ** 32 - 1;
const MAX_AUTH_TOKEN_S = 8 * 3600; // venue cap on auth token lifetime

class SignerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerInputError";
  }
}

function int(name: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new SignerInputError(`${name} must be an integer in [${min}, ${max}], got ${String(v)}`);
  }
  return v;
}

function nonceOf(v: unknown): number {
  if (v === undefined || v === null || v === -1) throw new SignerInputError("an explicit nonce is required (undefined and -1 are refused)");
  return int("nonce", v, 0, MAX_48);
}

function keyRef(apiKeyIndex: unknown, accountIndex: unknown): void {
  int("apiKeyIndex", apiKeyIndex, 0, 254);
  int("accountIndex", accountIndex, 1, MAX_ACCOUNT_INDEX);
}

function expiry(v: unknown): void {
  if (v !== undefined) int("expiredAt", v, 1, MAX_48);
}

function checkOrder(o: LighterOrderArgs): void {
  if (!o || typeof o !== "object") throw new SignerInputError("order args missing");
  nonceOf(o.nonce);
  keyRef(o.apiKeyIndex, o.accountIndex);
  expiry(o.expiredAt);
  int("marketIndex", o.marketIndex, 0, MAX_48);
  int("clientOrderIndex", o.clientOrderIndex, 0, MAX_48);
  int("baseAmount", o.baseAmount, 1, MAX_48);
  int("price", o.price, 1, MAX_U32);
  int("triggerPrice", o.triggerPrice, 0, MAX_U32);
  int("orderType", o.orderType, 0, 5);
  int("timeInForce", o.timeInForce, 0, 2);
  // 0 means "none" (IOC); -1 is refused because lighter-go would turn it into now + 28 days
  int("orderExpiry", o.orderExpiry, 0, MAX_48);
  int("integratorAccountIndex", o.integratorAccountIndex, 0, MAX_ACCOUNT_INDEX);
  if (o.integratorTakerFee !== 0 || o.integratorMakerFee !== 0) throw new SignerInputError("integrator fees must be 0 in v1 (zero-fee attribution)");
  // lighter-go txtypes: behavior 0 expire maker (default), 1 expire taker, 2 cancel both, 3 reduce;
  // equality 0 same account index (default), 1 same master account; reduce + master is refused by the venue
  int("selfTradeBehaviorMode", o.selfTradeBehaviorMode, 0, 3);
  int("selfTradeEqualityMode", o.selfTradeEqualityMode, 0, 1);
  if (o.selfTradeBehaviorMode === 3 && o.selfTradeEqualityMode === 1) throw new SignerInputError("self-trade reduce mode is not allowed with master-account equality");
  if (typeof o.isAsk !== "boolean" || typeof o.reduceOnly !== "boolean") throw new SignerInputError("isAsk and reduceOnly must be booleans");
}

function checkCancel(a: LighterCancelArgs): void {
  if (!a || typeof a !== "object") throw new SignerInputError("cancel args missing");
  nonceOf(a.nonce);
  keyRef(a.apiKeyIndex, a.accountIndex);
  expiry(a.expiredAt);
  int("marketIndex", a.marketIndex, 0, MAX_48);
  // a client order index (1 .. 2^48 - 1) or a venue order index (2^48 .. 2^60 - 1, lighter-go MinOrderIndex and
  // MaxOrderIndex); live venue indexes sit near 2^48 and 2^49, so the JS-safe range is the cap here
  int("orderIndex", a.orderIndex, 1, Number.MAX_SAFE_INTEGER);
}

function orderFields(o: LighterOrderArgs): LighterOrderArgs {
  const { marketIndex, clientOrderIndex, baseAmount, price, isAsk, orderType, timeInForce, reduceOnly, triggerPrice, orderExpiry, integratorAccountIndex, integratorTakerFee, integratorMakerFee, selfTradeBehaviorMode, selfTradeEqualityMode, nonce, apiKeyIndex, accountIndex, expiredAt } = o;
  return { marketIndex, clientOrderIndex, baseAmount, price, isAsk, orderType, timeInForce, reduceOnly, triggerPrice, orderExpiry, integratorAccountIndex, integratorTakerFee, integratorMakerFee, selfTradeBehaviorMode, selfTradeEqualityMode, nonce, apiKeyIndex, accountIndex, ...(expiredAt !== undefined ? { expiredAt } : {}) };
}

function cancelFields(a: LighterCancelArgs): LighterCancelArgs {
  const { marketIndex, orderIndex, nonce, apiKeyIndex, accountIndex, expiredAt } = a;
  return { marketIndex, orderIndex, nonce, apiKeyIndex, accountIndex, ...(expiredAt !== undefined ? { expiredAt } : {}) };
}

// ------------------------------------------------------------------------------------------------ loading

const isNodeLike = (): boolean => typeof process !== "undefined" && !!process.versions && !!process.versions.node;

async function loadBytes(url: string | URL): Promise<Uint8Array> {
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.protocol === "file:" && isNodeLike()) {
    const fs = await import("node:fs/promises");
    return new Uint8Array(await fs.readFile(u));
  }
  const res = await fetch(u);
  if (!res.ok) throw new Error(`lighter-wasm: GET ${u.href} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Load and verify both artifacts. Throws before any Worker starts when a hash differs. */
async function loadVerifiedArtifacts(opts: LighterWasmOptions = {}): Promise<{ wasm: Uint8Array; wasmExecSource: string }> {
  const wasmUrl = opts.wasmUrl ?? new URL("../artifacts/lighter-signer.wasm", import.meta.url);
  const execUrl = opts.wasmExecUrl ?? new URL("../artifacts/wasm_exec.js", import.meta.url);
  const [wasm, exec] = await Promise.all([loadBytes(wasmUrl), loadBytes(execUrl)]);
  const [ws, es] = await Promise.all([sha256Hex(wasm), sha256Hex(exec)]);
  if (ws !== WASM_SHA256) throw new Error(`lighter-wasm: refusing to start, lighter-signer.wasm sha256 ${ws} is not the pinned ${WASM_SHA256}`);
  if (es !== WASM_EXEC_SHA256) throw new Error(`lighter-wasm: refusing to start, wasm_exec.js sha256 ${es} is not the pinned ${WASM_EXEC_SHA256}`);
  return { wasm, wasmExecSource: new TextDecoder().decode(exec) };
}

// ------------------------------------------------------------------------------------------------ worker RPC

interface Rpc {
  call<T>(op: string, args?: unknown, transfer?: ArrayBuffer[]): Promise<T>;
  terminate(): void;
}

interface WorkerLike {
  postMessage(m: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): unknown;
  /** Node: keep the process alive only while a call is in flight. */
  hold(busy: boolean): void;
}

async function spawnWorker(opts: LighterWasmOptions, onMessage: (m: unknown) => void): Promise<WorkerLike> {
  const url = opts.workerUrl ? new URL(String(opts.workerUrl)) : new URL("./worker.mjs", import.meta.url);
  if (isNodeLike()) {
    const wt = await import("node:worker_threads");
    const w = new wt.Worker(url);
    w.on("message", onMessage);
    w.unref(); // an idle signer never keeps the process alive; hold() refs it while a call is in flight
    return { postMessage: (m, t) => w.postMessage(m, (t ?? []) as never), terminate: () => w.terminate(), hold: (busy) => (busy ? w.ref() : w.unref()) };
  }
  const w = new Worker(url, { type: "module" });
  w.onmessage = (ev: MessageEvent) => onMessage(ev.data);
  return { postMessage: (m, t) => w.postMessage(m, t ?? []), terminate: () => w.terminate(), hold: () => undefined };
}

async function startRpc(opts: LighterWasmOptions): Promise<Rpc> {
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 1;
  let dead = false;
  const onMessage = (m: unknown) => {
    opts.inspect?.("from-worker", m);
    const msg = m as { id: number; ok: boolean; result?: unknown; error?: string };
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (waiting.size === 0) worker.hold(false);
    if (msg.ok) w.resolve(msg.result);
    else w.reject(new Error(`lighter-wasm: ${msg.error}`));
  };
  const worker: WorkerLike = await spawnWorker(opts, onMessage);
  return {
    call<T>(op: string, args?: unknown, transfer?: ArrayBuffer[]): Promise<T> {
      if (dead) return Promise.reject(new Error("lighter-wasm: instance is closed"));
      const id = next++;
      const message = { id, op, args };
      opts.inspect?.("to-worker", message);
      return new Promise<T>((resolve, reject) => {
        waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
        if (waiting.size === 1) worker.hold(true);
        worker.postMessage(message, transfer);
      });
    },
    terminate() {
      dead = true;
      for (const w of waiting.values()) w.reject(new Error("lighter-wasm: instance is closed"));
      waiting.clear();
      void worker.terminate();
    },
  };
}

async function boot(chainId: LighterChainId, mode: "signer" | "hasher", opts: LighterWasmOptions): Promise<{ rpc: Rpc; pendingPublicKey: string | null }> {
  if (!CHAIN_IDS.includes(chainId)) throw new SignerInputError(`unknown Lighter signing chain id ${String(chainId)}`);
  const { wasm, wasmExecSource } = await loadVerifiedArtifacts(opts);
  const rpc = await startRpc(opts);
  const buf = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer;
  try {
    const r = await rpc.call<{ pendingPublicKey?: string }>("boot", { wasm: buf, wasmExecSource, chainId, mode }, [buf]);
    return { rpc, pendingPublicKey: r.pendingPublicKey ?? null };
  } catch (e) {
    rpc.terminate();
    throw e;
  }
}

function expectType<T extends number>(r: { txType: number }, t: T, op: string): void {
  if (r.txType !== t) throw new Error(`lighter-wasm: ${op} returned txType ${r.txType}, expected ${t}`);
}

/** Start a signer for one Lighter signing chain id, in its own Worker. */
export async function createLighterSigner(chainId: LighterChainId, opts: LighterWasmOptions = {}): Promise<LighterSigner> {
  const { rpc, pendingPublicKey } = await boot(chainId, "signer", opts);
  let pending: string | null = pendingPublicKey;
  let hasKey = false;
  const requireKey = () => {
    if (!hasKey) throw new SignerInputError("no API key: call generateApiKey() or importEncrypted() first");
  };

  const signer: LighterSigner = {
    chainId,
    generateApiKey() {
      if (pending === null) throw new SignerInputError("the next key is still being made; retry in a moment");
      const publicKey = pending;
      pending = null;
      hasKey = true;
      // ordered after every earlier message and before every later one, so later signs use this key
      void rpc.call<{ pendingPublicKey: string }>("commitKey").then(
        (r) => (pending = r.pendingPublicKey),
        () => undefined,
      );
      return { publicKey };
    },
    async exportEncrypted(wrap) {
      requireKey();
      const r = await rpc.call<{ raw: ArrayBuffer }>("exportRaw");
      const raw = new Uint8Array(r.raw);
      try {
        return await wrap(raw);
      } finally {
        raw.fill(0);
      }
    },
    async importEncrypted(blob, unwrap, accountIndex, apiKeyIndex) {
      keyRef(apiKeyIndex, accountIndex);
      const raw = await unwrap(blob);
      if (!(raw instanceof Uint8Array) || raw.length !== 40) throw new SignerInputError("unwrapped key must be 40 bytes");
      const copy = raw.slice();
      raw.fill(0);
      await rpc.call("importKey", { raw: copy.buffer, apiKeyIndex, accountIndex }, [copy.buffer]);
      hasKey = true;
    },
    async signChangePubKey(a) {
      nonceOf(a?.nonce);
      keyRef(a.apiKeyIndex, a.accountIndex);
      expiry(a.expiredAt);
      if (typeof a.pubKeyHex !== "string" || !/^0x[0-9a-fA-F]{80}$/.test(a.pubKeyHex)) throw new SignerInputError("pubKeyHex must be 0x + 80 hex characters");
      requireKey();
      const r = await rpc.call<{ txType: number; txInfo: string; messageToSign: string; txHash: string }>("signChangePubKey", {
        pubKeyHex: a.pubKeyHex,
        nonce: a.nonce,
        apiKeyIndex: a.apiKeyIndex,
        accountIndex: a.accountIndex,
        ...(a.expiredAt !== undefined ? { expiredAt: a.expiredAt } : {}),
      });
      expectType(r, 8, "signChangePubKey");
      return { txType: 8, txInfo: r.txInfo, messageToSign: r.messageToSign, txHash: r.txHash };
    },
    async signCreateOrder(o) {
      checkOrder(o);
      requireKey();
      const r = await rpc.call<{ txType: number; txInfo: string; txHash: string }>("signCreateOrder", orderFields(o));
      expectType(r, 14, "signCreateOrder");
      return { txType: 14, txInfo: r.txInfo, txHash: r.txHash };
    },
    async signCancelOrder(a) {
      checkCancel(a);
      requireKey();
      const r = await rpc.call<{ txType: number; txInfo: string; txHash: string }>("signCancelOrder", cancelFields(a));
      expectType(r, 15, "signCancelOrder");
      return { txType: 15, txInfo: r.txInfo, txHash: r.txHash };
    },
    async signCancelAll(a) {
      nonceOf(a?.nonce);
      keyRef(a.apiKeyIndex, a.accountIndex);
      expiry(a.expiredAt);
      int("timeInForce", a.timeInForce, 0, 2);
      int("time", a.time, 0, MAX_48);
      int("marketIndex", a.marketIndex, 0, MAX_48);
      requireKey();
      const { timeInForce, time, marketIndex, nonce, apiKeyIndex, accountIndex, expiredAt } = a;
      const r = await rpc.call<{ txType: number; txInfo: string; txHash: string }>("signCancelAll", { timeInForce, time, marketIndex, nonce, apiKeyIndex, accountIndex, ...(expiredAt !== undefined ? { expiredAt } : {}) });
      expectType(r, 16, "signCancelAll");
      return { txType: 16, txInfo: r.txInfo, txHash: r.txHash };
    },
    async signApproveIntegrator(a) {
      nonceOf(a?.nonce);
      keyRef(a.apiKeyIndex, a.accountIndex);
      expiry(a.expiredAt);
      if (a.maxPerpsTakerFee !== 0 || a.maxPerpsMakerFee !== 0 || a.maxSpotTakerFee !== 0 || a.maxSpotMakerFee !== 0) {
        throw new SignerInputError("ApproveIntegrator fees must all be 0 in v1 (zero-fee attribution)");
      }
      int("integratorAccountIndex", a.integratorAccountIndex, 1, MAX_ACCOUNT_INDEX);
      int("approvalExpiryMs", a.approvalExpiryMs, 0, MAX_48);
      requireKey();
      const { integratorAccountIndex, approvalExpiryMs, nonce, apiKeyIndex, accountIndex, expiredAt } = a;
      const r = await rpc.call<{ txType: number; txInfo: string; messageToSign?: string }>("signApproveIntegrator", {
        integratorAccountIndex,
        maxPerpsTakerFee: 0,
        maxPerpsMakerFee: 0,
        maxSpotTakerFee: 0,
        maxSpotMakerFee: 0,
        approvalExpiryMs,
        nonce,
        apiKeyIndex,
        accountIndex,
        ...(expiredAt !== undefined ? { expiredAt } : {}),
      });
      expectType(r, 45, "signApproveIntegrator");
      return { txType: 45, txInfo: r.txInfo, ...(r.messageToSign ? { messageToSign: r.messageToSign } : {}) };
    },
    async createAuthToken(deadlineS, apiKeyIndex, accountIndex) {
      keyRef(apiKeyIndex, accountIndex);
      const nowS = Math.floor(Date.now() / 1000);
      int("deadlineS", deadlineS, nowS + 1, nowS + MAX_AUTH_TOKEN_S);
      requireKey();
      const r = await rpc.call<{ authToken: string }>("createAuthToken", { deadlineS, apiKeyIndex, accountIndex });
      return r.authToken;
    },
    close() {
      rpc.terminate();
    },
  };
  return Object.freeze(signer);
}

/**
 * A hash-only instance: the txHash is the pre-signature hash, which depends on the tx fields and the chain id, not on
 * the key. An ephemeral random key made inside the Worker signs and the signature is thrown away; the key is never
 * registered, exported or posted.
 */
export async function createLighterHasher(chainId: LighterChainId, opts: LighterWasmOptions = {}): Promise<LighterHasher> {
  const { rpc } = await boot(chainId, "hasher", opts);
  const hasher: LighterHasher = {
    async txHashForOrder(o) {
      checkOrder(o);
      return (await rpc.call<{ txHash: string }>("txHashForOrder", orderFields(o))).txHash;
    },
    async txHashForCancel(a) {
      checkCancel(a);
      return (await rpc.call<{ txHash: string }>("txHashForCancel", cancelFields(a))).txHash;
    },
    close() {
      rpc.terminate();
    },
  };
  return Object.freeze(hasher);
}
