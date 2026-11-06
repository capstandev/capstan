// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PostDeployCheck} from "../../script/PostDeployCheck.s.sol";
import {DeployAnchorLock} from "../../script/DeployAnchorLock.s.sol";
import {Deployments} from "../../script/lib/Deployments.sol";

contract PostDeployCheckTest is Test {
    PostDeployCheck internal pdc = new PostDeployCheck();
    DeployAnchorLock internal dep = new DeployAnchorLock();
    address internal poster = makeAddr("poster");

    function _deployed() internal returns (Deployments.Data memory d) {
        d.chainId = block.chainid;
        (d,) = dep.deploy(d, poster, address(0), address(this));
    }

    function test_acceptsAGoodDeployment() public {
        Deployments.Data memory d = _deployed();
        pdc.check(d, 31337);
    }

    /// R18: a deployment file whose poster differs from the on-chain poster() fails.
    function test_detectsMismatch() public {
        Deployments.Data memory d = _deployed();
        d.poster = makeAddr("someone else");
        vm.expectRevert(abi.encodeWithSelector(PostDeployCheck.CheckFailed.selector, "anchor poster differs from file"));
        pdc.check(d, 31337);

        d = _deployed();
        d.cpst = makeAddr("other token");
        vm.expectRevert(abi.encodeWithSelector(PostDeployCheck.CheckFailed.selector, "lock token differs from file"));
        pdc.check(d, 31337);

        d = _deployed();
        vm.expectRevert(abi.encodeWithSelector(PostDeployCheck.CheckFailed.selector, "chain id"));
        pdc.check(d, 46630);

        d = _deployed();
        d.anchor = makeAddr("empty");
        vm.expectRevert(abi.encodeWithSelector(PostDeployCheck.CheckFailed.selector, "no code at CapstanReceiptAnchor"));
        pdc.check(d, 31337);

        // same poster getter but different code (an impostor contract) fails the code-hash check
        d = _deployed();
        Impostor imp = new Impostor(poster);
        d.anchor = address(imp);
        vm.expectRevert(
            abi.encodeWithSelector(
                PostDeployCheck.CheckFailed.selector, "anchor runtime code differs from a fresh build"
            )
        );
        pdc.check(d, 31337);
    }

    function test_selectorListMatchesArtifacts() public view {
        pdc.checkSelectors("out/CapstanReceiptAnchor.sol/CapstanReceiptAnchor.json", pdc.anchorSelectors());
        pdc.checkSelectors("out/CPSTLock.sol/CPSTLock.json", pdc.lockSelectors());
    }

    function test_selectorListRejectsExtra() public {
        string[] memory short = new string[](5);
        string[] memory full = pdc.anchorSelectors();
        for (uint256 i; i < 5; ++i) {
            short[i] = full[i];
        }
        vm.expectRevert();
        pdc.checkSelectors("out/CapstanReceiptAnchor.sol/CapstanReceiptAnchor.json", short);
    }

    function test_deploySkipsWhatExists() public {
        Deployments.Data memory d = _deployed();
        address a = d.anchor;
        address l = d.lock;
        address t = d.cpst;
        bool changed;
        (d, changed) = dep.deploy(d, poster, address(0), address(this));
        assertFalse(changed, "second run deploys nothing");
        assertEq(d.anchor, a);
        assertEq(d.lock, l);
        assertEq(d.cpst, t);
        vm.expectRevert(bytes("deployment file anchor has another poster: deploy a new anchor deliberately (runbook)"));
        dep.deploy(d, makeAddr("new poster"), address(0), address(this));
    }

    function test_fileRoundTrip() public {
        Deployments.Data memory d = _deployed();
        string memory p = "deployments/local/test-roundtrip.json";
        vm.createDir("deployments/local", true);
        Deployments.write(p, d);
        Deployments.Data memory r = Deployments.read(p);
        vm.removeFile(p);
        assertEq(r.chainId, d.chainId);
        assertEq(r.anchor, d.anchor);
        assertEq(r.poster, d.poster);
        assertEq(r.lock, d.lock);
        assertEq(r.cpst, d.cpst);
        assertEq(r.deployer, address(this));
        assertEq(r.anchorBlock, d.anchorBlock);
        assertFalse(r.sourcifyVerified);
        pdc.check(r, 31337);
    }
}

contract Impostor {
    address public poster;

    constructor(address p) {
        poster = p;
    }
}
