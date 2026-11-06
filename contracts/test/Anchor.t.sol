// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CapstanReceiptAnchor} from "../src/CapstanReceiptAnchor.sol";
import {ICapstanReceiptAnchor} from "../src/interfaces/ICapstanReceiptAnchor.sol";
import {SortedPairMerkle} from "../src/libs/SortedPairMerkle.sol";

contract AnchorTest is Test {
    CapstanReceiptAnchor internal anchor;
    address internal poster = makeAddr("poster");
    uint64 internal constant H = 490_000; // an hour in 2025

    function setUp() public {
        vm.warp(uint256(H + 10) * 3600);
        anchor = new CapstanReceiptAnchor(poster);
    }

    function _post(uint64 h, bytes32 root) internal {
        vm.prank(poster);
        anchor.postRoot(h, root, 1);
    }

    /// R1: only the poster can post; any other caller reverts NotPoster.
    function testFuzz_onlyPoster(address caller) public {
        vm.assume(caller != poster);
        vm.prank(caller);
        vm.expectRevert(CapstanReceiptAnchor.NotPoster.selector);
        anchor.postRoot(H, keccak256("r"), 1);
        assertEq(anchor.latestHour(), 0);
        _post(H, keccak256("r"));
        (bytes32 root,,) = anchor.rootOf(H);
        assertEq(root, keccak256("r"));
    }

    /// R2: write-once, strictly increasing, and only finished hours.
    function test_writeOnce_increasing_hourOver() public {
        _post(H, keccak256("a"));
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(CapstanReceiptAnchor.AlreadyPosted.selector, H));
        anchor.postRoot(H, keccak256("b"), 2);
        (bytes32 root, uint32 count,) = anchor.rootOf(H);
        assertEq(root, keccak256("a"), "root unchanged");
        assertEq(count, 1);

        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(CapstanReceiptAnchor.NotIncreasing.selector, H - 1, H));
        anchor.postRoot(H - 1, keccak256("old"), 1);

        uint64 current = uint64(block.timestamp / 3600);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(CapstanReceiptAnchor.HourNotOver.selector, current));
        anchor.postRoot(current, keccak256("now"), 1);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(CapstanReceiptAnchor.HourNotOver.selector, current + 5));
        anchor.postRoot(current + 5, keccak256("future"), 1);

        // the hour just before the current one is over and later than H: accepted
        _post(current - 1, keccak256("c"));
        assertEq(anchor.latestHour(), current - 1);

        // gaps are allowed (empty hours are skipped), zero roots and zero counts are not
        vm.warp(block.timestamp + 10 hours);
        vm.startPrank(poster);
        vm.expectRevert(CapstanReceiptAnchor.EmptyRoot.selector);
        anchor.postRoot(current + 3, bytes32(0), 1);
        vm.expectRevert(CapstanReceiptAnchor.EmptyRoot.selector);
        anchor.postRoot(current + 3, keccak256("d"), 0);
        vm.stopPrank();
    }

    /// R3: RootPosted.prevRoot is the root of the previous latestHour (zero for the first post).
    function test_prevRoot() public {
        vm.expectEmit(true, false, false, true, address(anchor));
        emit ICapstanReceiptAnchor.RootPosted(H, keccak256("a"), 1, bytes32(0));
        _post(H, keccak256("a"));
        vm.expectEmit(true, false, false, true, address(anchor));
        emit ICapstanReceiptAnchor.RootPosted(H + 3, keccak256("b"), 1, keccak256("a"));
        _post(H + 3, keccak256("b"));
        vm.expectEmit(true, false, false, true, address(anchor));
        emit ICapstanReceiptAnchor.RootPosted(H + 4, keccak256("c"), 1, keccak256("b"));
        _post(H + 4, keccak256("c"));
    }

    /// R5: verifyReceipt hashes its input first, so an internal node with a short proof is rejected.
    function test_internalNodeRejected() public {
        bytes32[4] memory s = [keccak256("s0"), keccak256("s1"), keccak256("s2"), keccak256("s3")];
        bytes32[4] memory leaves;
        for (uint256 i; i < 4; ++i) {
            leaves[i] = keccak256(abi.encodePacked(s[i]));
        }
        bytes32 n01 = SortedPairMerkle.hashPair(leaves[0], leaves[1]);
        bytes32 n23 = SortedPairMerkle.hashPair(leaves[2], leaves[3]);
        bytes32 root = SortedPairMerkle.hashPair(n01, n23);
        vm.prank(poster);
        anchor.postRoot(H, root, 4);

        bytes32[] memory full = new bytes32[](2);
        full[0] = leaves[1];
        full[1] = n23;
        assertTrue(anchor.verifyReceipt(H, s[0], full), "real receipt verifies");

        bytes32[] memory short = new bytes32[](1);
        short[0] = n23;
        assertTrue(anchor.verify(H, n01, short), "generic verify accepts an internal node (documented)");
        assertFalse(anchor.verifyReceipt(H, n01, short), "verifyReceipt rejects the internal node");
        assertFalse(anchor.verifyReceipt(H, s[0], short), "wrong proof fails");
    }

    function test_verifyFalseWithoutRoot() public view {
        bytes32[] memory p = new bytes32[](0);
        assertFalse(anchor.verify(H, bytes32(0), p));
        assertFalse(anchor.verify(H, keccak256("x"), p));
        assertFalse(anchor.verifyReceipt(H, keccak256("x"), p));
    }

    function test_constructorRefusesZeroPoster() public {
        vm.expectRevert(CapstanReceiptAnchor.ZeroPoster.selector);
        new CapstanReceiptAnchor(address(0));
        assertEq(anchor.poster(), poster);
    }

    function test_postedAtAndCount() public {
        vm.prank(poster);
        anchor.postRoot(H, keccak256("a"), 7);
        (bytes32 root, uint32 count, uint64 postedAt) = anchor.rootOf(H);
        assertEq(root, keccak256("a"));
        assertEq(count, 7);
        assertEq(postedAt, block.timestamp);
    }

    /// The first hour may be any finished hour, including hour 0.
    function test_firstPostAtHourZero() public {
        _post(0, keccak256("genesis"));
        assertEq(anchor.latestHour(), 0);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(CapstanReceiptAnchor.AlreadyPosted.selector, 0));
        anchor.postRoot(0, keccak256("again"), 1);
        _post(1, keccak256("one"));
        assertEq(anchor.latestHour(), 1);
    }

    function testFuzz_increasingSequence(uint64[8] memory gaps) public {
        uint64 h = H - 1000;
        bytes32 prev;
        for (uint256 i; i < gaps.length; ++i) {
            h += 1 + (gaps[i] % 100);
            bytes32 root = keccak256(abi.encode(i, h));
            vm.expectEmit(true, false, false, true, address(anchor));
            emit ICapstanReceiptAnchor.RootPosted(h, root, 1, prev);
            _post(h, root);
            prev = root;
            assertEq(anchor.latestHour(), h);
        }
    }
}
