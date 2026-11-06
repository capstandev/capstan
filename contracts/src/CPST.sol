// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title CPST
/// @notice $CPST on Robinhood Chain: a standard fixed-supply ERC-20 (OpenZeppelin v5). The whole supply of
/// 1,000,000,000 tokens (18 decimals) is minted once, in the constructor, to the brand Safe. No owner, no mint after
/// construction, no pause, no blacklist, no fee on transfer. Holders can burn their own tokens and use EIP-2612 permit.
/// Holding or locking CPST is never required to use the API, and CPST is not a claim on revenue.
contract CPST is ERC20, ERC20Permit, ERC20Burnable {
    /// @notice The fixed total supply, minted once.
    uint256 public constant SUPPLY = 1_000_000_000e18;

    /// @notice The supply recipient has no code (a Safe is a contract).
    error SafeHasNoCode();

    /// @notice Mint the whole supply to the brand Safe.
    /// @param brandSafe The brand Safe; must be a contract (the deploy script also runs the full Safe check).
    constructor(address brandSafe) ERC20("Capstan", "CPST") ERC20Permit("Capstan") {
        if (brandSafe.code.length == 0) revert SafeHasNoCode();
        _mint(brandSafe, SUPPLY);
    }
}
