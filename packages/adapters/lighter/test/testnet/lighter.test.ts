// R13 (BACKLOG A3): on signing id 300, register a key at index >= 4, place and cancel a tiny order, and show that a
// transfer is impossible through this code and that a raw transfer signed with the API key alone is refused by the
// venue. Skips unless LIGHTER_TESTNET_KEYSTORE and LIGHTER_TESTNET_ACCOUNT_INDEX are set (the account needs testnet
// funds, which only the project owner can arrange). Asserts the signing id and the testnet host before anything is sent.
import { describe, expect, test } from "bun:test";
import { LIGHTER_CONFIGS, SENDABLE_TX_TYPES } from "../../src";

const keystore = process.env.LIGHTER_TESTNET_KEYSTORE;
const account = process.env.LIGHTER_TESTNET_ACCOUNT_INDEX;
const ready = !!keystore && !!account;

describe("lighter testnet", () => {
  test("testnet config is signing id 300 on the testnet host", () => {
    expect(LIGHTER_CONFIGS.mainnetTestnet.signingChainId).toBe(300);
    expect(LIGHTER_CONFIGS.mainnetTestnet.rest).toBe("https://testnet.zklighter.elliot.ai");
    expect(SENDABLE_TX_TYPES).not.toContain(12); // transfer is never sendable from here
  });

  test.skipIf(!ready)("register-order-cancel", () => {
    // TODO(owner): BACKLOG A3. Needs a funded testnet Lighter account and an owner keystore (never typed here). The
    // flow: preflight -> buildOnboarding -> owner signs -> submitOnboarding -> verifyOnboarding (index >= 4) ->
    // buildOrder (tiny GTT) -> sign -> submit -> buildCancel -> sign -> submit; then a raw L2 transfer signed with the
    // API key alone must come back refused for the missing L1 signature.
    expect(LIGHTER_CONFIGS.mainnetTestnet.signingChainId).toBe(300);
    throw new Error("testnet run not wired yet: see BACKLOG A3");
  });
});
