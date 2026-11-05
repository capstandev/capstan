// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ICapstanReceiptAnchor
/// @notice Anchors hourly Merkle roots of Capstan receipts. Non-upgradeable. No pause. No owner.
interface ICapstanReceiptAnchor {
    event RootPosted(uint64 indexed hourEpoch, bytes32 root, uint32 leafCount, bytes32 prevRoot);

    /// @notice Only `poster` (immutable, set in constructor) may post. One root per hourEpoch, write-once.
    function postRoot(uint64 hourEpoch, bytes32 root, uint32 leafCount) external;

    /// @notice The only address allowed to post roots.
    function poster() external view returns (address);

    /// @notice The root, leaf count and post time for an hour (zeros if none).
    function rootOf(uint64 hourEpoch) external view returns (bytes32 root, uint32 leafCount, uint64 postedAt);

    /// @notice The most recent hour with a posted root.
    function latestHour() external view returns (uint64);

    /// @notice Pure helper for third parties: verifies a sorted-pair keccak Merkle proof.
    function verify(uint64 hourEpoch, bytes32 leaf, bytes32[] calldata proof) external view returns (bool);
}
