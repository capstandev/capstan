// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Guard} from "./Guard.sol";

/// @title Deployments
/// @notice Reads and writes contracts/deployments/<chainId>.json (schema in deployments/README.md). The path can be
/// overridden with DEPLOYMENTS_FILE (the local 31337 run writes deployments/local/31337.json, which is not committed).
library Deployments {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Data {
        uint256 chainId;
        address anchor;
        uint256 anchorBlock;
        address poster;
        address lock;
        uint256 lockBlock;
        address cpst;
        uint256 cpstBlock;
        string cpstSymbol;
        uint256 cpstDecimals;
        string cpstSupply;
        address deployer;
        bool sourcifyVerified;
        string sourcifyUrl;
    }

    /// @notice Arbitrum's ArbSys precompile (Robinhood Chain is an Arbitrum Orbit chain).
    address internal constant ARB_SYS = address(0x64);

    /// @notice The chain's own block number for the deployment record. On an Arbitrum chain the NUMBER opcode
    /// (`block.number`) answers the L1 block (about 26 million on 4663 in November 2026, while the L2 head is about
    /// 107 million), so a record written from it makes every log scan start tens of millions of blocks early. ArbSys
    /// arbBlockNumber() answers the L2 block that eth_getLogs and receipts use; other chains keep block.number.
    function chainBlock() internal view returns (uint256) {
        if (block.chainid == 4663 || block.chainid == 46630) {
            (bool ok, bytes memory ret) = ARB_SYS.staticcall(abi.encodeWithSignature("arbBlockNumber()"));
            if (ok && ret.length == 32) return abi.decode(ret, (uint256));
            revert("ArbSys arbBlockNumber() did not answer on an Arbitrum chain");
        }
        return block.number;
    }

    /// @notice The deployment file path for the connected chain (relative to the contracts folder).
    function path() internal view returns (string memory) {
        return VM.envOr("DEPLOYMENTS_FILE", string.concat("deployments/", VM.toString(block.chainid), ".json"));
    }

    function _addr(string memory json, string memory key) private view returns (address) {
        return VM.keyExistsJson(json, key) ? VM.parseJsonAddress(json, key) : address(0);
    }

    function _uint(string memory json, string memory key) private view returns (uint256) {
        return VM.keyExistsJson(json, key) ? VM.parseJsonUint(json, key) : 0;
    }

    function _str(string memory json, string memory key) private view returns (string memory) {
        return VM.keyExistsJson(json, key) ? VM.parseJsonString(json, key) : "";
    }

    /// @notice Read a deployment file; an absent file gives an empty record for the connected chain.
    function read(string memory p) internal view returns (Data memory d) {
        d.chainId = block.chainid;
        if (!VM.exists(p)) return d;
        string memory json = VM.readFile(p);
        d.chainId = VM.parseJsonUint(json, ".chainId");
        d.anchor = _addr(json, ".contracts.CapstanReceiptAnchor.address");
        d.anchorBlock = _uint(json, ".contracts.CapstanReceiptAnchor.block");
        d.poster = _addr(json, ".contracts.CapstanReceiptAnchor.poster");
        d.lock = _addr(json, ".contracts.CPSTLock.address");
        d.lockBlock = _uint(json, ".contracts.CPSTLock.block");
        d.cpst = _addr(json, ".contracts.CPST.address");
        d.cpstBlock = _uint(json, ".contracts.CPST.block");
        d.cpstSymbol = _str(json, ".contracts.CPST.symbol");
        d.cpstDecimals = _uint(json, ".contracts.CPST.decimals");
        d.cpstSupply = _str(json, ".contracts.CPST.supply");
        d.deployer = _addr(json, ".deployer");
        d.sourcifyVerified =
            VM.keyExistsJson(json, ".sourcify.verified") && VM.parseJsonBool(json, ".sourcify.verified");
        d.sourcifyUrl = _str(json, ".sourcify.url");
    }

    function _q(string memory s) private pure returns (string memory) {
        return string.concat('"', s, '"');
    }

    function _a(address a) private pure returns (string memory) {
        return _q(VM.toString(a));
    }

    /// @notice Render the record as the deployment-file JSON (stable key order).
    function render(Data memory d, uint256 ts) internal pure returns (string memory) {
        string memory c;
        if (d.anchor != address(0)) {
            c = string.concat(
                '    "CapstanReceiptAnchor": { "address": ',
                _a(d.anchor),
                ', "block": ',
                VM.toString(d.anchorBlock),
                ', "poster": ',
                _a(d.poster),
                " }"
            );
        }
        if (d.lock != address(0)) {
            c = string.concat(
                c,
                bytes(c).length > 0 ? ",\n" : "",
                '    "CPSTLock": { "address": ',
                _a(d.lock),
                ', "block": ',
                VM.toString(d.lockBlock),
                " }"
            );
        }
        if (d.cpst != address(0)) {
            c = string.concat(
                c,
                bytes(c).length > 0 ? ",\n" : "",
                '    "CPST": { "address": ',
                _a(d.cpst),
                ', "block": ',
                VM.toString(d.cpstBlock),
                ', "symbol": ',
                _q(d.cpstSymbol),
                ', "decimals": ',
                VM.toString(d.cpstDecimals),
                ', "supply": ',
                _q(d.cpstSupply),
                " }"
            );
        }
        string memory src = d.sourcifyVerified
            ? string.concat(
                '{ "verified": true',
                bytes(d.sourcifyUrl).length > 0 ? string.concat(', "url": ', _q(d.sourcifyUrl)) : "",
                " }"
            )
            : '{ "verified": false }';
        return string.concat(
            "{\n",
            '  "chainId": ',
            VM.toString(d.chainId),
            ",\n",
            '  "contracts": {\n',
            c,
            bytes(c).length > 0 ? "\n" : "",
            "  },\n",
            '  "deployer": ',
            _a(d.deployer),
            ",\n",
            '  "sourcify": ',
            src,
            ",\n",
            '  "updatedAt": ',
            _q(isoTime(ts)),
            "\n}\n"
        );
    }

    /// @notice Write the record to a deployment file.
    function write(string memory p, Data memory d) internal {
        VM.writeFile(p, render(d, block.timestamp));
    }

    /// @notice YYYY-MM-DDTHH:MM:SSZ of a unix time.
    function isoTime(uint256 ts) internal pure returns (string memory) {
        uint256 s = ts % 86400;
        return string.concat(Guard.utcDate(ts), "T", _two(s / 3600), ":", _two((s / 60) % 60), ":", _two(s % 60), "Z");
    }

    function _two(uint256 v) private pure returns (string memory) {
        return v < 10 ? string.concat("0", VM.toString(v)) : VM.toString(v);
    }
}
