// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {CPST} from "../src/CPST.sol";
import {LocalVault} from "./mocks/LocalVault.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract CPSTTest is Test {
    CPST internal t;
    address internal safe;
    address internal alice = makeAddr("alice");

    function setUp() public {
        safe = address(new LocalVault());
        t = new CPST(safe);
    }

    /// R1: exactly 1,000,000,000e18 minted to the Safe; no mint, no owner (selector list from the artifact).
    function test_fixedSupply_noMint() public view {
        assertEq(t.totalSupply(), 1_000_000_000e18);
        assertEq(t.SUPPLY(), 1_000_000_000e18);
        assertEq(t.balanceOf(safe), 1_000_000_000e18);
        assertEq(t.decimals(), 18);
        assertEq(t.symbol(), "CPST");
        assertEq(t.name(), "Capstan");
        string[] memory sigs = vm.parseJsonKeys(vm.readFile("out/CPST.sol/CPST.json"), ".methodIdentifiers");
        string[16] memory allowed = [
            "DOMAIN_SEPARATOR()",
            "SUPPLY()",
            "allowance(address,address)",
            "approve(address,uint256)",
            "balanceOf(address)",
            "burn(uint256)",
            "burnFrom(address,uint256)",
            "decimals()",
            "eip712Domain()",
            "name()",
            "nonces(address)",
            "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
            "symbol()",
            "totalSupply()",
            "transfer(address,uint256)",
            "transferFrom(address,address,uint256)"
        ];
        assertEq(sigs.length, 16, "selector set changed: review it");
        for (uint256 i; i < sigs.length; ++i) {
            bool found;
            for (uint256 j; j < 16; ++j) {
                if (keccak256(bytes(sigs[i])) == keccak256(bytes(allowed[j]))) found = true;
            }
            assertTrue(found, string.concat("unreviewed function: ", sigs[i]));
            string memory sig = vm.toLowercase(sigs[i]);
            uint256 none = type(uint256).max;
            assertEq(vm.indexOf(sig, "mint"), none, "no mint");
            assertEq(vm.indexOf(sig, "owner()"), none, "no owner");
            assertEq(vm.indexOf(sig, "pause"), none, "no pause");
            assertEq(vm.indexOf(sig, "blacklist"), none, "no blacklist");
        }
    }

    /// R2: transfers move exactly the amount (no fee, no blacklist, no pause).
    function testFuzz_plainTransfer(uint256 amount, address to) public {
        vm.assume(to != address(0) && to != safe);
        amount = bound(amount, 0, t.totalSupply());
        vm.prank(safe);
        t.transfer(to, amount);
        assertEq(t.balanceOf(to), amount);
        assertEq(t.balanceOf(safe), t.SUPPLY() - amount);
        assertEq(t.totalSupply(), t.SUPPLY());
        vm.prank(to);
        t.transfer(alice, amount);
        assertEq(t.balanceOf(alice), amount);
    }

    /// R3: the constructor refuses a recipient with no code (an EOA or zero).
    function test_safeMustBeContract() public {
        vm.expectRevert(CPST.SafeHasNoCode.selector);
        new CPST(alice);
        vm.expectRevert(CPST.SafeHasNoCode.selector);
        new CPST(address(0));
    }

    /// R4: burn lowers totalSupply by the amount and only burns the caller's own tokens.
    function test_burnOwnOnly() public {
        vm.prank(safe);
        t.transfer(alice, 100e18);
        vm.prank(alice);
        t.burn(40e18);
        assertEq(t.totalSupply(), t.SUPPLY() - 40e18);
        assertEq(t.balanceOf(alice), 60e18);
        // alice cannot burn the Safe's tokens (burn is caller-only; burnFrom needs an allowance)
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, alice, 0, 1));
        t.burnFrom(safe, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 60e18, 61e18));
        t.burn(61e18);
        assertEq(t.balanceOf(safe), t.SUPPLY() - 100e18);
    }

    /// R5: EIP-2612 permit with the token's own domain (name "Capstan", version "1", chain id); a replay fails.
    function test_permitReplay() public {
        Vm.Wallet memory owner = vm.createWallet("permit-owner");
        vm.prank(safe);
        t.transfer(owner.addr, 10e18);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Capstan"),
                keccak256("1"),
                block.chainid,
                address(t)
            )
        );
        assertEq(t.DOMAIN_SEPARATOR(), domain);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner.addr,
                alice,
                5e18,
                0,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(owner.privateKey, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        t.permit(owner.addr, alice, 5e18, deadline, v, r, s);
        assertEq(t.allowance(owner.addr, alice), 5e18);
        assertEq(t.nonces(owner.addr), 1);
        vm.expectRevert();
        t.permit(owner.addr, alice, 5e18, deadline, v, r, s);
        // a signature for another chain id does not verify here
        vm.chainId(46630);
        assertTrue(t.DOMAIN_SEPARATOR() != domain, "domain follows the chain id");
    }
}
