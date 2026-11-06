// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SortedPairMerkle
/// @notice Sorted-pair keccak Merkle proofs, the same fold as the TypeScript builder in packages/receipts/src/tree.ts.
/// A pair hashes keccak256(min(a, b) ++ max(a, b)); a proof lists siblings from the leaf layer up.
library SortedPairMerkle {
    /// @notice keccak256 of the two nodes in ascending order. Commutative: hashPair(a, b) == hashPair(b, a).
    /// @param a One node.
    /// @param b The other node.
    /// @return h The parent node.
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32 h) {
        (bytes32 lo, bytes32 hi) = a < b ? (a, b) : (b, a);
        assembly ("memory-safe") {
            mstore(0x00, lo)
            mstore(0x20, hi)
            h := keccak256(0x00, 0x40)
        }
    }

    /// @notice Fold a calldata proof onto a leaf and return the computed root.
    /// @param leaf The starting node.
    /// @param proof Siblings from the leaf layer up.
    /// @return h The computed root.
    function processProof(bytes32 leaf, bytes32[] calldata proof) internal pure returns (bytes32 h) {
        h = leaf;
        uint256 n = proof.length;
        for (uint256 i; i < n; ++i) {
            h = hashPair(h, proof[i]);
        }
    }

    /// @notice Fold a memory proof onto a leaf and return the computed root.
    /// @param leaf The starting node.
    /// @param proof Siblings from the leaf layer up.
    /// @return h The computed root.
    function processProofMemory(bytes32 leaf, bytes32[] memory proof) internal pure returns (bytes32 h) {
        h = leaf;
        uint256 n = proof.length;
        for (uint256 i; i < n; ++i) {
            h = hashPair(h, proof[i]);
        }
    }
}
