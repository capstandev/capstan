// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @title Guard
/// @notice The armed-flag guard every broadcasting script calls before vm.startBroadcast (test/script/GuardScan.t.sol
/// fails the build when a broadcaster does not). It refuses unless CAPSTAN_DEPLOY_ARMED is "1", the chain id equals
/// EXPECTED_CHAIN_ID, and on Robinhood Chain mainnet (4663) CAPSTAN_MAINNET_GO equals "go-<today's UTC date>".
library Guard {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant MAINNET = 4663;

    /// @notice CAPSTAN_DEPLOY_ARMED is not "1".
    error NotArmed();
    /// @notice EXPECTED_CHAIN_ID is unset or differs from the connected chain.
    error ChainMismatch(uint256 expected, uint256 actual);
    /// @notice On mainnet, CAPSTAN_MAINNET_GO is not "go-<UTC date>" for today.
    error MainnetNotGo(string expected);

    /// @notice Read the environment and refuse to continue unless every condition holds.
    function check() internal view {
        checkValues(
            VM.envOr("CAPSTAN_DEPLOY_ARMED", string("")),
            VM.envOr("EXPECTED_CHAIN_ID", uint256(0)),
            VM.envOr("CAPSTAN_MAINNET_GO", string("")),
            block.chainid,
            block.timestamp
        );
    }

    /// @notice The pure rule behind check().
    function checkValues(string memory armed, uint256 expectedChainId, string memory go, uint256 chainId, uint256 ts)
        internal
        pure
    {
        if (keccak256(bytes(armed)) != keccak256("1")) revert NotArmed();
        if (expectedChainId == 0 || expectedChainId != chainId) revert ChainMismatch(expectedChainId, chainId);
        if (chainId == MAINNET) {
            string memory want = string.concat("go-", utcDate(ts));
            if (keccak256(bytes(go)) != keccak256(bytes(want))) revert MainnetNotGo(want);
        }
    }

    /// @notice YYYY-MM-DD (UTC) of a unix time (civil-from-days, proleptic Gregorian).
    function utcDate(uint256 ts) internal pure returns (string memory) {
        (uint256 y, uint256 m, uint256 d) = civil(ts / 86400);
        return string.concat(VM.toString(y), "-", _two(m), "-", _two(d));
    }

    /// @notice Year, month and day of a day count since 1970-01-01.
    function civil(uint256 days_) internal pure returns (uint256 y, uint256 m, uint256 d) {
        uint256 z = days_ + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        y = yoe + era * 400 + (m <= 2 ? 1 : 0);
    }

    function _two(uint256 v) private pure returns (string memory) {
        return v < 10 ? string.concat("0", VM.toString(v)) : VM.toString(v);
    }
}
