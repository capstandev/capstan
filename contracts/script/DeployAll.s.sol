// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {CPST} from "../src/CPST.sol";
import {DeployAnchorLock} from "./DeployAnchorLock.s.sol";
import {LocalVault} from "../test/mocks/LocalVault.sol";
import {Guard} from "./lib/Guard.sol";
import {Deployments} from "./lib/Deployments.sol";
import {SafeCheck} from "./lib/SafeCheck.sol";

/// @title DeployAll
/// @notice Deploys, in order, CPST (whole supply to the brand Safe) -> CPSTLock(CPST) -> CapstanReceiptAnchor(poster),
/// skipping anything already in the deployment file with code on chain, then writes the file. Inputs: BRAND_SAFE,
/// POSTER_ADDRESS, EXPECTED_CHAIN_ID, CAPSTAN_DEPLOY_ARMED, and on 4663 CAPSTAN_MAINNET_GO. Off the local chain the
/// brand Safe must pass the real Safe check (Safe 1.4.1 proxy, official singleton, threshold >= 2, no modules, no
/// guard) before anything is sent; on 31337 with no BRAND_SAFE a code-only stand-in holds the local supply.
contract DeployAll is DeployAnchorLock {
    /// @notice Deploy what is missing, then write the deployment file.
    function run() external override {
        Guard.check();
        string memory p = Deployments.path();
        Deployments.Data memory d = Deployments.read(p);
        address safe = vm.envOr("BRAND_SAFE", address(0));
        address poster = vm.envAddress("POSTER_ADDRESS");
        if (block.chainid != 31337) SafeCheck.check(safe);
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        bool changed;
        (d, changed) = deployAll(d, safe, poster, deployer);
        vm.stopBroadcast();
        if (changed) {
            Deployments.write(p, d);
            console.log("wrote", p);
        }
    }

    /// @notice The ordered deploy steps, shared with tests (which call it without a broadcast).
    /// @return out The updated record.
    /// @return changed True when anything was deployed.
    function deployAll(Deployments.Data memory d, address safe, address poster, address deployer)
        public
        returns (Deployments.Data memory out, bool changed)
    {
        if (block.chainid != 31337) {
            SafeCheck.check(safe);
        } else if (safe == address(0)) {
            safe = address(new LocalVault());
        }
        if (d.cpst != address(0) && d.cpst.code.length > 0) {
            CPST t = CPST(d.cpst);
            require(
                keccak256(bytes(t.symbol())) == keccak256("CPST") && t.totalSupply() <= t.SUPPLY(),
                "deployment file CPST entry is not CPST"
            );
            console.log("skip: already deployed at", d.cpst);
        } else {
            d.cpst = address(new CPST(safe));
            d.cpstBlock = block.number;
            d.cpstSymbol = "CPST";
            d.cpstDecimals = 18;
            d.cpstSupply = "1000000000";
            changed = true;
        }
        bool more;
        (d, more) = deploy(d, poster, d.cpst, deployer);
        if (changed) {
            d.chainId = block.chainid;
            d.deployer = deployer;
        }
        out = d;
        changed = changed || more;
    }
}
