// R11 (BACKLOG A3): on the RH testnet (signing id 300, host api.rh-testnet.lighter.xyz) the account, key and nonce
// are separate from the mainnet-testnet account. Skips unless LIGHTER_RH_TESTNET_KEYSTORE and
// LIGHTER_RH_TESTNET_ACCOUNT_INDEX are set (a funded RH testnet account the project owner arranges).
import { describe, expect, test } from "bun:test";
import { LIGHTER_CONFIGS } from "../../src";

const ready = !!process.env.LIGHTER_RH_TESTNET_KEYSTORE && !!process.env.LIGHTER_RH_TESTNET_ACCOUNT_INDEX;

describe("lighter rh testnet", () => {
  test("the two testnets share signing id 300 but never a host or venue", () => {
    expect(LIGHTER_CONFIGS.rhTestnet.signingChainId).toBe(300);
    expect(LIGHTER_CONFIGS.rhTestnet.rest).toBe("https://api.rh-testnet.lighter.xyz");
    expect(LIGHTER_CONFIGS.rhTestnet.rest).not.toBe(LIGHTER_CONFIGS.mainnetTestnet.rest);
    expect(LIGHTER_CONFIGS.rhTestnet.venue).toBe("lighter-rh");
  });

  test.skipIf(!ready)("separate", () => {
    // TODO(owner): BACKLOG A3. Needs funded testnet accounts on both Lighter testnets and the owner keystores. The
    // run: preflight both exchanges with one owner, show two account indexes, register a key on each and read
    // nextNonce on each key, then place and cancel one tiny order on RH.
    throw new Error("RH testnet run not wired yet: see BACKLOG A3");
  });
});
