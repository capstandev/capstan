// fileKeyStore (Bun or Node bot hosts): one JSON file, mode 600. The wrapping key is scrypt(passphrase, salt,
// N = 2^17, r = 8, p = 1) imported into WebCrypto as a non-extractable AES-256-GCM key. A check record sealed under it
// tells a wrong passphrase apart without revealing anything: every failure is the same UNLOCK_FAILED message.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { scrypt } from "node:crypto";
import { b64decode, b64encode } from "../bytes";
import { SdkError } from "../errors";
import { defaultRandom } from "./secp";
import type { KeyStore, KeyStoreOptions } from "./types";
import { aesGcmSealer, vaultKeyStore, type RecordBackend, type SealedRecord, type Sealer } from "./vault";

export const SCRYPT_N = 2 ** 17;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const MIN_PASSPHRASE = 12;
const CHECK_TEXT = "capstan-keystore-check-v1";
const CHECK_AAD = new TextEncoder().encode("capstan-keystore-check");

interface KeyFile {
  v: 1;
  kdf: { alg: "scrypt"; N: number; r: number; p: number; salt: string };
  check: string;
  records: SealedRecord[];
}

function deriveKey(pass: string, salt: Uint8Array, N: number, r: number, p: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    scrypt(pass.normalize("NFKC"), salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(new Uint8Array(key)))),
  );
}

async function importAes(raw: Uint8Array): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

function writeAtomic600(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function fileKeyStore(path: string, passphrase: () => Promise<string>, opts: KeyStoreOptions = {}): KeyStore {
  const random = opts.random ?? defaultRandom;
  let unlocked: Promise<{ sealer: Sealer; file: KeyFile }> | null = null;

  async function unlock(): Promise<{ sealer: Sealer; file: KeyFile }> {
    if (existsSync(path)) {
      let file: KeyFile;
      try {
        file = JSON.parse(readFileSync(path, "utf8")) as KeyFile;
        if (file.v !== 1 || file.kdf?.alg !== "scrypt" || !Array.isArray(file.records)) throw new Error("format");
      } catch {
        throw new SdkError("UNLOCK_FAILED", "could not unlock the key file");
      }
      if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
      const pass = await passphrase();
      const key = await importAes(await deriveKey(pass, b64decode(file.kdf.salt), file.kdf.N, file.kdf.r, file.kdf.p));
      const sealer = aesGcmSealer(key, random);
      try {
        const txt = new TextDecoder().decode(await sealer.open(b64decode(file.check), CHECK_AAD));
        if (txt !== CHECK_TEXT) throw new Error("check");
      } catch {
        throw new SdkError("UNLOCK_FAILED", "could not unlock the key file");
      }
      return { sealer, file };
    }
    const pass = await passphrase();
    if (typeof pass !== "string" || [...pass].length < MIN_PASSPHRASE) throw new SdkError("WEAK_PASSPHRASE", `the passphrase must be at least ${MIN_PASSPHRASE} characters`);
    const salt = random(16);
    const key = await importAes(await deriveKey(pass, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P));
    const sealer = aesGcmSealer(key, random);
    const file: KeyFile = { v: 1, kdf: { alg: "scrypt", N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: b64encode(salt) }, check: b64encode(await sealer.seal(new TextEncoder().encode(CHECK_TEXT), CHECK_AAD)), records: [] };
    writeAtomic600(path, JSON.stringify(file));
    return { sealer, file };
  }

  const getUnlocked = () => {
    if (!unlocked) {
      unlocked = unlock();
      unlocked.catch(() => (unlocked = null));
    }
    return unlocked;
  };

  const backend: RecordBackend = {
    async load() {
      await getUnlocked();
      const f = JSON.parse(readFileSync(path, "utf8")) as KeyFile;
      return f.records;
    },
    async save(records) {
      const { file } = await getUnlocked();
      const cur = JSON.parse(readFileSync(path, "utf8")) as KeyFile;
      writeAtomic600(path, JSON.stringify({ ...cur, kdf: file.kdf, check: cur.check, records }));
    },
  };
  return vaultKeyStore(backend, async () => (await getUnlocked()).sealer, opts);
}
