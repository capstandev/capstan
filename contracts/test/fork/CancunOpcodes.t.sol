// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

/// Uses the Cancun opcodes the contracts compile for (evm_version = "cancun"): PUSH0 (emitted by the compiler on every
/// constant zero), MCOPY, TSTORE and TLOAD. BLOBBASEFEE is left out: Arbitrum nodes refuse it (checked below).
contract CancunProbe {
    function probe() external returns (uint256 transientValue, bytes32 copied) {
        assembly {
            tstore(0x01, 0xc0ffee)
            transientValue := tload(0x01)
            let p := mload(0x40)
            mstore(p, not(0xc0ffee))
            mcopy(add(p, 0x20), p, 0x20)
            copied := mload(add(p, 0x20))
        }
    }
}

/// Creation code only: deploys the probe, calls it and returns the result as its "runtime code", so a plain eth_call
/// with no `to` runs every opcode on the real node and nothing is ever sent.
contract CancunProbeRunner {
    constructor() {
        (uint256 t, bytes32 m) = new CancunProbe().probe();
        bytes memory out = abi.encode(t, m);
        assembly {
            return(add(out, 0x20), mload(out))
        }
    }
}

/// Robinhood Chain (4663) runs the Cancun opcodes the contracts use. The fork tests skip without RHC_RPC_URL:
/// (1) deploy and call the probe on a local fork of 4663 (local EVM, fork state); (2) eth_call the runner's creation
/// code against the RPC itself (vm.rpc), which executes on the chain's own node; (3) the node refuses BLOBBASEFEE.
/// The offline tests check that the probe carries PUSH0 and that no deployed contract uses an opcode the node refuses.
/// Read-only: nothing is broadcast.
contract CancunOpcodesForkTest is Test {
    bytes32 internal constant WORD = bytes32(~uint256(0xc0ffee));
    uint8 internal constant OP_PUSH0 = 0x5f;
    uint8 internal constant OP_BLOBBASEFEE = 0x4a;

    function _fork() internal {
        string memory rpc = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663, "not a Robinhood Chain mainnet fork");
    }

    /// True when `op` appears as an opcode (PUSH1..PUSH32 immediates are skipped, the metadata tail is cut).
    function _hasOp(bytes memory code, uint8 op) internal pure returns (bool) {
        for (uint256 i = 0; i < code.length; i++) {
            uint8 c = uint8(code[i]);
            if (c == op) return true;
            if (c == 0xfe) return false; // INVALID marks the start of the data and metadata section
            if (c >= 0x60 && c <= 0x7f) i += c - 0x5f;
        }
        return false;
    }

    function test_fork_cancunProbeOnFork() public {
        _fork();
        (uint256 t, bytes32 m) = new CancunProbe().probe();
        assertEq(t, 0xc0ffee, "TSTORE/TLOAD");
        assertEq(m, WORD, "MCOPY");
    }

    function test_fork_cancunProbeOnNode() public {
        _fork();
        string memory params =
            string.concat('[{"data":"', vm.toString(type(CancunProbeRunner).creationCode), '"},"latest"]');
        (uint256 t, bytes32 m) = abi.decode(vm.rpc("eth_call", params), (uint256, bytes32));
        assertEq(t, 0xc0ffee, "TSTORE/TLOAD on the node");
        assertEq(m, WORD, "MCOPY on the node");
    }

    /// BLOBBASEFEE (0x4a) then RETURN(0, 32): the node answers "BLOBBASEFEE is not supported on Arbitrum".
    function test_fork_nodeRefusesBlobBaseFee() public {
        _fork();
        try vm.rpc("eth_call", '[{"data":"0x4a5f5260205ff3"},"latest"]') returns (bytes memory) {
            fail(); // the node ran BLOBBASEFEE: record it in chain-facts and drop this test
        } catch {}
    }

    function test_probeUsesPush0() public pure {
        assertTrue(_hasOp(type(CancunProbe).runtimeCode, OP_PUSH0), "PUSH0 in the probe");
    }

    function test_contractsAvoidBlobBaseFee() public view {
        string[3] memory names = ["CPST", "CPSTLock", "CapstanReceiptAnchor"];
        for (uint256 i = 0; i < names.length; i++) {
            string memory f = string.concat(names[i], ".sol:", names[i]);
            assertFalse(_hasOp(vm.getDeployedCode(f), OP_BLOBBASEFEE), string.concat(names[i], " uses BLOBBASEFEE"));
            assertFalse(_hasOp(vm.getCode(f), OP_BLOBBASEFEE), string.concat(names[i], " init uses BLOBBASEFEE"));
        }
    }
}
