// R2: detection flips to absent on a token without EIP-3009, on a facet that reverts FacetNotFound, and on a domain
// with version "2" (mocks deployed on a throwaway anvil). R3: any RPC error = absent, and eip3009 is not advertised.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hex } from "@capstan/schema";
import { createPublicClient, http } from "viem";
import { acceptsFor, type X402State } from "../src/accepts";
import { detectEip3009, domainSeparator, FORBIDDEN_SELECTORS, TRANSFER_WITH_AUTHORIZATION_TYPEHASH, type ReadClient } from "../src/detect";
import { railDefs } from "../src/networks";
import { compileMocks, deploy, haveFoundry, LANE_PORTS, startAnvil, type Anvil } from "./helpers/chain";

const EXPECT = (chainId: number) => ({ name: "Global Dollar", version: "1", chainId });

(haveFoundry ? describe : describe.skip)("detect on mocks (anvil)", () => {
  let anvil: Anvil;
  const addr: Record<string, Hex> = {};
  const sent: Hex[] = [];
  let rpc: ReadClient;
  beforeAll(async () => {
    anvil = await startAnvil(LANE_PORTS.localAnvil);
    const arts = compileMocks();
    for (const [name, art] of Object.entries(arts)) addr[name] = await deploy(anvil.url, 31337, art, `deployer-${name}`);
    const pc = createPublicClient({ transport: http(anvil.url) });
    rpc = {
      call: (args) => {
        if (args.data) sent.push(args.data.slice(0, 10) as Hex);
        return pc.call(args);
      },
    };
  }, 120_000);
  afterAll(async () => {
    await anvil?.stop();
  });

  test("flips", async () => {
    const good = await detectEip3009(rpc, addr.MockGood3009!, EXPECT(31337));
    expect(good.supported).toBe(true);
    const none = await detectEip3009(rpc, addr.MockNo3009!, EXPECT(31337));
    expect(none.supported).toBe(false);
    expect(none.reason).toContain("TRANSFER_WITH_AUTHORIZATION_TYPEHASH");
    const facet = await detectEip3009(rpc, addr.MockFacetRemoved!, EXPECT(31337));
    expect(facet.supported).toBe(false);
    expect(facet.reason).toBe("authorizationState: FacetNotFound");
    const v2 = await detectEip3009(rpc, addr.MockDomainV2!, EXPECT(31337));
    expect(v2.supported).toBe(false);
    expect(v2.reason).toContain("DOMAIN_SEPARATOR does not match");
    // version "2" would match the v2 mock: the check really compares the version
    expect((await detectEip3009(rpc, addr.MockDomainV2!, { ...EXPECT(31337), version: "2" })).supported).toBe(true);
    // a wrong chain id never matches
    expect((await detectEip3009(rpc, addr.MockGood3009!, EXPECT(4663))).supported).toBe(false);
    expect(sent).not.toContain(FORBIDDEN_SELECTORS.version);
    expect(sent).not.toContain(FORBIDDEN_SELECTORS.eip712Domain);
  });
});

describe("detect fail closed", () => {
  const usdg = railDefs("testnet")["rhc-usdg-eip3009"].asset as Hex;
  const state = (eip3009: boolean): X402State => ({
    usdgEip3009: { "4663": false, "46630": eip3009 },
    payTo: { evm: "0x00000000000000000000000000000000000000aa", sol: "So1PayTo1111111111111111111111111111111111" },
    tokens: { "rhc-usdg-permit2": { asset: usdg, decimals: 6, name: "Global Dollar", version: "1" }, "rhc-usdg-eip3009": { asset: usdg, decimals: 6, name: "Global Dollar", version: "1" } },
  });

  test("rpc-error-absent", async () => {
    const throwing: ReadClient = { call: async () => Promise.reject(new Error("ECONNRESET")) };
    const r = await detectEip3009(throwing, usdg, EXPECT(46630));
    expect(r.supported).toBe(false);
    // an empty return (no code, or a node returning 0x) is absent too
    const empty: ReadClient = { call: async () => ({ data: "0x" }) as never };
    expect((await detectEip3009(empty, usdg, EXPECT(46630))).supported).toBe(false);
    // a timeout on the third call (after two good answers) is still absent
    let n = 0;
    const flaky: ReadClient = {
      call: async () => {
        n++;
        if (n === 1) return { data: TRANSFER_WITH_AUTHORIZATION_TYPEHASH } as never;
        if (n === 2) return { data: `0x${"00".repeat(32)}` } as never;
        throw new Error("timeout");
      },
    };
    expect((await detectEip3009(flaky, usdg, EXPECT(46630))).supported).toBe(false);
    // and the eip3009 rail is not advertised when detection said absent
    const accepts = acceptsFor({ usd: "0.01", description: "x" }, state(r.supported), "testnet");
    expect(accepts.map((a) => a.extra.assetTransferMethod ?? "eip3009")).toEqual(["permit2"]);
    expect(acceptsFor({ usd: "0.01", description: "x" }, state(true), "testnet").length).toBe(2);
  });

  test("domain separator matches the live USDG value (chain-facts section 3)", () => {
    expect(domainSeparator("Global Dollar", "1", 4663, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168")).toBe(
      "0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036", // not-a-key (public domain separator)
    );
    expect(domainSeparator("Global Dollar", "1", 46630, "0x7E955252E15c84f5768B83c41a71F9eba181802F")).toBe(
      "0xb1debe91e09d82163fd9cddaab89359061c0671664e1611258a3c3de7c2d950b", // not-a-key (public domain separator)
    );
  });
});
