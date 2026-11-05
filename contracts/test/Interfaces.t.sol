// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ICapstanReceiptAnchor} from "../src/interfaces/ICapstanReceiptAnchor.sol";
import {ICPSTLock} from "../src/interfaces/ICPSTLock.sol";

/// Scaffold test: the interface selectors match the spec signatures, so the TS side can hard-code them.
contract InterfacesTest is Test {
    function test_anchorSelectors() public pure {
        assertEq(ICapstanReceiptAnchor.postRoot.selector, bytes4(keccak256("postRoot(uint64,bytes32,uint32)")));
        assertEq(ICapstanReceiptAnchor.rootOf.selector, bytes4(keccak256("rootOf(uint64)")));
        assertEq(ICapstanReceiptAnchor.verify.selector, bytes4(keccak256("verify(uint64,bytes32,bytes32[])")));
    }

    function test_lockSelectors() public pure {
        assertEq(ICPSTLock.lock.selector, bytes4(keccak256("lock(uint256,uint64)")));
        assertEq(ICPSTLock.unlock.selector, bytes4(keccak256("unlock()")));
        assertEq(ICPSTLock.lockedOf.selector, bytes4(keccak256("lockedOf(address)")));
    }
}
