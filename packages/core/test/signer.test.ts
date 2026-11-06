// R12, R13: keystore signer and the dev signer chain guard.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, recoverMessageAddress, recoverTypedDataAddress, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { logger } from "../src/logger";
import { decryptKeystore, devSigner, encryptKeystore, keystoreSigner, SignerError } from "../src/signer";

const dir = mkdtempSync(join(tmpdir(), "capstan-signer-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Test-only key material, derived from a public label at run time (never a literal).
const material = keccak256(toHex("capstan signer test vector")); // test-key
const keyBytes = () => Uint8Array.from(Buffer.from(material.slice(2), "hex"));
const expected = privateKeyToAccount(material).address;
const hexBody = material.slice(2);

describe("signer", () => {
  test("keystore", async () => {
    const json = await encryptKeystore(keyBytes(), "correct horse", { n: 1024 });
    const ksPath = join(dir, "ks.json");
    const pwPath = join(dir, "pw");
    const badPath = join(dir, "bad");
    writeFileSync(ksPath, json);
    writeFileSync(pwPath, "correct horse\n");
    writeFileSync(badPath, "wrong horse\n");
    expect(json).not.toContain(hexBody);

    const s = await keystoreSigner(ksPath, pwPath);
    expect(s.address).toBe(expected);
    const sig = await s.signMessage("hello");
    expect(await recoverMessageAddress({ message: "hello", signature: sig })).toBe(expected);
    const td = { domain: { name: "T", version: "1", chainId: 31337 }, types: { M: [{ name: "x", type: "uint256" }] }, primaryType: "M", message: { x: 1n } };
    const tsig = await s.signTypedData(td);
    expect(await recoverTypedDataAddress({ ...td, signature: tsig } as never)).toBe(expected);

    // the signer object never shows the key
    expect(JSON.stringify(s)).not.toContain(hexBody);
    expect(Bun.inspect(s)).not.toContain(hexBody);
    expect(Object.values(s).some((v) => typeof v === "string" && v.includes(hexBody))).toBe(false);

    // wrong password fails, with no key material in the message or a log line
    const lines: string[] = [];
    const log = logger("t", { sink: (l) => lines.push(l) });
    let err: Error | undefined;
    try {
      await keystoreSigner(ksPath, badPath);
    } catch (e) {
      err = e as Error;
      log.error("load failed", { error: err, ks: json });
    }
    expect(err).toBeInstanceOf(SignerError);
    expect(err!.message).toBe("keystore: wrong password or corrupt file (MAC mismatch)");
    expect(err!.message + String(err!.stack)).not.toContain(hexBody);
    expect(lines.join("\n")).not.toContain(hexBody);

    // a keystore whose address field does not match is refused
    const tampered = JSON.stringify({ ...JSON.parse(json), address: "00".repeat(20) });
    await expect(decryptKeystore(tampered, "correct horse")).rejects.toThrow("does not match the keystore address");
    // a missing file is reported without the path's content
    await expect(keystoreSigner(join(dir, "nope.json"), pwPath)).rejects.toThrow("cannot read the keystore file");
  });

  test("chain allow-list guard on keystore signers", async () => {
    const ksPath = join(dir, "ks2.json");
    const pwPath = join(dir, "pw2");
    writeFileSync(ksPath, await encryptKeystore(keyBytes(), "pw", { n: 1024 }));
    writeFileSync(pwPath, "pw");
    const s = await keystoreSigner(ksPath, pwPath, { allowedChainIds: [46630] });
    const td = { domain: { name: "T", version: "1", chainId: 4663 }, types: { M: [{ name: "x", type: "uint256" }] }, primaryType: "M", message: { x: 1n } };
    await expect(s.signTypedData(td)).rejects.toThrow("chain 4663 is not allowed");
  });

  test("dev-refuses-real-chains", async () => {
    expect(() => devSigner(4663)).toThrow(SignerError);
    expect(() => devSigner(46630)).toThrow(SignerError);
    expect(() => devSigner(8453)).toThrow(SignerError);
    const d = devSigner(31337);
    expect(d.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(devSigner(31337).address).toBe(d.address); // deterministic
    const tx = { chainId: 4663, to: d.address, nonce: 0, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
    await expect(d.signTransaction!(tx)).rejects.toThrow("devSigner refuses chain 4663");
    const td = { domain: { name: "T", version: "1", chainId: 46630 }, types: { M: [{ name: "x", type: "uint256" }] }, primaryType: "M", message: { x: 1n } };
    await expect(d.signTypedData(td)).rejects.toThrow("devSigner refuses chain 46630");
    expect(await d.signTransaction!({ ...tx, chainId: 31337 })).toMatch(/^0x02/);
  });
});
