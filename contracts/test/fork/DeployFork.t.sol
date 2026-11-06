// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {CapstanReceiptAnchor} from "../../src/CapstanReceiptAnchor.sol";
import {CPSTLock} from "../../src/CPSTLock.sol";
import {SortedPairMerkle} from "../../src/libs/SortedPairMerkle.sol";
import {CPST} from "../../src/CPST.sol";
import {BurnFixture} from "./BurnFixture.sol";
import {PostDeployCheck} from "../../script/PostDeployCheck.s.sol";
import {Deployments} from "../../script/lib/Deployments.sol";

/// R17: fork dry run on Robinhood Chain mainnet (4663). Skips without RHC_RPC_URL. Nothing is broadcast: the fork is
/// local. The deployer is a fresh labelled key funded with vm.deal, never one of anvil's default accounts (those carry
/// EIP-7702 sweepers on 4663).
contract DeployForkTest is Test {
    function _deploy(address deployer, address poster, address safe) internal returns (Deployments.Data memory d) {
        vm.startPrank(deployer, deployer);
        CPST token = new CPST(safe);
        CPSTLock lockC = new CPSTLock(address(token));
        CapstanReceiptAnchor anchor = new CapstanReceiptAnchor(poster);
        vm.stopPrank();
        d.chainId = block.chainid;
        d.anchor = address(anchor);
        d.poster = poster;
        d.lock = address(lockC);
        d.cpst = address(token);
        d.cpstSymbol = "CPST";
        d.cpstDecimals = 18;
        d.cpstSupply = "1000000000";
        d.deployer = deployer;
    }

    function _postAndVerify(CapstanReceiptAnchor anchor, address poster) internal {
        bytes32 s1 = sha256("receipt-1");
        bytes32 l0 = keccak256(abi.encodePacked(sha256("receipt-0")));
        bytes32 l1 = keccak256(abi.encodePacked(s1));
        bytes32 l2 = keccak256(abi.encodePacked(sha256("receipt-2")));
        bytes32 root = SortedPairMerkle.hashPair(SortedPairMerkle.hashPair(l0, l1), l2);
        uint64 hour = uint64(block.timestamp / 3600 - 1);
        vm.prank(poster);
        uint256 g = gasleft();
        anchor.postRoot(hour, root, 3);
        console.log("postRoot gas:", g - gasleft());
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = l0;
        proof[1] = l2;
        assertTrue(anchor.verifyReceipt(hour, s1, proof), "receipt verifies on the fork");
        assertFalse(anchor.verifyReceipt(hour, sha256("receipt-2"), proof), "another receipt does not");
    }

    function test_deployPostVerify() public {
        string memory rpc = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663, "fork is Robinhood Chain mainnet");
        Vm.Wallet memory deployer = vm.createWallet("capstan-fork-deployer");
        Vm.Wallet memory poster = vm.createWallet("capstan-fork-poster");
        assertEq(deployer.addr.code.length, 0, "fresh key has no code (no 7702 delegation)");
        vm.deal(deployer.addr, 1 ether);
        vm.deal(poster.addr, 0.1 ether);
        address[] memory owners = new address[](3);
        for (uint256 i; i < 3; ++i) {
            owners[i] = vm.createWallet(string.concat("capstan-fork-owner-", vm.toString(i))).addr;
        }
        address safe = BurnFixture.makeSafe(owners, 2, 7);
        Deployments.Data memory d = _deploy(deployer.addr, poster.addr, safe);
        _postAndVerify(CapstanReceiptAnchor(d.anchor), poster.addr);
        PostDeployCheck pdc = new PostDeployCheck();
        pdc.check(d, 4663);
        pdc.checkCpst(d, safe);
        vm.expectRevert(); // the same deployment with an EOA named as the brand Safe fails the Safe check
        pdc.checkCpst(d, deployer.addr);
    }
}
