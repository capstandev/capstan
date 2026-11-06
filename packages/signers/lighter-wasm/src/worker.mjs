// Worker side of @capstan/signer-lighter-wasm. One Worker = one Go runtime = one Lighter signing chain id.
// Runs under node:worker_threads (Bun, Node) or as a browser module Worker. Plain JS so every runtime loads it as is.
//
// The host verifies the sha256 of the wasm bytes and of wasm_exec.js before it sends them here. This file only
// calls the trade functions the host allowlist names: it never calls SignTransfer, SignWithdraw,
// SignCreateSubAccount or any pool, stake or margin function, and never CheckClient (no network inside WASM).
//
// Key handling: the API private key lives in this Worker only. It leaves only on an explicit "exportRaw" request,
// which the host makes inside exportEncrypted and hands straight to the caller's wrap function.

const DUMMY_URL = "http://127.0.0.1:9"; // CreateClient needs a URL; nothing ever dials it (all HTTP is in TS)
const TEN_MIN_MINUS_1S = 10 * 60 * 1000 - 1000; // lighter-go DefaultExpireTime

let port = null; // node:worker_threads parentPort, or null in a browser Worker
const post = (m, transfer) => (port ? port.postMessage(m, transfer ?? []) : self.postMessage(m, transfer ?? []));

let mode = null; // "signer" | "hasher"
let chainId = 0;
let clockOverrideMs = null; // when set, the Go wall clock reads this value (fixes ExpiredAt = value + 10 min - 1 s)
let key = null; // { priv, pub } for the committed key
let pending = null; // next key, made ahead so generateApiKey() can be synchronous on the host
let keyGen = 0;
const clients = new Map(); // "account:apiKey" -> keyGen the Go client was created with

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const h = s.startsWith("0x") ? s.slice(2) : s;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

function goCall(name, args) {
  const fn = globalThis[name];
  if (typeof fn !== "function") throw new Error(`wasm export ${name} missing`);
  const r = fn(...args);
  if (r && typeof r === "object" && r.error) throw new Error(`${name}: ${r.error}`);
  return r;
}

function newKey() {
  const r = goCall("GenerateAPIKey", []);
  return { priv: r.privateKey, pub: r.publicKey };
}

function ensureClient(apiKeyIndex, accountIndex) {
  if (!key) throw new Error("no API key: call generateApiKey() or importEncrypted() first");
  const id = `${accountIndex}:${apiKeyIndex}`;
  if (clients.get(id) === keyGen) return;
  goCall("CreateClient", [DUMMY_URL, key.priv, chainId, apiKeyIndex, accountIndex]);
  clients.set(id, keyGen);
}

/** Run fn with the Go wall clock pinned so that lighter-go computes ExpiredAt === expiredAt exactly. */
function withExpiry(expiredAt, fn) {
  if (expiredAt === undefined || expiredAt === null) return fn();
  clockOverrideMs = expiredAt - TEN_MIN_MINUS_1S;
  try {
    return fn();
  } finally {
    clockOverrideMs = null;
  }
}

async function boot({ wasm, wasmExecSource, chainId: cid, mode: m }) {
  // wasm_exec.js is a classic script that defines globalThis.Go; the host already checked its sha256.
  new Function(wasmExecSource)();
  const go = new globalThis.Go();
  const realWalltime = go.importObject.gojs["runtime.walltime"];
  go.importObject.gojs["runtime.walltime"] = (sp) => {
    if (clockOverrideMs === null) return realWalltime(sp);
    sp >>>= 0;
    const msec = clockOverrideMs;
    const sec = Math.floor(msec / 1000);
    go.mem.setUint32(sp + 8, sec, true);
    go.mem.setUint32(sp + 12, Math.floor(sec / 4294967296), true);
    go.mem.setInt32(sp + 16, (msec % 1000) * 1000000, true);
  };
  const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
  go.run(instance); // never resolves while the program waits for calls
  mode = m;
  chainId = cid;
  if (mode === "hasher") {
    key = newKey(); // ephemeral, never registered, never exported, never posted
    keyGen = 1;
    return {};
  }
  pending = newKey();
  return { pendingPublicKey: pending.pub };
}

