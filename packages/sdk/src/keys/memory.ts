// memoryKeyStore: for tests and short-lived agents only. Records are still sealed with a non-extractable AES-GCM key
// that lives only in this process; nothing survives a restart.
import type { KeyStore, KeyStoreOptions } from "./types";
import { aesGcmSealer, memoryBackend, newWrappingKey, vaultKeyStore, type Sealer } from "./vault";

export function memoryKeyStore(opts: KeyStoreOptions = {}): KeyStore {
  let sealer: Promise<Sealer> | null = null;
  return vaultKeyStore(memoryBackend(), () => (sealer ??= newWrappingKey().then((k) => aesGcmSealer(k))), opts);
}
