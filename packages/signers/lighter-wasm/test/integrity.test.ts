// R2: the wrapper hashes the wasm bytes (and wasm_exec.js) on load and refuses to start on any difference.
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLighterHasher, createLighterSigner } from "../src/index";
import { PKG } from "./helpers";

describe("integrity", () => {
  test("tampered-wasm", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lighter-tamper-"));
    const bytes = readFileSync(join(PKG, "artifacts/lighter-signer.wasm"));
    bytes[bytes.length - 100] = bytes[bytes.length - 100]! ^ 0x01; // one bit
    const bad = join(dir, "lighter-signer.wasm");
    writeFileSync(bad, bytes);
    let posted = 0;
    const inspect = () => void posted++;
    await expect(createLighterSigner(304, { wasmUrl: pathToFileURL(bad), inspect })).rejects.toThrow(/refusing to start, lighter-signer.wasm sha256/);
    await expect(createLighterHasher(466324, { wasmUrl: pathToFileURL(bad), inspect })).rejects.toThrow(/refusing to start/);
    expect(posted).toBe(0); // refused before any Worker message

    const exec = join(dir, "wasm_exec.js");
    copyFileSync(join(PKG, "artifacts/wasm_exec.js"), exec);
    writeFileSync(exec, readFileSync(exec, "utf8") + "\n// changed\n");
    await expect(createLighterSigner(304, { wasmExecUrl: pathToFileURL(exec) })).rejects.toThrow(/wasm_exec.js sha256/);
  });

  test("the untampered artifact starts", async () => {
    const s = await createLighterSigner(300);
    expect(s.chainId).toBe(300);
    s.close();
  });

  test("an unknown chain id is refused", async () => {
    await expect(createLighterSigner(1 as never)).rejects.toThrow(/unknown Lighter signing chain id/);
  });
});