const SIGNER_OPS = {
  commitKey() {
    key = pending;
    keyGen++;
    pending = newKey();
    return { pendingPublicKey: pending.pub };
  },
  importKey({ raw, apiKeyIndex, accountIndex }) {
    const bytes = new Uint8Array(raw);
    if (bytes.length !== 40) throw new Error("imported key must be 40 bytes");
    key = { priv: "0x" + hex(bytes), pub: null };
    bytes.fill(0);
    keyGen++;
    ensureClient(apiKeyIndex, accountIndex);
    return {};
  },
  exportRaw() {
    if (!key) throw new Error("no API key to export");
    const raw = unhex(key.priv);
    return { __transfer: raw.buffer, raw: raw.buffer };
  },
  signChangePubKey(a) {
    ensureClient(a.apiKeyIndex, a.accountIndex);
    const r = withExpiry(a.expiredAt, () => goCall("SignChangePubKey", [a.pubKeyHex, 0, a.nonce, a.apiKeyIndex, a.accountIndex]));
    return { txType: r.txType, txInfo: r.txInfo, messageToSign: r.messageToSign, txHash: r.txHash };
  },
  signCreateOrder(o) {
    ensureClient(o.apiKeyIndex, o.accountIndex);
    const r = withExpiry(o.expiredAt, () => goCall("SignCreateOrder", createOrderArgs(o)));
    return { txType: r.txType, txInfo: r.txInfo, txHash: r.txHash };
  },
  signCancelOrder(a) {
    ensureClient(a.apiKeyIndex, a.accountIndex);
    const r = withExpiry(a.expiredAt, () => goCall("SignCancelOrder", cancelArgs(a)));
    return { txType: r.txType, txInfo: r.txInfo, txHash: r.txHash };
  },
  signCancelAll(a) {
    ensureClient(a.apiKeyIndex, a.accountIndex);
    const r = withExpiry(a.expiredAt, () =>
      goCall("SignCancelAllOrders", [a.timeInForce, a.time, a.marketIndex, 0, a.nonce, a.apiKeyIndex, a.accountIndex]),
    );
    return { txType: r.txType, txInfo: r.txInfo, txHash: r.txHash };
  },
  signApproveIntegrator(a) {
    ensureClient(a.apiKeyIndex, a.accountIndex);
    const r = withExpiry(a.expiredAt, () =>
      goCall("SignApproveIntegrator", [
        a.integratorAccountIndex,
        a.maxPerpsTakerFee,
        a.maxPerpsMakerFee,
        a.maxSpotTakerFee,
        a.maxSpotMakerFee,
        a.approvalExpiryMs,
        0,
        a.nonce,
        a.apiKeyIndex,
        a.accountIndex,
      ]),
    );
    return { txType: r.txType, txInfo: r.txInfo, txHash: r.txHash, messageToSign: r.messageToSign };
  },
  createAuthToken({ deadlineS, apiKeyIndex, accountIndex }) {
    ensureClient(apiKeyIndex, accountIndex);
    return { authToken: goCall("CreateAuthToken", [deadlineS, apiKeyIndex, accountIndex]).authToken };
  },
};

const HASHER_OPS = {
  txHashForOrder(o) {
    ensureClient(o.apiKeyIndex, o.accountIndex);
    return { txHash: withExpiry(o.expiredAt, () => goCall("SignCreateOrder", createOrderArgs(o))).txHash };
  },
  txHashForCancel(a) {
    ensureClient(a.apiKeyIndex, a.accountIndex);
    return { txHash: withExpiry(a.expiredAt, () => goCall("SignCancelOrder", cancelArgs(a))).txHash };
  },
};

/** The 19 positional args of SignCreateOrder, in lighter-go wasm/main.go order. skipNonce is always 0 in v1. */
export function createOrderArgs(o) {
  return [
    o.marketIndex,
    o.clientOrderIndex,
    o.baseAmount,
    o.price,
    o.isAsk ? 1 : 0,
    o.orderType,
    o.timeInForce,
    o.reduceOnly ? 1 : 0,
    o.triggerPrice,
    o.orderExpiry,
    o.integratorAccountIndex,
    o.integratorTakerFee,
    o.integratorMakerFee,
    o.selfTradeBehaviorMode,
    o.selfTradeEqualityMode,
    0, // skipNonce
    o.nonce,
    o.apiKeyIndex,
    o.accountIndex,
  ];
}

export function cancelArgs(a) {
  return [a.marketIndex, a.orderIndex, 0, a.nonce, a.apiKeyIndex, a.accountIndex];
}

async function handle(msg) {
  const { id, op, args } = msg;
  try {
    let result;
    if (op === "boot") result = await boot(args);
    else {
      const table = mode === "signer" ? SIGNER_OPS : mode === "hasher" ? HASHER_OPS : null;
      if (!table) throw new Error("worker not booted");
      if (!Object.prototype.hasOwnProperty.call(table, op)) throw new Error(`operation ${op} is not offered by a ${mode}`);
      result = table[op](args);
    }
    const transfer = result && result.__transfer ? [result.__transfer] : [];
    if (result && result.__transfer) delete result.__transfer;
    post({ id, ok: true, result }, transfer);
  } catch (e) {
    post({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

let wt = null;
if (typeof process !== "undefined" && process.versions && process.versions.node) {
  try {
    wt = await import("node:worker_threads");
  } catch {
    wt = null;
  }
}
if (wt && wt.parentPort) {
  port = wt.parentPort;
  port.on("message", (m) => void handle(m));
} else if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.onmessage = (ev) => void handle(ev.data);
}
