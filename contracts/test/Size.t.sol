// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CapstanReceiptAnchor} from "../src/CapstanReceiptAnchor.sol";
import {CPSTLock} from "../src/CPSTLock.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// R15: both runtime sizes stay under 20,000 bytes (EIP-170 limit 24,576).
contract SizeTest is Test {
    uint256 internal constant HEADROOM_LIMIT = 20_000;

    function test_sizeHeadroom() public {
        uint256 a = address(new CapstanReceiptAnchor(address(1))).code.length;
        uint256 l = address(new CPSTLock(address(new MockERC20("T", "T")))).code.length;
        assertGt(a, 0);
        assertGt(l, 0);
        assertLt(a, HEADROOM_LIMIT, "anchor runtime size");
        assertLt(l, HEADROOM_LIMIT, "lock runtime size");
    }
}
