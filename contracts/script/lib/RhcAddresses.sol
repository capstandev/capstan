// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title RhcAddresses
/// @notice Third-party addresses on Robinhood Chain the scripts use. The source of truth is
/// packages/schema/src/constants/chains.ts; test/script/AddressCopy.t.sol fails when a value here is not in that file.
library RhcAddresses {
    uint256 internal constant MAINNET = 4663;
    uint256 internal constant TESTNET = 46630;

    /// @notice Universal Router (both nets).
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    /// @notice Permit2 (both nets).
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// @notice Uniswap v4 PoolManager (both nets).
    address internal constant V4_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// @notice Uniswap v4 Quoter (both nets).
    address internal constant V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    /// @notice Uniswap v4 StateView (both nets).
    address internal constant V4_STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    /// @notice Uniswap v3 QuoterV2 (mainnet only).
    address internal constant V3_QUOTER_V2 = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7;
    /// @notice WETH (code on mainnet only; no code on 46630).
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    /// @notice USDG on mainnet.
    address internal constant USDG_MAINNET = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @notice USDG on testnet.
    address internal constant USDG_TESTNET = 0x7E955252E15c84f5768B83c41a71F9eba181802F;

    /// @notice USDG of a chain (zero when unknown).
    function usdg(uint256 chainId) internal pure returns (address) {
        if (chainId == MAINNET) return USDG_MAINNET;
        if (chainId == TESTNET) return USDG_TESTNET;
        return address(0);
    }
}
