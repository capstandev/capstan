// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CapstanReceiptAnchor} from "../src/CapstanReceiptAnchor.sol";
import {SortedPairMerkle} from "../src/libs/SortedPairMerkle.sol";

/// R4: every tree built by the TypeScript builder (packages/receipts/test/vectors/merkle.json) verifies on chain.
contract MerkleParityTest is Test {
    string internal constant VECTORS = "../packages/receipts/test/vectors/merkle.json";

    function _proof(string memory json, uint256 t, uint256 i) internal pure returns (bytes32[] memory p) {
        string memory key = string.concat(".trees[", vm.toString(t), "].proofs[", vm.toString(i), "]");
        bytes memory raw = vm.parseJson(json, key);
        if (raw.length <= 64) return new bytes32[](0); // an empty JSON array
        p = vm.parseJsonBytes32Array(json, key);
    }

    function test_parityWithTsVectors() public {
        string memory json = vm.readFile(VECTORS);
        uint256 count = vm.parseJsonUint(json, ".count");
        assertEq(count, 20, "20 committed trees");
        address poster = makeAddr("poster");
        vm.warp(1_000_000 * 3600);
        CapstanReceiptAnchor anchor = new CapstanReceiptAnchor(poster);
        uint256 checked;
        for (uint256 t; t < count; ++t) {
            string memory base = string.concat(".trees[", vm.toString(t), "]");
            bytes32 root = vm.parseJsonBytes32(json, string.concat(base, ".root"));
            bytes32[] memory leaves = vm.parseJsonBytes32Array(json, string.concat(base, ".leaves"));
            assertEq(leaves.length, vm.parseJsonUint(json, string.concat(base, ".size")));
            uint64 hour = uint64(100 + t);
            vm.prank(poster);
            // forge-lint: disable-next-line(unsafe-typecast)
            anchor.postRoot(hour, root, uint32(leaves.length));
            for (uint256 i; i < leaves.length; ++i) {
                bytes32[] memory p = _proof(json, t, i);
                assertEq(SortedPairMerkle.processProofMemory(leaves[i], p), root, "library fold equals the TS root");
                assertTrue(anchor.verify(hour, leaves[i], p), "leaf verifies on chain");
                // a wrong leaf fails
                assertFalse(anchor.verify(hour, keccak256(abi.encode(leaves[i])), p), "wrong leaf fails");
                // a wrong proof fails (flip one sibling, or add one when the proof is empty)
                bytes32[] memory bad = new bytes32[](p.length == 0 ? 1 : p.length);
                for (uint256 j; j < p.length; ++j) {
                    bad[j] = p[j];
                }
                bad[0] = bytes32(uint256(bad[0]) ^ 1);
                assertFalse(anchor.verify(hour, leaves[i], bad), "wrong proof fails");
                // the right proof against another hour's root fails
                if (t > 0) assertFalse(anchor.verify(hour - 1, leaves[i], p), "other hour fails");
                ++checked;
            }
        }
        assertGt(checked, 300, "every leaf of every tree checked");
    }

    function testFuzz_hashPairCommutative(bytes32 a, bytes32 b) public pure {
        assertEq(SortedPairMerkle.hashPair(a, b), SortedPairMerkle.hashPair(b, a));
        (bytes32 lo, bytes32 hi) = a < b ? (a, b) : (b, a);
        assertEq(SortedPairMerkle.hashPair(a, b), keccak256(abi.encodePacked(lo, hi)));
    }
}
