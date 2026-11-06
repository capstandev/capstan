// R7: a collateral move always goes to the owner's own account.
import { describe, expect, test } from "bun:test";
import { buildOnboarding } from "../../src";
import { pick, prng, randInt } from "../../../../signers/hl/test/helpers";
import { context, OWNER, request } from "./util";

describe("collateral", () => {
  test("destination-is-owner", async () => {
    const { ctx } = context();
    // naming another destination is refused
    await expect(buildOnboarding(request({ collateralMoves: [{ toDex: "xyz", token: "USDC", amount: "10", destination: "0x1111111111111111111111111111111111111111" }] }), ctx)).rejects.toThrow(/own account/);
    // the owner as destination (any case) is fine
    await expect(buildOnboarding(request({ collateralMoves: [{ toDex: "xyz", token: "USDC", amount: "10", destination: OWNER.toUpperCase().replace("0X", "0x") as `0x${string}` }] }), ctx)).resolves.toBeDefined();
    const r = prng(500);
    const dexes = ["xyz", "io", "para", "flx", "km", "hyna", "cash"];
    const tokens = ["USDC", "USDH", "USDE", "USDT0", "USDC:0x6d1e7cde53ba9467b783cb7c530ce054"];
    let built = 0;
    for (let i = 0; i < 500; i++) {
      const n = randInt(r, 1, 3);
      const moves = Array.from({ length: n }, () => {
        const m: { toDex: string; token: string; amount: string; destination?: `0x${string}` } = { toDex: pick(r, dexes), token: pick(r, tokens), amount: `${randInt(r, 1, 100000)}.${randInt(r, 0, 99)}` };
        const roll = r();
        if (roll < 0.25) m.destination = `0x${Array.from({ length: 40 }, () => "0123456789abcdef"[randInt(r, 0, 15)]).join("")}` as `0x${string}`;
        else if (roll < 0.5) m.destination = OWNER;
        return m;
      });
      const foreign = moves.some((m) => m.destination !== undefined && m.destination.toLowerCase() !== OWNER);
      const res = await buildOnboarding(request({ collateralMoves: moves }), ctx).then(
        (b) => b,
        (e: Error) => e,
      );
      if (foreign) {
        expect(res).toBeInstanceOf(Error);
        continue;
      }
      if (res instanceof Error) throw res;
      built++;
      const steps = res.steps.filter((s) => s.kind === "hl_collateral_move");
      expect(steps.length).toBe(n);
      steps.forEach((s, j) => {
        expect(s.signer).toBe("main_wallet");
        expect(s.typedData!.message.destination).toBe(OWNER);
        expect(s.typedData!.message.sourceDex).toBe("");
        expect(s.typedData!.message.destinationDex).toBe(moves[j]!.toDex);
        expect((s.venueTx as { action: Record<string, unknown> }).action.destination).toBe(OWNER);
      });
    }
    expect(built).toBeGreaterThan(100);
  });
});
