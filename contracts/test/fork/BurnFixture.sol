// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CPST} from "../../src/CPST.sol";
import {RhcAddresses} from "../../script/lib/RhcAddresses.sol";
import {SafeCheck} from "../../script/lib/SafeCheck.sol";
import {PoolKey} from "../../script/BurnPlan.s.sol";

/// Test and demo fixtures for the burn plan on a Robinhood Chain fork: a Safe 1.4.1 made with the canonical factory,
/// the CPST token, and a CPST/USDG v4 pool with full-range test liquidity. Only ever runs inside a local fork or a
/// script simulation; nothing here is sent to a real chain.

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManagerMin {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
}

interface IERC20Lite {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

interface ISafeFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafeSetup {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
}

/// Adds full-range liquidity to a v4 pool through the PoolManager's unlock callback, paying from its own balance.
contract LiquidityAdder {
    IPoolManagerMin internal constant PM = IPoolManagerMin(RhcAddresses.V4_POOL_MANAGER);

    function add(PoolKey memory key, int256 liquidity) external {
        PM.unlock(abi.encode(key, liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(PM), "only the pool manager");
        (PoolKey memory key, int256 liquidity) = abi.decode(data, (PoolKey, int256));
        int24 spacing = key.tickSpacing;
        int24 maxTick = (int24(887272) / spacing) * spacing;
        (int256 delta,) = PM.modifyLiquidity(key, ModifyLiquidityParams(-maxTick, maxTick, liquidity, bytes32(0)), "");
        _pay(key.currency0, int128(delta >> 128));
        _pay(key.currency1, int128(delta));
        return "";
    }

    function _pay(address currency, int128 amount) internal {
        if (amount >= 0) return;
        PM.sync(currency);
        IERC20Lite(currency).transfer(address(PM), uint256(uint128(-amount)));
        PM.settle();
    }
}

library BurnFixture {
    /// @dev Full-range liquidity that holds about 10,000 USDG and 1,000,000 CPST at 1 CPST = 0.01 USDG.
    int256 internal constant LIQUIDITY = 1e17;
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    /// @notice A Safe 1.4.1 (SafeL2 singleton) with these owners and threshold, made with the canonical factory.
    function makeSafe(address[] memory owners, uint256 threshold, uint256 salt) internal returns (address) {
        bytes memory init = abi.encodeCall(
            ISafeSetup.setup,
            (owners, threshold, address(0), "", SafeCheck.FALLBACK_141, address(0), 0, payable(address(0)))
        );
        return ISafeFactory(SafeCheck.FACTORY_141).createProxyWithNonce(SafeCheck.SAFE_L2_141, init, salt);
    }

    /// @notice The CPST/USDG pool key (currencies sorted).
    function key(address cpst, address usdg) internal pure returns (PoolKey memory k) {
        (address c0, address c1) = cpst < usdg ? (cpst, usdg) : (usdg, cpst);
        k = PoolKey(c0, c1, FEE, TICK_SPACING, address(0));
    }

    /// @notice sqrtPriceX96 for 1 CPST (18 dp) = 0.01 USDG (6 dp), for either currency order.
    function sqrtPrice(address cpst, address usdg) internal pure returns (uint160) {
        // raw price token1/token0: USDG first -> 1e20 / 1e6 = 1e14 (sqrt 1e7); CPST first -> 1e-14 (sqrt 1e-7)
        return usdg < cpst ? uint160(uint256(1e7) << 96) : uint160((uint256(1) << 96) / 1e7);
    }
}

interface IVmDemo {
    function prank(address) external;
}

/// Builds a throwaway Safe 2-of-3, CPST and a CPST/USDG v4 pool on a fork (or inside a script simulation).
contract BurnDemo {
    IVmDemo internal constant VM = IVmDemo(address(uint160(uint256(keccak256("hevm cheat code")))));
    /// @dev A large USDG holder on 4663 (the WETH/USDG 0.01% v3 pool), used only as a funding source on a fork.
    address internal constant USDG_SOURCE = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;

    function build(address usdg) external returns (address safe, address cpst, bytes32 id) {
        address[] memory owners = new address[](3);
        for (uint256 i; i < 3; ++i) {
            owners[i] = address(uint160(uint256(keccak256(abi.encode("capstan-demo-owner", i)))));
        }
        safe = BurnFixture.makeSafe(owners, 2, uint256(keccak256("capstan-demo-safe")));
        cpst = address(new CPST(safe));
        PoolKey memory k = BurnFixture.key(cpst, usdg);
        IPoolManagerMin(RhcAddresses.V4_POOL_MANAGER).initialize(k, BurnFixture.sqrtPrice(cpst, usdg));
        LiquidityAdder adder = new LiquidityAdder();
        VM.prank(safe);
        IERC20Lite(cpst).transfer(address(adder), 2_000_000e18);
        VM.prank(USDG_SOURCE);
        IERC20Lite(usdg).transfer(address(adder), 20_000e6);
        VM.prank(USDG_SOURCE);
        IERC20Lite(usdg).transfer(safe, 5_000e6);
        adder.add(k, BurnFixture.LIQUIDITY);
        id = keccak256(abi.encode(k));
    }
}
