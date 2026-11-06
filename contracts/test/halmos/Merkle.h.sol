// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SortedPairMerkle} from "../../src/libs/SortedPairMerkle.sol";
import {CapstanReceiptAnchor} from "../../src/CapstanReceiptAnchor.sol";

/// R6: symbolic checks (run by halmos through ops/ci/halmos.sh; forge test does not run check_ functions).
contract MerkleSymbolic is Test {
    CapstanReceiptAnchor internal anchor;

    function setUp() public {
        anchor = new CapstanReceiptAnchor(address(0xA11CE));
    }

    /// hashPair is commutative for every pair of nodes.
    function check_hashPairCommutative(bytes32 a, bytes32 b) public pure {
        assert(SortedPairMerkle.hashPair(a, b) == SortedPairMerkle.hashPair(b, a));
    }

    /// processProof folds hashPair over the proof in order (two levels), for every input.
    function check_processProofFolds(bytes32 leaf, bytes32 p0, bytes32 p1) public pure {
        bytes32[] memory p = new bytes32[](2);
        p[0] = p0;
        p[1] = p1;
        bytes32 want = SortedPairMerkle.hashPair(SortedPairMerkle.hashPair(leaf, p0), p1);
        assert(SortedPairMerkle.processProofMemory(leaf, p) == want);
        bytes32[] memory empty = new bytes32[](0);
        assert(SortedPairMerkle.processProofMemory(leaf, empty) == leaf);
    }

    /// verify and verifyReceipt return false for every input when the hour has no root.
    function check_verifyFalseWithoutRoot(uint64 hour, bytes32 leaf, bytes32 p0, bytes32 p1) public view {
        bytes32[] memory p = new bytes32[](2);
        p[0] = p0;
        p[1] = p1;
        assert(!anchor.verify(hour, leaf, p));
        assert(!anchor.verifyReceipt(hour, leaf, p));
        bytes32[] memory empty = new bytes32[](0);
        assert(!anchor.verify(hour, leaf, empty));
    }
}
