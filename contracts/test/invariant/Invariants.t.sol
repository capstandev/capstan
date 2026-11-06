// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CPSTLock} from "../../src/CPSTLock.sol";
import {CapstanReceiptAnchor} from "../../src/CapstanReceiptAnchor.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// Drives the lock with random users, amounts, durations, time jumps and donations.
contract LockHandler is Test {
    CPSTLock public lockC;
    MockERC20 public token;
    address[] public users;
    uint256 public unlockFailures; // unlocks that reverted although the time had passed
    uint256 public calls;

    constructor(CPSTLock l, MockERC20 t) {
        lockC = l;
        token = t;
        for (uint256 i; i < 5; ++i) {
            address u = makeAddr(string.concat("user", vm.toString(i)));
            users.push(u);
            t.mint(u, 1e40);
            vm.prank(u);
            t.approve(address(l), type(uint256).max);
        }
    }

    function usersLength() external view returns (uint256) {
        return users.length;
    }

    function lock(uint256 who, uint256 amount, uint8 dSel) external {
        ++calls;
        address u = users[who % users.length];
        amount = bound(amount, 1, 1e30);
        uint64 d = [uint64(0), 30 days, 90 days][dSel % 3];
        vm.prank(u);
        lockC.lock(amount, d);
    }

    function unlock(uint256 who) external {
        ++calls;
        address u = users[who % users.length];
        (uint256 a, uint64 at) = lockC.lockedOf(u);
        if (a == 0 || block.timestamp < at) return;
        uint256 before = token.balanceOf(u);
        vm.prank(u);
        try lockC.unlock() {
            if (token.balanceOf(u) - before != a) ++unlockFailures;
        } catch {
            ++unlockFailures;
        }
    }

    function warp(uint32 secs) external {
        ++calls;
        vm.warp(block.timestamp + bound(secs, 1, 45 days));
    }

    function donate(uint256 amount) external {
        ++calls;
        amount = bound(amount, 1, 1e30);
        token.mint(address(lockC), amount);
    }
}

/// Drives the anchor with random hours and roots from the poster and from strangers.
contract AnchorHandler is Test {
    CapstanReceiptAnchor public anchor;
    address public poster;
    uint64[] public posted;
    mapping(uint64 => bytes32) public expected;
    uint64 public maxLatest;
    bool public decreased;

    constructor(CapstanReceiptAnchor a, address p) {
        anchor = a;
        poster = p;
    }

    function postedLength() external view returns (uint256) {
        return posted.length;
    }

    function post(uint64 hourSeed, bytes32 root, uint32 count, bool asPoster) external {
        uint64 nowHour = uint64(block.timestamp / 3600);
        uint64 h = uint64(bound(hourSeed, nowHour > 200 ? nowHour - 200 : 0, nowHour + 2));
        vm.prank(asPoster ? poster : address(0xbad));
        try anchor.postRoot(h, root, count) {
            posted.push(h);
            expected[h] = root;
        } catch {}
        uint64 l = anchor.latestHour();
        if (l < maxLatest) decreased = true;
        maxLatest = l;
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 6 hours));
    }
}

/// R13: handler-based invariants for the lock and the anchor.
contract InvariantsTest is Test {
    CPSTLock internal lockC;
    MockERC20 internal token;
    LockHandler internal lh;
    CapstanReceiptAnchor internal anchor;
    AnchorHandler internal ah;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockERC20("Capstan", "CPST");
        lockC = new CPSTLock(address(token));
        lh = new LockHandler(lockC, token);
        address poster = makeAddr("poster");
        anchor = new CapstanReceiptAnchor(poster);
        ah = new AnchorHandler(anchor, poster);
        targetContract(address(lh));
        targetContract(address(ah));
    }

    /// (a) totalLocked equals the sum of every lockedOf amount.
    function invariant_totalEqualsSum() public view {
        uint256 sum;
        for (uint256 i; i < lh.usersLength(); ++i) {
            (uint256 a,) = lockC.lockedOf(lh.users(i));
            sum += a;
        }
        assertEq(lockC.totalLocked(), sum);
    }

    /// (b) the lock always holds at least totalLocked.
    function invariant_solvent() public view {
        assertGe(token.balanceOf(address(lockC)), lockC.totalLocked());
    }

    /// (c) every lock can be unlocked after its time, for its exact amount (checked on a snapshot).
    function invariant_everyLockUnlockable() public {
        assertEq(lh.unlockFailures(), 0, "an unlock after unlockAt failed during the run");
        uint256 snap = vm.snapshotState();
        uint64 latest;
        for (uint256 i; i < lh.usersLength(); ++i) {
            (, uint64 at) = lockC.lockedOf(lh.users(i));
            if (at > latest) latest = at;
        }
        if (latest > block.timestamp) vm.warp(latest);
        for (uint256 i; i < lh.usersLength(); ++i) {
            address u = lh.users(i);
            (uint256 a,) = lockC.lockedOf(u);
            if (a == 0) continue;
            uint256 before = token.balanceOf(u);
            vm.prank(u);
            lockC.unlock();
            assertEq(token.balanceOf(u) - before, a);
        }
        assertEq(lockC.totalLocked(), 0);
        vm.revertToState(snap);
    }

    /// (d) the anchor's latestHour never decreases and posted roots never change.
    function invariant_anchorMonotonicWriteOnce() public view {
        assertFalse(ah.decreased(), "latestHour decreased");
        uint256 n = ah.postedLength();
        for (uint256 i; i < n; ++i) {
            uint64 h = ah.posted(i);
            (bytes32 root,,) = anchor.rootOf(h);
            assertEq(root, ah.expected(h), "posted root changed");
        }
        if (n > 0) assertEq(anchor.latestHour(), ah.posted(n - 1));
    }
}
