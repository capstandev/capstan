// R1 and R3 (todo 40) on a running fork stack (bash ops/fork/up.sh): every scenario S1 to S13 passes, and a second run
// on the same fork deploys a second contract set into the fork record while the committed 4663.json stays untouched.
// Runs only with FORK_STACK=1 (it needs the whole stack, takes about 7 minutes per run).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FORK_FILE, ROOT } from "../lib";
import { main } from "../every-tx";

const RUN = process.env.FORK_STACK === "1";

describe("every-tx", () => {
  test.skipIf(!RUN)("rerun-safe", async () => {
    const real = join(ROOT, "contracts/deployments/4663.json");
    const before = existsSync(real) ? readFileSync(real, "utf8") : null;
    const first = await main([]);
    expect(first.passed).toBe(first.total);
    const anchor1 = JSON.parse(readFileSync(FORK_FILE, "utf8")).contracts.CapstanReceiptAnchor.address;
    const second = await main([]);
    expect(second.passed).toBe(second.total);
    const anchor2 = JSON.parse(readFileSync(FORK_FILE, "utf8")).contracts.CapstanReceiptAnchor.address;
    expect(anchor2).not.toBe(anchor1);
    expect(existsSync(real) ? readFileSync(real, "utf8") : null).toBe(before);
  }, 1_800_000);
});
