// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RhcAddresses} from "../../script/lib/RhcAddresses.sol";
import {SafeCheck} from "../../script/lib/SafeCheck.sol";

/// Every third-party address the scripts hard-code is in packages/schema/src/constants/chains.ts (the one source).
contract AddressCopyTest is Test {
    function _has(string memory src, address a) internal pure returns (bool) {
        return vm.indexOf(src, vm.toLowercase(vm.toString(a))) != type(uint256).max;
    }

    function test_scriptAddressesEqualChainsTs() public view {
        string memory src = vm.toLowercase(vm.readFile("../packages/schema/src/constants/chains.ts"));
        address[14] memory all = [
            RhcAddresses.UNIVERSAL_ROUTER,
            RhcAddresses.PERMIT2,
            RhcAddresses.V4_POOL_MANAGER,
            RhcAddresses.V4_QUOTER,
            RhcAddresses.V4_STATE_VIEW,
            RhcAddresses.V3_QUOTER_V2,
            RhcAddresses.WETH,
            RhcAddresses.USDG_MAINNET,
            RhcAddresses.USDG_TESTNET,
            SafeCheck.SAFE_141,
            SafeCheck.SAFE_L2_141,
            SafeCheck.FACTORY_141,
            SafeCheck.FALLBACK_141,
            0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca // fork-only USDG source in test/fork
        ];
        for (uint256 i; i < all.length; ++i) {
            assertTrue(_has(src, all[i]), string.concat("not in chains.ts: ", vm.toString(all[i])));
        }
    }
}
