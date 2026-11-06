// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Guard} from "../../script/lib/Guard.sol";
import {Deployments} from "../../script/lib/Deployments.sol";
import {DeployAnchorLock} from "../../script/DeployAnchorLock.s.sol";

contract GuardHarness {
    function checkValues(string memory armed, uint256 expected, string memory go, uint256 chainId, uint256 ts)
        external
        pure
    {
        Guard.checkValues(armed, expected, go, chainId, ts);
    }

    function check() external view {
        Guard.check();
    }
}

/// R16: the deploy guard refuses unarmed runs, a chain id mismatch, and mainnet without the dated go.
contract GuardTest is Test {
    GuardHarness internal h = new GuardHarness();
    uint256 internal constant TS = 1793836800 + 5 hours; // 2026-11-05T05:00:00Z

    function test_guardRefuses() public {
        // the runner never has the deploy armed; the script must revert before any broadcast
        assertEq(vm.envOr("CAPSTAN_DEPLOY_ARMED", string("")), "", "test runner must not be armed");
        DeployAnchorLock s = new DeployAnchorLock();
        uint64 nonceBefore = vm.getNonce(address(s));
        vm.expectRevert(Guard.NotArmed.selector);
        s.run();
        assertEq(vm.getNonce(address(s)), nonceBefore, "nothing deployed");
        vm.expectRevert(Guard.NotArmed.selector);
        h.check();

        vm.expectRevert(Guard.NotArmed.selector);
        h.checkValues("", 31337, "", 31337, TS);
        vm.expectRevert(Guard.NotArmed.selector);
        h.checkValues("yes", 31337, "", 31337, TS);
        vm.expectRevert(Guard.NotArmed.selector);
        h.checkValues("0", 31337, "", 31337, TS);

        vm.expectRevert(abi.encodeWithSelector(Guard.ChainMismatch.selector, 46630, 31337));
        h.checkValues("1", 46630, "", 31337, TS);
        vm.expectRevert(abi.encodeWithSelector(Guard.ChainMismatch.selector, 0, 46630));
        h.checkValues("1", 0, "", 46630, TS);
        vm.expectRevert(abi.encodeWithSelector(Guard.ChainMismatch.selector, 46630, 4663));
        h.checkValues("1", 46630, "go-2026-11-05", 4663, TS);

        vm.expectRevert(abi.encodeWithSelector(Guard.MainnetNotGo.selector, "go-2026-11-05"));
        h.checkValues("1", 4663, "", 4663, TS);
        vm.expectRevert(abi.encodeWithSelector(Guard.MainnetNotGo.selector, "go-2026-11-05"));
        h.checkValues("1", 4663, "go-2026-11-04", 4663, TS);
        vm.expectRevert(abi.encodeWithSelector(Guard.MainnetNotGo.selector, "go-2026-11-05"));
        h.checkValues("1", 4663, "go", 4663, TS);

        // what passes
        h.checkValues("1", 4663, "go-2026-11-05", 4663, TS);
        h.checkValues("1", 46630, "", 46630, TS);
        h.checkValues("1", 31337, "", 31337, TS);
    }

    function test_utcDate() public pure {
        assertEq(Guard.utcDate(0), "1970-01-01");
        assertEq(Guard.utcDate(951782400), "2000-02-29");
        assertEq(Guard.utcDate(1709164800), "2024-02-29");
        assertEq(Guard.utcDate(1793836800), "2026-11-05");
        assertEq(Guard.utcDate(1793836800 - 1), "2026-11-04");
        assertEq(Guard.utcDate(4102444799), "2099-12-31");
        assertEq(Deployments.isoTime(4102444799), "2099-12-31T23:59:59Z");
        assertEq(Deployments.isoTime(1793836800 + 3661), "2026-11-05T01:01:01Z");
    }
}
