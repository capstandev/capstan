// R1: build.sh twice gives byte-identical wasm whose sha256 equals WASM_SHA256 and artifacts/SHA256SUMS.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASM_EXEC_SHA256, WASM_SHA256 } from "../src/index";
import { dockerAvailable, PKG } from "./helpers";

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sums = () =>
  Object.fromEntries(
    readFileSync(join(PKG, "artifacts/SHA256SUMS"), "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split(/\s+/))
      .map(([h, p]) => [p!.split("/").pop()!, h!]),
  );

describe("reproducible build", () => {
  test("committed artifacts match SHA256SUMS and the pinned constants", () => {
    const s = sums();
    expect(sha(join(PKG, "artifacts/lighter-signer.wasm"))).toBe(WASM_SHA256);
    expect(sha(join(PKG, "artifacts/wasm_exec.js"))).toBe(WASM_EXEC_SHA256);
    expect(s["lighter-signer.wasm"]).toBe(WASM_SHA256);
    expect(s["wasm_exec.js"]).toBe(WASM_EXEC_SHA256);
  });

  test.skipIf(!dockerAvailable())(
    "two-builds-equal",
    () => {
      const outs = [1, 2].map(() => {
        const out = mkdtempSync(join(tmpdir(), "lighter-wasm-build-"));
        const r = spawnSync("bash", [join(PKG, "build/build.sh"), "--out", out], { encoding: "utf8", timeout: 900_000 });
        if (r.status !== 0) throw new Error(`build.sh failed: ${r.stderr.slice(-2000)}`);
        return out;
      });
      const [a, b] = outs.map((o) => sha(join(o!, "lighter-signer.wasm")));
      expect(a).toBe(b!);
      expect(a).toBe(WASM_SHA256);
      expect(sums()["lighter-signer.wasm"]).toBe(a!);
      expect(sha(join(outs[0]!, "wasm_exec.js"))).toBe(WASM_EXEC_SHA256);
      expect(sha(join(outs[1]!, "wasm_exec.js"))).toBe(WASM_EXEC_SHA256);
    },
    1_800_000,
  );
});
