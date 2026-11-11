// The proof script's pass/fail logic (ops/x402/solana-local-proof.sh --verdict), no validator needed.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../../ops/x402/solana-local-proof.sh");
const dir = mkdtempSync(join(tmpdir(), "capstan-solana-verdict-"));
let n = 0;
function judge(rc: number, log: string): string {
  const p = join(dir, `log-${n++}.txt`);
  writeFileSync(p, log);
  const r = Bun.spawnSync(["bash", SCRIPT, "--verdict", String(rc), p]);
  return `${r.stdout.toString().trim()}:${r.exitCode}`;
}
const summary = (pass: number, skip: number, fail: number) =>
  `\n ${pass} pass\n${skip ? ` ${skip} skip\n` : ""} ${fail} fail\n 36 expect() calls\nRan ${pass + skip + fail} tests across 1 file.\n`;

describe("solana local proof script verdict", () => {
  test("passes on 1 pass or more, 0 fail", () => {
    expect(judge(0, summary(1, 0, 0))).toBe("PASS:0");
    expect(judge(0, summary(3, 0, 0))).toBe("PASS:0");
  });
  test("fails on a failure, a skip, no tests or a nonzero exit", () => {
    expect(judge(1, summary(2, 0, 1))).toBe("FAIL:1");
    expect(judge(0, summary(0, 1, 0))).toBe("FAIL:1");
    expect(judge(0, summary(1, 1, 0))).toBe("FAIL:1");
    expect(judge(0, summary(0, 0, 0))).toBe("FAIL:1");
    expect(judge(1, summary(1, 0, 0))).toBe("FAIL:1");
    expect(judge(0, " 10 fail\n 1 pass\n")).toBe("FAIL:1");
    expect(judge(0, "")).toBe("FAIL:1");
  });
});
