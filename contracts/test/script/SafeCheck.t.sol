// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SafeCheck} from "../../script/lib/SafeCheck.sol";
import {BurnFixture} from "../fork/BurnFixture.sol";
import {LocalVault} from "../mocks/LocalVault.sol";

contract SafeCheckHarness {
    function check(address s) external view {
        SafeCheck.check(s);
    }
}

/// R12: only a real Safe 1.4.1 (official proxy and singleton, threshold >= 2, no modules, no guard) passes. The
/// local cases always run; the real-Safe cases need RHC_RPC_URL (a 4663 fork with the canonical factory).
contract SafeCheckTest is Test {
    SafeCheckHarness internal h = new SafeCheckHarness();

    function _rejects(address s, string memory why) internal {
        assertEq(SafeCheck.reason(s), why);
        vm.expectRevert(abi.encodeWithSelector(SafeCheck.NotARealSafe.selector, s, why));
        h.check(s);
    }

    function _owners(uint256 n) internal returns (address[] memory o) {
        o = new address[](n);
        for (uint256 i; i < n; ++i) {
            o[i] = makeAddr(string.concat("safe-owner-", vm.toString(i)));
        }
    }

    function test_realSafeOnly() public {
        // local: an EOA, an EIP-7702 delegated EOA (0xef0100 || delegate), and a plain contract all fail
        _rejects(makeAddr("eoa"), "no code");
        address delegated = makeAddr("delegated");
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(0x41675C099F32341bf84BFc5382aF534df5C7461a)));
        _rejects(delegated, "EIP-7702 delegated EOA");
        _rejects(address(new LocalVault()), "runtime code is not the Safe 1.4.1 proxy");

        string memory rpc = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return; // the fork half runs in the fork acceptance step
        vm.createSelectFork(rpc);
        h = new SafeCheckHarness(); // contracts made before the fork do not exist on it
        address good = BurnFixture.makeSafe(_owners(3), 2, 1);
        assertEq(SafeCheck.reason(good), "", "a 2-of-3 Safe from the canonical factory passes");
        h.check(good);

        address oneOfOne = BurnFixture.makeSafe(_owners(1), 1, 2);
        _rejects(oneOfOne, "threshold below 2");

        // a Safe with a module (planted in the modules linked list, storage slot 1)
        address withModule = BurnFixture.makeSafe(_owners(3), 2, 3);
        address module = makeAddr("module");
        vm.store(withModule, keccak256(abi.encode(address(1), uint256(1))), bytes32(uint256(uint160(module))));
        vm.store(withModule, keccak256(abi.encode(module, uint256(1))), bytes32(uint256(1)));
        _rejects(withModule, "a module is enabled");

        // a Safe with a guard
        address withGuard = BurnFixture.makeSafe(_owners(3), 2, 4);
        vm.store(withGuard, bytes32(SafeCheck.GUARD_SLOT), bytes32(uint256(uint160(makeAddr("guard")))));
        _rejects(withGuard, "a guard is set");

        // the right proxy code over another singleton fails
        address otherSingleton = BurnFixture.makeSafe(_owners(3), 2, 5);
        vm.store(otherSingleton, bytes32(0), bytes32(uint256(uint160(makeAddr("other singleton")))));
        _rejects(otherSingleton, "singleton is not Safe 1.4.1 or SafeL2 1.4.1");
    }
}
