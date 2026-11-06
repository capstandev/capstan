// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The Safe 1.4.1 calls the check reads.
interface ISafeView {
    /// @notice Signature threshold.
    function getThreshold() external view returns (uint256);
    /// @notice Owners.
    function getOwners() external view returns (address[] memory);
    /// @notice Enabled modules, paginated from the sentinel.
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
    /// @notice Raw storage read (StorageAccessible).
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
}

/// @title SafeCheck
/// @notice A real Safe check (DEP-8), stronger than "has code" (an EIP-7702 delegated EOA has code too): the proxy
/// runtime code hash equals the official Safe 1.4.1 proxy, its singleton is the official Safe 1.4.1 or SafeL2 1.4.1,
/// the threshold is at least 2, no module is enabled and no guard is set. Addresses are the canonical deployments,
/// present with code on 4663 and 46630 (chain-facts section 2, re-read 2026-11-06).
library SafeCheck {
    /// @notice Safe 1.4.1 singleton.
    address internal constant SAFE_141 = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    /// @notice SafeL2 1.4.1 singleton.
    address internal constant SAFE_L2_141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    /// @notice SafeProxyFactory 1.4.1.
    address internal constant FACTORY_141 = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    /// @notice CompatibilityFallbackHandler 1.4.1.
    address internal constant FALLBACK_141 = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    /// @notice keccak256 of the SafeProxy 1.4.1 runtime code (171 bytes), measured from the canonical factory on a 4663 fork.
    bytes32 internal constant PROXY_141_CODEHASH = 0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c; // not-a-key
    /// @notice keccak256("guard_manager.guard.address"), the Safe guard storage slot.
    uint256 internal constant GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8; // not-a-key
    address internal constant SENTINEL = address(0x1);

    /// @notice The address is not a real Safe 1.4.1 multisig; the reason says which check failed.
    error NotARealSafe(address safe, string reason);

    /// @notice Revert NotARealSafe unless `safe` passes every check.
    function check(address safe) internal view {
        string memory why = reason(safe);
        if (bytes(why).length != 0) revert NotARealSafe(safe, why);
    }

    /// @notice Empty when `safe` is a real Safe; otherwise the first failed check.
    function reason(address safe) internal view returns (string memory) {
        bytes memory code = safe.code;
        if (code.length == 0) return "no code";
        if (code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00) {
            return "EIP-7702 delegated EOA";
        }
        if (safe.codehash != PROXY_141_CODEHASH) return "runtime code is not the Safe 1.4.1 proxy";
        (bool ok, bytes memory ret) = safe.staticcall(abi.encodeWithSignature("masterCopy()"));
        if (!ok || ret.length != 32) return "no masterCopy";
        address singleton = abi.decode(ret, (address));
        if (singleton != SAFE_141 && singleton != SAFE_L2_141) return "singleton is not Safe 1.4.1 or SafeL2 1.4.1";
        if (ISafeView(safe).getThreshold() < 2) return "threshold below 2";
        (address[] memory mods,) = ISafeView(safe).getModulesPaginated(SENTINEL, 10);
        if (mods.length != 0) return "a module is enabled";
        bytes memory g = ISafeView(safe).getStorageAt(GUARD_SLOT, 1);
        if (abi.decode(g, (uint256)) != 0) return "a guard is set";
        return "";
    }
}
