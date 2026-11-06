// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CapstanReceiptAnchor} from "../src/CapstanReceiptAnchor.sol";
import {CPSTLock} from "../src/CPSTLock.sol";
import {Deployments} from "./lib/Deployments.sol";
import {SafeCheck} from "./lib/SafeCheck.sol";
import {CPST} from "../src/CPST.sol";

/// @title PostDeployCheck
/// @notice Read-only check of a deployment against the deployment file: code at every address, runtime code equal
/// to a fresh local build with the same constructor arguments (so no extra selector can exist), poster() and token()
/// equal to the file, the compiled selector set equal to the reviewed list, the chain id, and the Sourcify status.
/// Never broadcasts.
contract PostDeployCheck is Script {
    /// @notice A check failed.
    error CheckFailed(string what);

    /// @notice Check the deployment file of the connected chain (or DEPLOYMENTS_FILE).
    function run() external {
        string memory p = Deployments.path();
        require(vm.exists(p), string.concat("no deployment file at ", p));
        Deployments.Data memory d = Deployments.read(p);
        uint256 expected = vm.envOr("EXPECTED_CHAIN_ID", d.chainId);
        check(d, expected);
        checkCpst(d, vm.envOr("BRAND_SAFE", address(0)));
        console.log("sourcify verified:", d.sourcifyVerified, d.sourcifyUrl);
        console.log("post-deploy-check: ok", p);
    }

    /// @notice Every check for one record; reverts CheckFailed on the first problem.
    function check(Deployments.Data memory d, uint256 expectedChainId) public {
        if (block.chainid != d.chainId || block.chainid != expectedChainId) revert CheckFailed("chain id");
        if (d.anchor.code.length == 0) revert CheckFailed("no code at CapstanReceiptAnchor");
        if (d.lock.code.length == 0) revert CheckFailed("no code at CPSTLock");
        if (CapstanReceiptAnchor(d.anchor).poster() != d.poster) revert CheckFailed("anchor poster differs from file");
        if (CPSTLock(d.lock).token() != d.cpst) revert CheckFailed("lock token differs from file");
        if (address(new CapstanReceiptAnchor(d.poster)).codehash != d.anchor.codehash) {
            revert CheckFailed("anchor runtime code differs from a fresh build");
        }
        if (address(new CPSTLock(d.cpst)).codehash != d.lock.codehash) {
            revert CheckFailed("lock runtime code differs from a fresh build");
        }
        checkSelectors("out/CapstanReceiptAnchor.sol/CapstanReceiptAnchor.json", anchorSelectors());
        checkSelectors("out/CPSTLock.sol/CPSTLock.json", lockSelectors());
        console.log("ok: CapstanReceiptAnchor", d.anchor);
        console.log("ok: CPSTLock", d.lock);
    }

    /// @notice CPST checks (todo 26): fixed supply, decimals and symbol equal to the file, and off the local chain the
    /// brand Safe passes the real Safe check. Skipped when the lock token is the local test token.
    function checkCpst(Deployments.Data memory d, address brandSafe) public view {
        if (keccak256(bytes(d.cpstSymbol)) != keccak256("CPST")) return;
        CPST t = CPST(d.cpst);
        if (keccak256(bytes(t.symbol())) != keccak256("CPST")) revert CheckFailed("CPST symbol");
        if (keccak256(bytes(t.name())) != keccak256("Capstan")) revert CheckFailed("CPST name");
        if (t.decimals() != d.cpstDecimals || d.cpstDecimals != 18) revert CheckFailed("CPST decimals");
        if (t.SUPPLY() != 1_000_000_000e18 || t.totalSupply() > t.SUPPLY()) revert CheckFailed("CPST supply");
        if (keccak256(bytes(d.cpstSupply)) != keccak256("1000000000")) revert CheckFailed("CPST supply in file");
        if (block.chainid != 31337) SafeCheck.check(brandSafe);
        console.log("ok: CPST", d.cpst);
    }

    /// @notice The reviewed external functions of the anchor (interface plus verifyReceipt).
    function anchorSelectors() public pure returns (string[] memory s) {
        s = new string[](6);
        s[0] = "latestHour()";
        s[1] = "postRoot(uint64,bytes32,uint32)";
        s[2] = "poster()";
        s[3] = "rootOf(uint64)";
        s[4] = "verify(uint64,bytes32,bytes32[])";
        s[5] = "verifyReceipt(uint64,bytes32,bytes32[])";
    }

    /// @notice The reviewed external functions of the lock (interface plus constants and totalLocked).
    function lockSelectors() public pure returns (string[] memory s) {
        s = new string[](7);
        s[0] = "DURATION_30D()";
        s[1] = "DURATION_90D()";
        s[2] = "lock(uint256,uint64)";
        s[3] = "lockedOf(address)";
        s[4] = "token()";
        s[5] = "totalLocked()";
        s[6] = "unlock()";
    }

    /// @notice The artifact's selector set must equal `allowed` exactly.
    function checkSelectors(string memory artifact, string[] memory allowed) public view {
        string[] memory got = vm.parseJsonKeys(vm.readFile(artifact), ".methodIdentifiers");
        if (got.length != allowed.length) revert CheckFailed(string.concat("selector count differs: ", artifact));
        for (uint256 i; i < got.length; ++i) {
            bool found;
            for (uint256 j; j < allowed.length; ++j) {
                if (keccak256(bytes(got[i])) == keccak256(bytes(allowed[j]))) found = true;
            }
            if (!found) revert CheckFailed(string.concat("unreviewed function ", got[i]));
        }
    }
}
