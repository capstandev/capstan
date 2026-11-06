// A small in-memory IndexedDB for Bun (only what browserKeyStore uses: open with upgrade, object stores with an
// optional keyPath, get, put, getAll, clear). Values are kept by reference, as structured clone keeps a CryptoKey.
type Req<T> = { result: T; error: Error | null; onsuccess: (() => void) | null; onerror: (() => void) | null; onupgradeneeded?: (() => void) | null };

function request<T>(fn: () => T): Req<T> {
  const r: Req<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    try {
      r.result = fn();
      r.onsuccess?.();
    } catch (e) {
      r.error = e as Error;
      r.onerror?.();
    }
  });
  return r;
}

class Store {
  readonly rows = new Map<string, unknown>();
  constructor(readonly keyPath: string | null) {}
}

export function fakeIndexedDB(): IDBFactory & { dbs: Map<string, Map<string, Store>> } {
  const dbs = new Map<string, Map<string, Store>>();
  const factory = {
    dbs,
    open(name: string) {
      const isNew = !dbs.has(name);
      if (isNew) dbs.set(name, new Map());
      const stores = dbs.get(name)!;
      const db = {
        objectStoreNames: { contains: (n: string) => stores.has(n) },
        createObjectStore(n: string, o?: { keyPath?: string }) {
          const s = new Store(o?.keyPath ?? null);
          stores.set(n, s);
          return s;
        },
        transaction(n: string) {
          return {
            objectStore(sn: string) {
              const s = stores.get(sn ?? n);
              if (!s) throw new Error(`no store ${sn}`);
              return {
                get: (k: string) => request(() => s.rows.get(k)),
                put: (v: unknown, k?: string) => request(() => void s.rows.set(k ?? String((v as Record<string, unknown>)[s.keyPath!]), v)),
                getAll: () => request(() => [...s.rows.values()]),
                clear: () => request(() => void s.rows.clear()),
              };
            },
          };
        },
      };
      const r: Req<unknown> = { result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        if (isNew) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
  return factory as unknown as IDBFactory & { dbs: Map<string, Map<string, Store>> };
}
