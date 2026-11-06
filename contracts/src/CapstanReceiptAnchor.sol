// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICapstanReceiptAnchor} from "./interfaces/ICapstanReceiptAnchor.sol";
import {SortedPairMerkle} from "./libs/SortedPairMerkle.sol";

/// @title CapstanReceiptAnchor
/// @notice Public anchor for hourly Merkle roots of Capstan receipts on Robinhood Chain.
/// Non-upgradeable, no owner, no pause, no admin. One immutable poster may post one root per finished hour, in
/// strictly increasing hour order, and a posted root never changes. If the poster key is ever lost or leaked, a new
/// anchor is deployed and the deployment file is updated; roots already posted here stay valid forever.
contract CapstanReceiptAnchor is ICapstanReceiptAnchor {
    struct Root {
        bytes32 root;
        uint32 leafCount;
        uint64 postedAt;
    }

    /// @notice The only address allowed to post roots. Set once in the constructor.
    address public immutable poster;

    /// @notice The most recent hour with a posted root (zero before the first post).
    uint64 public latestHour;

    mapping(uint64 hourEpoch => Root) private _roots;

    /// @notice The caller is not the poster.
    error NotPoster();
    /// @notice A root for this hour already exists; roots are write-once.
    error AlreadyPosted(uint64 hourEpoch);
    /// @notice The hour has not ended yet (hourEpoch must be below block.timestamp / 3600).
    error HourNotOver(uint64 hourEpoch);
    /// @notice The hour is not after the latest posted hour.
    error NotIncreasing(uint64 hourEpoch, uint64 latest);
    /// @notice The root is zero or the leaf count is zero (empty hours are skipped, never posted).
    error EmptyRoot();
    /// @notice The constructor got the zero address as poster.
    error ZeroPoster();

    /// @notice Deploy the anchor with its one immutable poster.
    /// @param poster_ The poster address; must be nonzero.
    constructor(address poster_) {
        if (poster_ == address(0)) revert ZeroPoster();
        poster = poster_;
    }

    /// @notice Post the Merkle root of a finished hour. Only the poster; hours strictly increase; write-once.
    /// @param hourEpoch floor(unix seconds / 3600) of the hour; must have ended.
    /// @param root The sorted-pair keccak root of that hour's leaves; nonzero.
    /// @param leafCount The number of leaves; nonzero.
    function postRoot(uint64 hourEpoch, bytes32 root, uint32 leafCount) external {
        if (msg.sender != poster) revert NotPoster();
        if (root == bytes32(0) || leafCount == 0) revert EmptyRoot();
        if (uint256(hourEpoch) >= block.timestamp / 3600) revert HourNotOver(hourEpoch);
        if (_roots[hourEpoch].root != bytes32(0)) revert AlreadyPosted(hourEpoch);
        uint64 latest = latestHour;
        bytes32 prevRoot = _roots[latest].root;
        if (prevRoot != bytes32(0) && hourEpoch <= latest) revert NotIncreasing(hourEpoch, latest);
        // casting to 'uint64' is safe because unix seconds fit in 64 bits for billions of years
        // forge-lint: disable-next-line(unsafe-typecast)
        _roots[hourEpoch] = Root({root: root, leafCount: leafCount, postedAt: uint64(block.timestamp)});
        latestHour = hourEpoch;
        emit RootPosted(hourEpoch, root, leafCount, prevRoot);
    }

    /// @notice The root, leaf count and post time of an hour (all zero when none was posted).
    /// @param hourEpoch The hour.
    /// @return root The posted root.
    /// @return leafCount The posted leaf count.
    /// @return postedAt The block timestamp of the post.
    function rootOf(uint64 hourEpoch) external view returns (bytes32 root, uint32 leafCount, uint64 postedAt) {
        Root storage r = _roots[hourEpoch];
        return (r.root, r.leafCount, r.postedAt);
    }

    /// @notice Check a sorted-pair proof of `leaf` against the root of `hourEpoch`. False when no root exists.
    /// Like every sorted-pair tree this also accepts an internal node with a shortened proof: third parties
    /// checking a receipt should call verifyReceipt, which hashes the receipt hash into a leaf first.
    /// @param hourEpoch The hour.
    /// @param leaf The leaf (keccak256 of the receipt's sha256).
    /// @param proof Siblings from the leaf layer up.
    /// @return ok True when the proof folds to the posted root.
    function verify(uint64 hourEpoch, bytes32 leaf, bytes32[] calldata proof) public view returns (bool ok) {
        bytes32 root = _roots[hourEpoch].root;
        if (root == bytes32(0)) return false;
        return SortedPairMerkle.processProof(leaf, proof) == root;
    }

    /// @notice Check that a receipt hash is in the root of `hourEpoch`. The leaf is keccak256(receiptSha256), so a
    /// caller cannot present an internal node of the tree as a receipt.
    /// @param hourEpoch The hour.
    /// @param receiptSha256 sha256 of the receipt's canonical JSON (the 32 raw bytes).
    /// @param proof Siblings from the leaf layer up.
    /// @return ok True when the receipt is in the posted root.
    function verifyReceipt(uint64 hourEpoch, bytes32 receiptSha256, bytes32[] calldata proof)
        external
        view
        returns (bool ok)
    {
        return verify(hourEpoch, keccak256(abi.encodePacked(receiptSha256)), proof);
    }
}
