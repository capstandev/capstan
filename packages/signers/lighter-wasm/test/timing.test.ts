// R6: p99 of 1,000 signCreateOrder calls (through the Worker) under 50 ms, cold start under 1,000 ms, in Bun and in
// Node. Results go to test/timing.json (gitignored).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLighterSigner } from "../src/index";
import { PKG, quantile, randomOrder, rng } from "./helpers";

describe("timing", () => {
  test(
    "bun-node-under-50ms",
    async () => {
      const t0 = performance.now();
      const s = await createLighterSigner(304);
      const coldMs = performance.now() - t0;
      s.generateApiKey();
      const r = rng(11);
      const ds: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const o = randomOrder(r, i);
        const a = performance.now();
        await s.signCreateOrder(o);
        ds.push(performance.now() - a);
      }
      s.close();
      ds.sort((x, y) => x - y);
      const bun = { runtime: `bun ${Bun.version}`, n: 1000, coldMs: +coldMs.toFixed(1), p50Ms: +quantile(ds, 0.5).toFixed(3), p99Ms: +quantile(ds, 0.99).toFixed(3), maxMs: +ds[ds.length - 1]!.toFixed(3) };

      const n = spawnSync("node", [join(PKG, "test/timing-node.mjs")], { encoding: "utf8", timeout: 120_000 });
      let node: Record<string, unknown> | { skipped: string } = { skipped: "node not found" };
      if (n.status === 0) node = JSON.parse(n.stdout.trim().split("\n").pop()!);
      else if (n.error === undefined) throw new Error(`timing-node.mjs failed: ${n.stderr}`);

      writeFileSync(join(PKG, "test/timing.json"), JSON.stringify({ at: new Date().toISOString(), bun, node }, null, 2) + "\n");
      expect(bun.p99Ms).toBeLessThan(50);
      expect(bun.coldMs).toBeLessThan(1000);
      if ("p99Ms" in node) {
        expect(node.p99Ms as number).toBeLessThan(50);
        expect(node.coldMs as number).toBeLessThan(1000);
      }
    },
    180_000,
  );
});
