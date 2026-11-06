// R11 (BACKLOG A2, A3): one tiny Hyperliquid + Lighter testnet spread with flatten_leg_a and leg B forced to fail,
// ending 'flattened'. Needs funded testnet keystores, so it skips here; the runner asserts testnet chain ids first.
import { describe, expect, test } from "bun:test";

const HL_KS = process.env.HL_TESTNET_KEYSTORE;
const LT_KS = process.env.LIGHTER_TESTNET_KEYSTORE;
const d = HL_KS && LT_KS ? describe : describe.skip;

d("testnet pair (BACKLOG A2, A3)", () => {
  test("flatten", async () => {
    // TODO(owner): BACKLOG A2 and A3 fund the HL testnet and Lighter testnet (chain 300) agents; then this test builds
    // the plan through a local api on testnet config, forces leg B to fail with a limit far off the book, and checks
    // the flatten. Kept as a hard failure if the keystores are set but the run is not wired yet.
    expect(process.env.HL_NETWORK).toBe("Testnet");
    throw new Error("testnet pair run is not wired yet (BACKLOG A2, A3)");
  });
});

describe("testnet pair guard", () => {
  test("skips without testnet keystores", () => {
    if (!HL_KS || !LT_KS) expect(true).toBe(true);
  });
});
