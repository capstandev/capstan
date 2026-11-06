// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Stand-in holder for the CPST supply on the local chain (31337) only, where no Safe factory exists.
/// It has no functions: tokens sent here stay here. Never deployed to a real chain (DeployAll refuses off 31337).
contract LocalVault {}
