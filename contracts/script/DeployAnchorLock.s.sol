// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CapstanReceiptAnchor} from "../src/CapstanReceiptAnchor.sol";
import {CPSTLock} from "../src/CPSTLock.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {Guard} from "./lib/Guard.sol";
import {Deployments} from "./lib/Deployments.sol";

/// @title DeployAnchorLock
/// @notice Deploys CPSTLock and CapstanReceiptAnchor and records them in the deployment file. Inputs:
/// POSTER_ADDRESS, CPST_ADDRESS (or the CPST entry of the deployment file), EXPECTED_CHAIN_ID, CAPSTAN_DEPLOY_ARMED,
/// and on 4663 CAPSTAN_MAINNET_GO. A contract already in the file with code on chain is skipped. On the local chain
/// (31337) with no CPST address a plain test token stands in as the lock token.
contract DeployAnchorLock is Script {
    /// @notice Deploy what is missing, then write the deployment file.
    function run() external virtual {
        Guard.check();
        string memory p = Deployments.path();
        Deployments.Data memory d = Deployments.read(p);
        address poster = vm.envAddress("POSTER_ADDRESS");
        address token = vm.envOr("CPST_ADDRESS", d.cpst);
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        bool changed;
        (d, changed) = deploy(d, poster, token, deployer);
        vm.stopBroadcast();
        if (changed) {
            Deployments.write(p, d);
            console.log("wrote", p);
        }
    }

    /// @notice The deploy steps, shared with tests (which call it without a broadcast).
    /// @return out The updated record.
    /// @return changed True when anything was deployed.
    function deploy(Deployments.Data memory d, address poster, address token, address deployer)
        public
        returns (Deployments.Data memory out, bool changed)
    {
        require(poster != address(0), "POSTER_ADDRESS is required");
        if (token == address(0) || token.code.length == 0) {
            require(block.chainid == 31337, "CPST_ADDRESS with code is required off the local chain");
            if (d.cpst != address(0) && d.cpst.code.length > 0) {
                token = d.cpst;
                console.log("skip: already deployed at", token);
            } else {
                token = address(new MockERC20("Local Test Token", "TEST"));
                d.cpst = token;
                d.cpstBlock = block.number;
                d.cpstSymbol = "TEST";
                d.cpstDecimals = 18;
                d.cpstSupply = "0";
                changed = true;
            }
        } else if (d.cpst == address(0)) {
            d.cpst = token;
        }
        if (d.lock != address(0) && d.lock.code.length > 0) {
            require(CPSTLock(d.lock).token() == token, "deployment file lock uses another token");
            console.log("skip: already deployed at", d.lock);
        } else {
            d.lock = address(new CPSTLock(token));
            d.lockBlock = block.number;
            changed = true;
        }
        if (d.anchor != address(0) && d.anchor.code.length > 0) {
            require(
                CapstanReceiptAnchor(d.anchor).poster() == poster,
                "deployment file anchor has another poster: deploy a new anchor deliberately (runbook)"
            );
            console.log("skip: already deployed at", d.anchor);
        } else {
            d.anchor = address(new CapstanReceiptAnchor(poster));
            d.anchorBlock = block.number;
            d.poster = poster;
            changed = true;
        }
        if (changed) {
            d.chainId = block.chainid;
            d.deployer = deployer;
        }
        out = d;
    }
}
