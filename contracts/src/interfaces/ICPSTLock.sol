// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ICPSTLock
/// @notice Locks CPST for API tiers (rate limits, builder-fee discount). No rewards logic on-chain.
/// Unlock is never gated: a lock can always be withdrawn after its chosen duration.
interface ICPSTLock {
    event Locked(address indexed account, uint256 amount, uint64 unlockAt);
    event Unlocked(address indexed account, uint256 amount);

    /// @notice Lock `amount` CPST for `duration` seconds; duration must be 0, 30 days or 90 days.
    function lock(uint256 amount, uint64 duration) external;

    /// @notice Return the caller's whole lock after unlockAt (duration 0 = anytime).
    function unlock() external;

    /// @notice The locked amount and unlock time of `account`.
    function lockedOf(address account) external view returns (uint256 amount, uint64 unlockAt);

    /// @notice The CPST token (immutable).
    function token() external view returns (address);
}
