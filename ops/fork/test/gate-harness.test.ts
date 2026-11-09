// Release gate 2026-11-08, fork harness drift (run 1 on main: 1/13). These checks run without the fork stack:
// - the MCP refuses to start on a mainnet profile without MCP_ALLOWED_HOSTS (r1:9 F-3), so the fork env sets it;
// - the SDK signs a non reduce-only order only with the user's intent (a5bd83c), so every fork signer.sign passes it;
// - S11 needs contracts/test fixtures, which a fresh clone has never built, so it reads them through contractArtifact;
// - S13 anchors the receipt's hour before the MCP verify, so a valid answer is required, not a pending one.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FORK = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(FORK, p), "utf8");

describe("gate fork harness", () => {
  test("mcp-hosts: the fork env names the MCP's own host and port", () => {
    const env = read("up.sh").split("cat > \"$state/stack.env\" <<ENV")[1]!.split("\nENV\n")[0]!;
    expect(env).toContain("CAPSTAN_NETWORK=mainnet");
    expect(env).toMatch(/^MCP_ALLOWED_HOSTS=127\.0\.0\.1:\$P_MCP,localhost:\$P_MCP$/m);
  });

  test("intent: every scenario that signs an order passes the user's intent", () => {
    const calls = readdirSync(join(FORK, "scenarios"))
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) => [...read(`scenarios/${f}`).matchAll(/signer\.sign\(([^)]*)\)/g)].map((m) => ({ f, args: m[1]! })));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect({ f: c.f, args: c.args.split(",").length }).toEqual({ f: c.f, args: 2 });
  });

  test("fixtures: S11 reads the test fixture through contractArtifact (builds when missing)", () => {
    const rh = read("scenarios/rh.ts");
    expect(rh).not.toContain("contracts/out/BurnFixture.sol");
    expect(rh).toContain('contractArtifact("BurnFixture.sol", "LiquidityAdder")');
    expect(read("lib.ts")).toMatch(/if \(!existsSync\(path\)\) run\(\[FORGE, "build"\]/);
  });

  test("s13: the MCP verify runs after the hour is anchored and must be valid", () => {
    const mcp = read("scenarios/mcp.ts");
    expect(mcp).toContain("beforeVerify");
    expect(mcp).toContain("closeHourAndAnchor(ctx, h)");
    expect(mcp).toContain("Object.values(run.verify.checks).every((x) => x === true)");
  });
});
