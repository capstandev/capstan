// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// R19: every script that broadcasts calls Guard.check() before its first broadcast.
contract GuardScanTest is Test {
    uint256 internal constant NONE = type(uint256).max;

    /// @dev True when `src` broadcasts and does not call Guard.check() before the first broadcast.
    function unguarded(string memory src) public pure returns (bool) {
        uint256 b1 = vm.indexOf(src, "vm.broadcast");
        uint256 b2 = vm.indexOf(src, "vm.startBroadcast");
        uint256 first = b1 < b2 ? b1 : b2;
        if (first == NONE) return false;
        uint256 g = vm.indexOf(src, "Guard.check()");
        return g == NONE || g > first;
    }

    function _endsWith(string memory s, string memory suffix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(suffix);
        if (a.length < b.length) return false;
        for (uint256 i; i < b.length; ++i) {
            if (a[a.length - b.length + i] != b[i]) return false;
        }
        return true;
    }

    function test_everyBroadcasterGuarded() public view {
        VmSafe.DirEntry[] memory entries = vm.readDir("script", 1);
        uint256 scripts;
        uint256 broadcasters;
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i].isDir || !_endsWith(entries[i].path, ".s.sol")) continue;
            ++scripts;
            string memory src = vm.readFile(entries[i].path);
            if (vm.indexOf(src, "Broadcast") != NONE || vm.indexOf(src, "vm.broadcast") != NONE) ++broadcasters;
            assertFalse(unguarded(src), string.concat("broadcast without Guard.check() first: ", entries[i].path));
        }
        assertGt(scripts, 1, "found the scripts");
        assertGt(broadcasters, 0, "found at least one broadcaster");
    }

    function test_scannerDetectsAPlantedScript() public pure {
        assertTrue(unguarded("function run() external { vm.startBroadcast(); new X(); }"));
        assertTrue(unguarded("function run() external { vm.broadcast(); new X(); Guard.check(); }"));
        assertFalse(unguarded("function run() external { Guard.check(); vm.startBroadcast(); }"));
        assertFalse(unguarded("function run() external view { read(); }"));
    }
}
