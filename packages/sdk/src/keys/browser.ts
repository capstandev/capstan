// browserKeyStore (spec 4.1): an IndexedDB record of key material wrapped by a WebCrypto AES-GCM key made with
// extractable: false. The CryptoKey object itself is stored in IndexedDB (structured clone keeps it non-extractable),
// so script on the page can use it to sign through this store but can never read the key bytes out.
import { SdkError } from "../errors";
import type { KeyStore, KeyStoreOptions } from "./types";
import { aesGcmSealer, newWrappingKey, vaultKeyStore, type RecordBackend, type SealedRecord, type Sealer } from "./vault";

export const IDB_NAME = "capstan-sdk-keys";
const META = "meta";
const KEYS = "keys";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function openDb(idb: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const o = idb.open(name, 1);
    o.onupgradeneeded = () => {
      const db = o.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS, { keyPath: "ref" });
    };
    o.onsuccess = () => resolve(o.result);
    o.onerror = () => reject(o.error ?? new Error("IndexedDB open failed"));
  });
}

export interface BrowserKeyStoreOptions extends KeyStoreOptions {
  /** IndexedDB factory; default globalThis.indexedDB. */
  indexedDB?: IDBFactory;
  dbName?: string;
}

export function browserKeyStore(opts: BrowserKeyStoreOptions = {}): KeyStore {
  const idb = opts.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => {
    if (!idb) throw new SdkError("UNSUPPORTED", "IndexedDB is not available in this host; use fileKeyStore or a TEE store");
    return (dbp ??= openDb(idb, opts.dbName ?? IDB_NAME));
  };
  let sealer: Promise<Sealer> | null = null;
  const getSealer = () =>
    (sealer ??= (async () => {
      const d = await db();
      let key = (await req(d.transaction(META, "readonly").objectStore(META).get("wrap"))) as CryptoKey | undefined;
      if (!key) {
        key = await newWrappingKey();
        await req(d.transaction(META, "readwrite").objectStore(META).put(key, "wrap"));
      }
      if (key.extractable) throw new SdkError("UNLOCK_FAILED", "the stored wrapping key is extractable; refusing to use it");
      return aesGcmSealer(key, opts.random);
    })());
  const backend: RecordBackend = {
    async load() {
      const d = await db();
      return (await req(d.transaction(KEYS, "readonly").objectStore(KEYS).getAll())) as SealedRecord[];
    },
    async save(records) {
      const d = await db();
      const tx = d.transaction(KEYS, "readwrite");
      const st = tx.objectStore(KEYS);
      await req(st.clear());
      for (const r of records) await req(st.put(r));
    },
  };
  return vaultKeyStore(backend, getSealer, opts);
}
