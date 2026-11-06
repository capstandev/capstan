// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CPSTLock} from "../src/CPSTLock.sol";
import {ICPSTLock} from "../src/interfaces/ICPSTLock.sol";
import {MockERC20, FeeOnTransferToken, FalseReturnToken, ReentrantToken} from "./mocks/MockERC20.sol";

contract LockTest is Test {
    MockERC20 internal token;
    CPSTLock internal lockC;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockERC20("Capstan", "CPST");
        lockC = new CPSTLock(address(token));
        for (uint256 i; i < 2; ++i) {
            address u = i == 0 ? alice : bob;
            token.mint(u, 1e30);
            vm.prank(u);
            token.approve(address(lockC), type(uint256).max);
        }
    }

    function _lock(address u, uint256 amount, uint64 d) internal {
        vm.prank(u);
        lockC.lock(amount, d);
    }

    /// R7: only 0, 30 days and 90 days are accepted.
    function testFuzz_badDuration(uint64 d) public {
        vm.assume(d != 0 && d != 30 days && d != 90 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CPSTLock.BadDuration.selector, d));
        lockC.lock(1e18, d);
        _lock(alice, 1e18, 0);
        _lock(alice, 1e18, 30 days);
        _lock(alice, 1e18, 90 days);
        (uint256 a,) = lockC.lockedOf(alice);
        assertEq(a, 3e18);
    }

    /// R8: unlock always succeeds after unlockAt and returns the exact amount to the locker.
    function testFuzz_unlockAlwaysAfter(uint256 amount, uint8 dSel, uint64 extra) public {
        amount = bound(amount, 1, 1e30);
        uint64 d = [uint64(0), 30 days, 90 days][dSel % 3];
        uint256 before = token.balanceOf(alice);
        _lock(alice, amount, d);
        (uint256 a, uint64 at) = lockC.lockedOf(alice);
        assertEq(a, amount);
        assertEq(at, block.timestamp + d);
        if (d > 0) {
            vm.warp(at - 1);
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(CPSTLock.StillLocked.selector, at));
            lockC.unlock();
        }
        vm.warp(uint256(at) + bound(extra, 0, 100 * 365 days));
        vm.prank(alice);
        lockC.unlock();
        assertEq(token.balanceOf(alice), before, "exact amount back");
        assertEq(token.balanceOf(address(lockC)), 0);
        assertEq(lockC.totalLocked(), 0);
        (a, at) = lockC.lockedOf(alice);
        assertEq(a, 0);
        assertEq(at, 0);
        vm.prank(alice);
        vm.expectRevert(CPSTLock.NothingLocked.selector);
        lockC.unlock();
    }

    /// R9: no external function other than unlock lowers the lock's token balance. The selector list is read from the
    /// compiled artifact, so a new function fails this test until it is classified here.
    function test_onlyUnlockMovesTokens() public {
        string memory art = vm.readFile("out/CPSTLock.sol/CPSTLock.json");
        string[] memory sigs = vm.parseJsonKeys(art, ".methodIdentifiers");
        string[7] memory known = [
            "DURATION_30D()",
            "DURATION_90D()",
            "lock(uint256,uint64)",
            "lockedOf(address)",
            "token()",
            "totalLocked()",
            "unlock()"
        ];
        assertEq(sigs.length, known.length, "selector set changed: classify the new function");
        for (uint256 i; i < sigs.length; ++i) {
            bool found;
            for (uint256 j; j < known.length; ++j) {
                if (keccak256(bytes(sigs[i])) == keccak256(bytes(known[j]))) found = true;
            }
            assertTrue(found, string.concat("unclassified function: ", sigs[i]));
        }
        _lock(alice, 5e18, 90 days);
        _lock(bob, 7e18, 30 days);
        uint256 bal = token.balanceOf(address(lockC));
        address[3] memory callers = [alice, bob, makeAddr("stranger")];
        bytes[6] memory calls = [
            abi.encodeWithSignature("DURATION_30D()"),
            abi.encodeWithSignature("DURATION_90D()"),
            abi.encodeCall(CPSTLock.lock, (1e18, 0)),
            abi.encodeCall(CPSTLock.lockedOf, (alice)),
            abi.encodeWithSignature("token()"),
            abi.encodeWithSignature("totalLocked()")
        ];
        for (uint256 c; c < callers.length; ++c) {
            for (uint256 k; k < calls.length; ++k) {
                vm.prank(callers[c]);
                (bool ok,) = address(lockC).call(calls[k]);
                ok;
                uint256 now_ = token.balanceOf(address(lockC));
                assertGe(now_, bal, "a non-unlock function lowered the balance");
                bal = now_;
            }
            // unlock before the time moves nothing
            vm.prank(callers[c]);
            (bool ok2,) = address(lockC).call(abi.encodeCall(CPSTLock.unlock, ()));
            assertFalse(ok2);
            assertEq(token.balanceOf(address(lockC)), bal);
        }
        // a random selector and plain ETH are refused
        (bool okr,) = address(lockC).call(abi.encodeWithSelector(0xdeadbeef, alice, 1e18));
        assertFalse(okr);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool oke,) = address(lockC).call{value: 1}("");
        assertFalse(oke);
        // only unlock moves tokens out, only to the locker, only its own amount
        vm.warp(block.timestamp + 90 days);
        (uint256 aliceAmt,) = lockC.lockedOf(alice);
        uint256 aliceBefore = token.balanceOf(alice);
        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(alice);
        lockC.unlock();
        assertEq(token.balanceOf(alice) - aliceBefore, aliceAmt);
        assertEq(token.balanceOf(bob), bobBefore, "nobody else is paid");
        assertEq(token.balanceOf(address(lockC)), bal - aliceAmt);
    }

    /// R10: donations (1 wei and large) change no lock and no total; every user still unlocks exactly.
    function test_donationIgnored() public {
        _lock(alice, 3e18, 30 days);
        _lock(bob, 11e18, 0);
        token.mint(address(this), 1e27 + 1);
        token.transfer(address(lockC), 1);
        (uint256 a, uint64 at) = lockC.lockedOf(alice);
        (uint256 b,) = lockC.lockedOf(bob);
        assertEq(a, 3e18);
        assertEq(b, 11e18);
        assertEq(lockC.totalLocked(), 14e18);
        token.transfer(address(lockC), 1e27);
        (a,) = lockC.lockedOf(alice);
        (b,) = lockC.lockedOf(bob);
        assertEq(a, 3e18);
        assertEq(b, 11e18);
        assertEq(lockC.totalLocked(), 14e18);
        vm.warp(at);
        uint256 ab = token.balanceOf(alice);
        uint256 bb = token.balanceOf(bob);
        vm.prank(alice);
        lockC.unlock();
        vm.prank(bob);
        lockC.unlock();
        assertEq(token.balanceOf(alice) - ab, 3e18);
        assertEq(token.balanceOf(bob) - bb, 11e18);
        assertEq(lockC.totalLocked(), 0);
        assertEq(token.balanceOf(address(lockC)), 1e27 + 1, "the donation stays stuck by design");
        // a later locker is not credited with the donation
        _lock(alice, 1, 0);
        (a,) = lockC.lockedOf(alice);
        assertEq(a, 1);
    }

    /// R11: lock pulls only from msg.sender and refuses a short (fee-on-transfer) receipt.
    function test_pullFromSenderExact() public {
        uint256 ab = token.balanceOf(alice);
        uint256 bb = token.balanceOf(bob);
        _lock(alice, 2e18, 0);
        assertEq(ab - token.balanceOf(alice), 2e18, "pulled from the caller");
        assertEq(token.balanceOf(bob), bb, "never from anyone else, even with an allowance");

        FeeOnTransferToken fee = new FeeOnTransferToken();
        CPSTLock feeLock = new CPSTLock(address(fee));
        fee.mint(alice, 1e20);
        vm.startPrank(alice);
        fee.approve(address(feeLock), type(uint256).max);
        vm.expectRevert(CPSTLock.TransferShort.selector);
        feeLock.lock(1e18, 0);
        vm.stopPrank();

        FalseReturnToken f = new FalseReturnToken();
        CPSTLock fLock = new CPSTLock(address(f));
        f.setFail(true);
        vm.prank(alice);
        vm.expectRevert(CPSTLock.TransferFailed.selector);
        fLock.lock(1e18, 0);

        vm.prank(alice);
        vm.expectRevert(CPSTLock.ZeroAmount.selector);
        lockC.lock(0, 0);

        vm.expectRevert(CPSTLock.TokenNotContract.selector);
        new CPSTLock(alice);
    }

    /// R12: adding to a lock never shortens it: unlockAt = max(existing, now + duration).
    function testFuzz_neverShortens(uint8 d1, uint8 d2, uint64 gap) public {
        uint64[3] memory ds = [uint64(0), 30 days, 90 days];
        uint64 first = ds[d1 % 3];
        uint64 second = ds[d2 % 3];
        _lock(alice, 1e18, first);
        (, uint64 at1) = lockC.lockedOf(alice);
        vm.warp(block.timestamp + bound(gap, 0, 200 days));
        _lock(alice, 2e18, second);
        (uint256 a, uint64 at2) = lockC.lockedOf(alice);
        assertEq(a, 3e18);
        assertGe(at2, at1, "never shorter");
        uint256 target = block.timestamp + second;
        assertEq(at2, at1 > target ? at1 : target, "max(existing, now + duration)");
    }

    function test_eventsAndTotals() public {
        vm.expectEmit(true, false, false, true, address(lockC));
        emit ICPSTLock.Locked(alice, 4e18, uint64(block.timestamp + 30 days));
        _lock(alice, 4e18, 30 days);
        assertEq(lockC.totalLocked(), 4e18);
        assertEq(lockC.token(), address(token));
        vm.warp(block.timestamp + 30 days);
        vm.expectEmit(true, false, false, true, address(lockC));
        emit ICPSTLock.Unlocked(alice, 4e18);
        vm.prank(alice);
        lockC.unlock();
    }

    /// A token that calls back into the lock during transferFrom cannot reenter unlock.
    function test_reentryBlocked() public {
        ReentrantToken re = new ReentrantToken();
        CPSTLock reLock = new CPSTLock(address(re));
        address attacker = address(re);
        re.mint(alice, 10e18);
        re.mint(attacker, 10e18);
        vm.prank(alice);
        re.approve(address(reLock), type(uint256).max);
        vm.prank(attacker);
        re.approve(address(reLock), type(uint256).max);
        // the token contract itself holds an unlockable lock (duration 0)
        vm.prank(attacker);
        reLock.lock(5e18, 0);
        re.setTarget(address(reLock));
        vm.prank(alice);
        reLock.lock(1e18, 0);
        assertTrue(re.attempted(), "callback ran");
        assertFalse(re.reentered(), "reentrant unlock must fail");
        assertEq(re.reentryError(), abi.encodeWithSelector(CPSTLock.Reentrant.selector));
        (uint256 a,) = reLock.lockedOf(attacker);
        assertEq(a, 5e18, "attacker lock untouched");
        assertEq(reLock.totalLocked(), 6e18);
    }
}
