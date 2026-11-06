// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

interface IERC20Like {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function decimals() external view returns (uint8);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// The Lighter-RH deposit call the adapter builds, run on a fork of Robinhood Chain (4663). Skips unless RHC_RPC_URL
/// is set. Nothing is broadcast: forge runs the calls on its local fork. The depositor is a fresh address (never an
/// anvil default account: those carry EIP-7702 sweepers on 4663).
contract LighterRhDepositForkTest is Test {
    // Pins from packages/schema/src/constants/chains.ts (venue-lighter.md, 2026-11-05)
    address internal constant DEPOSIT = 0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d;
    address internal constant IMPLEMENTATION = 0x998ecf039Eb110b72F5F6C1Ea31C2fA41a458FAA;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc; // not-a-key (EIP-1967 slot)
    // deposit(address _to, uint16 _assetIndex, uint8 _routeType, uint256 _amount), selector from the Lighter docs
    bytes4 internal constant DEPOSIT_SELECTOR = 0x8a857083;
    uint16 internal constant USDG_ASSET_INDEX = 3;
    uint8 internal constant ROUTE_PERPS = 0;

    address internal user;

    function setUp() public {
        string memory url = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        user = makeAddr("capstan-lighter-rh-depositor");
    }

    function test_depositOnFork() public {
        assertEq(block.chainid, 4663, "not a Robinhood Chain fork");
        assertEq(address(uint160(uint256(vm.load(DEPOSIT, IMPL_SLOT)))), IMPLEMENTATION, "implementation moved");
        assertEq(bytes4(keccak256("deposit(address,uint16,uint8,uint256)")), DEPOSIT_SELECTOR);
        IERC20Like usdg = IERC20Like(USDG);
        assertEq(usdg.decimals(), 6);
        uint256 amount = 1_000_000; // 1 USDG, the venue minimum

        // fund the fresh address from the deposit contract's own USDG (the token is a facet proxy, so a storage-slot
        // deal is not reliable); this only moves fork-local balances
        vm.prank(DEPOSIT);
        assertTrue(usdg.transfer(user, amount));
        assertEq(usdg.balanceOf(user), amount);

        uint256 before = usdg.balanceOf(DEPOSIT);
        vm.startPrank(user);
        assertTrue(usdg.approve(DEPOSIT, amount)); // exact amount, never unlimited
        (bool ok, bytes memory ret) =
            DEPOSIT.call(abi.encodeWithSelector(DEPOSIT_SELECTOR, user, USDG_ASSET_INDEX, ROUTE_PERPS, amount));
        vm.stopPrank();
        assertTrue(ok, string(ret));
        assertEq(usdg.balanceOf(DEPOSIT), before + amount, "deposit contract balance did not rise by the amount");
        assertEq(usdg.balanceOf(user), 0);
        assertEq(usdg.allowance(user, DEPOSIT), 0, "approval left over");
    }

    function test_belowMinimumReverts() public {
        IERC20Like usdg = IERC20Like(USDG);
        uint256 amount = 999_999;
        vm.prank(DEPOSIT);
        assertTrue(usdg.transfer(user, amount));
        vm.startPrank(user);
        usdg.approve(DEPOSIT, amount);
        (bool ok,) = DEPOSIT.call(abi.encodeWithSelector(DEPOSIT_SELECTOR, user, USDG_ASSET_INDEX, ROUTE_PERPS, amount));
        vm.stopPrank();
        assertFalse(ok, "a deposit under 1 USDG must revert");
    }
}
