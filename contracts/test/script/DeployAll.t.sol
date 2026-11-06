// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployAll} from "../../script/DeployAll.s.sol";
import {PostDeployCheck} from "../../script/PostDeployCheck.s.sol";
import {Deployments} from "../../script/lib/Deployments.sol";
import {CPST} from "../../src/CPST.sol";
import {CPSTLock} from "../../src/CPSTLock.sol";
import {CapstanReceiptAnchor} from "../../src/CapstanReceiptAnchor.sol";
import {LocalVault} from "../mocks/LocalVault.sol";

/// R7: DeployAll deploys CPST -> CPSTLock -> CapstanReceiptAnchor and writes one file PostDeployCheck accepts.
contract DeployAllTest is Test {
    function test_orderAndFile() public {
        DeployAll dep = new DeployAll();
        address safe = address(new LocalVault());
        address poster = makeAddr("poster");
        uint64 n = vm.getNonce(address(dep));
        Deployments.Data memory d;
        bool changed;
        (d, changed) = dep.deployAll(d, safe, poster, address(this));
        assertTrue(changed);
        assertEq(d.cpst, vm.computeCreateAddress(address(dep), n), "CPST first");
        assertEq(d.lock, vm.computeCreateAddress(address(dep), n + 1), "then the lock");
        assertEq(d.anchor, vm.computeCreateAddress(address(dep), n + 2), "then the anchor");
        assertEq(CPSTLock(d.lock).token(), d.cpst);
        assertEq(CapstanReceiptAnchor(d.anchor).poster(), poster);
        assertEq(CPST(d.cpst).balanceOf(safe), 1_000_000_000e18);
        assertEq(d.cpstSupply, "1000000000");

        string memory p = "deployments/local/test-deployall.json";
        vm.createDir("deployments/local", true);
        Deployments.write(p, d);
        Deployments.Data memory r = Deployments.read(p);
        vm.removeFile(p);
        assertEq(r.cpst, d.cpst);
        assertEq(r.cpstSymbol, "CPST");
        assertEq(r.cpstDecimals, 18);
        PostDeployCheck pdc = new PostDeployCheck();
        pdc.check(r, 31337);
        pdc.checkCpst(r, safe);

        // a second run deploys nothing
        (d, changed) = dep.deployAll(r, safe, poster, address(this));
        assertFalse(changed);
        assertEq(d.cpst, r.cpst);

        // off the local chain an EOA or plain contract as the brand Safe is refused before anything deploys
        vm.chainId(46630);
        Deployments.Data memory empty;
        vm.expectRevert();
        dep.deployAll(empty, makeAddr("eoa safe"), poster, address(this));
    }
}
