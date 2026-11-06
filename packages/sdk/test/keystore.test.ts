// R6 and R7: the browser store wraps keys with a non-extractable AES-GCM key; the file store is mode 600, refuses a
// weak passphrase, and a wrong passphrase fails without revealing anything.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { SdkError } from "../src/errors";
import { browserKeyStore } from "../src/keys/browser";
import { fileKeyStore } from "../src/keys/file";
import { memoryKeyStore } from "../src/keys/memory";
import { personalDigest, recoverRsv } from "../src/keys/secp";
import { fakeIndexedDB } from "./fake-idb";

const dir = mkdtempSync(join(tmpdir(), "capstan-sdk-keys-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const digest = personalDigest("capstan keystore test");

/** Records every 48-byte seed the store draws, so the test knows the secret it must never find. */
function recorder() {
  const seeds: Uint8Array[] = [];
  const random = (n: number) => {
    const b = crypto.getRandomValues(new Uint8Array(n));
    if (n === 48) seeds.push(b.slice());
    return b;
  };
  return { random, secrets: () => seeds.map((s) => Buffer.from(secp256k1.utils.randomSecretKey(s)).toString("hex")) };
}

describe("key stores", () => {
  test("non-extractable", async () => {
    const idb = fakeIndexedDB();
    const rec = recorder();
    const ks = browserKeyStore({ indexedDB: idb, random: rec.random });
    const k = await ks.create("hyperliquid", "secp256k1");
    const wrap = idb.dbs.get("capstan-sdk-keys")!.get("meta")!.rows.get("wrap") as CryptoKey;
    expect(wrap).toBeInstanceOf(CryptoKey);
    expect(wrap.extractable).toBe(false);
    expect(wrap.algorithm.name).toBe("AES-GCM");
    await expect(crypto.subtle.exportKey("raw", wrap)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("jwk", wrap)).rejects.toThrow();
    // the record holds ciphertext only
    const rows = [...idb.dbs.get("capstan-sdk-keys")!.get("keys")!.rows.values()];
    const dump = JSON.stringify(rows);
    for (const s of rec.secrets()) expect(dump.toLowerCase()).not.toContain(s);
    expect(dump).not.toContain(Buffer.from(Buffer.from(rec.secrets()[0]!, "hex")).toString("base64"));
    // and it still signs, from a second store instance over the same database (the key survives a reload)
    const again = browserKeyStore({ indexedDB: idb });
    const sig = (await again.sign(k.ref, digest)) as `0x${string}`;
    expect(recoverRsv(digest, sig)).toBe(k.publicPart as `0x${string}`);
    // a stored wrapping key that is extractable is refused
    const idb2 = fakeIndexedDB();
    const bad = browserKeyStore({ indexedDB: idb2 });
    await bad.list();
    idb2.dbs.get("capstan-sdk-keys")!.get("meta")!.rows.set("wrap", await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]));
    const e = (await bad.create("aster", "secp256k1").catch((x) => x)) as SdkError;
    expect(e.code).toBe("UNLOCK_FAILED");
  });

  test("file-store", async () => {
    const path = join(dir, "agent-keys.json");
    // weak passphrase: refused before any file exists
    const weak = fileKeyStore(path, async () => "short-pass");
    expect(((await weak.create("hyperliquid", "secp256k1").catch((x) => x)) as SdkError).code).toBe("WEAK_PASSPHRASE");
    expect(() => statSync(path)).toThrow();

    const pass = "correct horse battery staple";
    const rec = recorder();
    const ks = fileKeyStore(path, async () => pass, { random: rec.random });
    const k = await ks.create("hyperliquid", "secp256k1");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, "utf8");
    for (const s of rec.secrets()) expect(text.toLowerCase()).not.toContain(s);
    expect(JSON.parse(text).kdf).toMatchObject({ alg: "scrypt", N: 131072, r: 8, p: 1 });

    // reopen with the right passphrase: same key signs
    const ok = fileKeyStore(path, async () => pass);
    expect(recoverRsv(digest, (await ok.sign(k.ref, digest)) as `0x${string}`)).toBe(k.publicPart as `0x${string}`);

    // wrong passphrase and a damaged file fail with the same plain message, naming nothing
    const wrong = (await fileKeyStore(path, async () => "correct horse battery stapler").list().catch((x) => x)) as SdkError;
    expect(wrong.code).toBe("UNLOCK_FAILED");
    expect(wrong.message).toBe("could not unlock the key file");
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json", { mode: 0o644 });
    const dmg = (await fileKeyStore(broken, async () => pass).list().catch((x) => x)) as SdkError;
    expect([dmg.code, dmg.message]).toEqual(["UNLOCK_FAILED", "could not unlock the key file"]);
    for (const s of rec.secrets()) expect(`${wrong.message}${wrong.stack}`).not.toContain(s);

    // a group- or world-readable file is tightened back to 600 on open
    const loose = join(dir, "loose.json");
    writeFileSync(loose, text, { mode: 0o644 });
    await fileKeyStore(loose, async () => pass).list();
    expect(statSync(loose).mode & 0o777).toBe(0o600);

    // wipe removes the secret and keeps a tombstone: the address is never made again
    await ok.wipe(k.ref);
    expect(await ok.list()).toEqual([]);
    expect(await ok.usedPublicParts!()).toEqual([k.publicPart.toLowerCase()]);
    expect(((await ok.sign(k.ref, digest).catch((x) => x)) as SdkError).code).toBe("KEY_NOT_FOUND");
  }, 30_000);

  test("the Lighter WASM loads only when a Lighter key is used", async () => {
    let workers = 0;
    let factories = 0;
    const Orig = globalThis.Worker;
    globalThis.Worker = class extends Orig {
      constructor(...a: ConstructorParameters<typeof Worker>) {
        super(...a);
        workers++;
      }
    } as typeof Worker;
    try {
      const ks = memoryKeyStore({ lighter: async () => (factories++, { generateApiKey: () => ({ publicKey: "ab".repeat(40) }), exportEncrypted: async (w) => w(new Uint8Array(40).fill(9)), importEncrypted: async () => undefined, signCreateOrder: async () => ({ txType: 14, txInfo: "{}", txHash: "00" }), signCancelOrder: async () => ({ txType: 15, txInfo: "{}", txHash: "00" }), signChangePubKey: async () => ({ txType: 8, txInfo: "{}", messageToSign: "", txHash: "00" }), signApproveIntegrator: async () => ({ txType: 45, txInfo: "{}" }), close: () => undefined }) });
      const k = await ks.create("hyperliquid", "secp256k1");
      await ks.sign(k.ref, digest);
      expect([workers, factories]).toEqual([0, 0]);
      await ks.create("lighter-rh", "lighter");
      expect(factories).toBe(1);
      ks.close?.();
    } finally {
      globalThis.Worker = Orig;
    }
  });

  test("memory store: key kinds per venue, digest only", async () => {
    const ks = memoryKeyStore();
    expect(((await ks.create("lighter-mainnet", "secp256k1").catch((x) => x)) as SdkError).code).toBe("INVALID_INPUT");
    expect(((await ks.create("hyperliquid", "lighter").catch((x) => x)) as SdkError).code).toBe("INVALID_INPUT");
    expect(((await ks.create("variational", "secp256k1").catch((x) => x)) as SdkError).code).toBe("INVALID_INPUT");
    const k = await ks.create("aster", "secp256k1");
    expect(((await ks.sign(k.ref, "not a digest").catch((x) => x)) as SdkError).code).toBe("INVALID_INPUT");
    expect(((await ks.tag!(k.ref, { x: "ab".repeat(32) }).catch((x) => x)) as SdkError).code).toBe("INVALID_INPUT");
  });
});
