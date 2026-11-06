// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {CPST} from "../../src/CPST.sol";
import {BurnPlan, BurnPlanLib, BurnConfig, BurnPlanOut, PoolKey, SafeTx} from "../../script/BurnPlan.s.sol";
import {RhcAddresses} from "../../script/lib/RhcAddresses.sol";
import {SafeCheck} from "../../script/lib/SafeCheck.sol";
import {BurnFixture, LiquidityAdder, IPoolManagerMin, IERC20Lite} from "./BurnFixture.sol";

interface ISafeExec {
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
    function nonce() external view returns (uint256);
}

interface IERC20View {
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address a) external view returns (uint256);
}

interface IPermit2View {
    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

/// Fork helpers: Safe owners as fresh labelled keys (never anvil defaults), and 2-of-3 Safe execution.
abstract contract SafeForkBase is Test {
    address internal constant USDG_SOURCE = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    Vm.Wallet[3] internal owners;
    address internal safe;

    function _fork() internal returns (bool) {
        string memory rpc = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663);
        return true;
    }

    function _makeSafe() internal {
        address[] memory addrs = new address[](3);
        for (uint256 i; i < 3; ++i) {
            owners[i] = vm.createWallet(string.concat("capstan-burn-owner-", vm.toString(i)));
        }
        // owners sorted ascending (Safe signatures must be in ascending signer order)
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (owners[j].addr < owners[i].addr) (owners[i], owners[j]) = (owners[j], owners[i]);
            }
        }
        for (uint256 i; i < 3; ++i) {
            addrs[i] = owners[i].addr;
        }
        safe = BurnFixture.makeSafe(addrs, 2, uint256(keccak256("capstan-burn-fork-safe")));
    }

    function _exec(address to, bytes memory data) internal returns (bool) {
        ISafeExec s = ISafeExec(safe);
        bytes32 h = s.getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), s.nonce());
        bytes memory sigs;
        for (uint256 i; i < 2; ++i) {
            (uint8 v, bytes32 r, bytes32 ss) = vm.sign(owners[i].privateKey, h);
            sigs = abi.encodePacked(sigs, r, ss, v);
        }
        return s.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
    }
}

/// R10: the whole burn on a 4663 fork, from a real Safe 1.4.1 made with the canonical factory. Skips without RHC_RPC_URL.
contract BurnForkTest is SafeForkBase {
    CPST internal cpst;
    PoolKey internal key;
    address internal usdg = RhcAddresses.USDG_MAINNET;

    function _setUpPool() internal {
        _makeSafe();
        cpst = new CPST(safe);
        key = BurnFixture.key(address(cpst), usdg);
        IPoolManagerMin(RhcAddresses.V4_POOL_MANAGER).initialize(key, BurnFixture.sqrtPrice(address(cpst), usdg));
        // test liquidity from a fresh LP key: CPST from the Safe (2-of-3), USDG from a holder on the fork
        Vm.Wallet memory lp = vm.createWallet("capstan-burn-lp");
        LiquidityAdder adder = new LiquidityAdder();
        assertTrue(_exec(address(cpst), abi.encodeCall(cpst.transfer, (lp.addr, 2_000_000e18))));
        vm.prank(lp.addr);
        cpst.transfer(address(adder), 2_000_000e18);
        vm.prank(USDG_SOURCE);
        IERC20Lite(usdg).transfer(address(adder), 20_000e6);
        adder.add(key, BurnFixture.LIQUIDITY);
        vm.prank(USDG_SOURCE);
        IERC20Lite(usdg).transfer(safe, 5_000e6);
    }

    function _config(uint256 amountUsdg) internal view returns (BurnConfig memory c) {
        c.chainId = block.chainid;
        c.safe = safe;
        c.usdg = usdg;
        c.cpst = address(cpst);
        c.poolId = keccak256(abi.encode(key));
        c.fee = key.fee;
        c.tickSpacing = key.tickSpacing;
        c.amountUsdg = amountUsdg;
        c.chunkUsdg = 1000;
        c.slippageBps = 100;
        c.nowTs = block.timestamp;
    }

    function test_burnFromSafe() public {
        if (!_fork()) {
            vm.skip(true);
            return;
        }
        _setUpPool();
        assertEq(SafeCheck.reason(safe), "", "the fork Safe is a real Safe");
        BurnPlanOut memory p = new BurnPlan().plan(_config(100));
        assertEq(p.txs.length, 4);
        assertEq(p.amountIn, 100e6);
        assertEq(p.minOut, (p.quote * 9900) / 10_000);
        console.log("quote, minOut (raw CPST):", p.quote, p.minOut);

        uint256 supplyBefore = cpst.totalSupply();
        uint256 usdgBefore = IERC20View(usdg).balanceOf(safe);
        uint256 cpstBefore = cpst.balanceOf(safe);
        for (uint256 i; i < 4; ++i) {
            assertTrue(_exec(p.txs[i].to, p.txs[i].data), p.txs[i].label);
        }
        assertEq(supplyBefore - cpst.totalSupply(), p.minOut, "supply fell by the burned amount");
        assertEq(usdgBefore - IERC20View(usdg).balanceOf(safe), 100e6, "exactly the chunk was spent");
        uint256 bought = cpst.balanceOf(safe) + p.minOut - cpstBefore;
        assertEq(bought, p.quote, "bought exactly the quote (no other trade on the fork)");
        assertGe(bought, p.minOut, "bought at least the burned amount");
        assertEq(IERC20View(usdg).allowance(safe, RhcAddresses.PERMIT2), 0, "ERC-20 approval back to zero");
        (uint160 left,,) = IPermit2View(RhcAddresses.PERMIT2).allowance(safe, usdg, RhcAddresses.UNIVERSAL_ROUTER);
        assertEq(left, 0, "Permit2 approval back to zero");
    }

    /// BAT-1 on chain: the same batch executed after its deadline reverts instead of filling at a stale quote.
    function test_lateBatchReverts() public {
        if (!_fork()) {
            vm.skip(true);
            return;
        }
        _setUpPool();
        BurnPlanOut memory p = new BurnPlan().plan(_config(100));
        assertTrue(_exec(p.txs[0].to, p.txs[0].data));
        assertTrue(_exec(p.txs[1].to, p.txs[1].data));
        uint256 snap = vm.snapshotState();
        vm.warp(p.deadline + 1);
        vm.expectRevert(bytes("GS013")); // the router call failed: TransactionDeadlinePassed
        this.execExternal(p.txs[2].to, p.txs[2].data);
        vm.revertToState(snap);
        vm.warp(p.deadline);
        assertTrue(_exec(p.txs[2].to, p.txs[2].data), "the same call fills at the deadline");
    }

    function execExternal(address to, bytes memory data) external returns (bool) {
        return _exec(to, data);
    }

    /// The v3 encoding (mainnet only) against the real router and a real USDG pool: USDG -> WETH from the Safe.
    function test_v3SwapEncodingOnRealPool() public {
        if (!_fork()) {
            vm.skip(true);
            return;
        }
        _makeSafe();
        vm.prank(USDG_SOURCE);
        IERC20Lite(usdg).transfer(safe, 1_000e6);
        uint24 fee = 500;
        (uint256 quote,,,) = IQuoterV2Like(RhcAddresses.V3_QUOTER_V2)
            .quoteExactInputSingle(QuoteV3(usdg, RhcAddresses.WETH, 100e6, fee, 0));
        uint256 minOut = BurnPlanLib.minOut(quote, 100);
        (bytes memory commands, bytes[] memory inputs) = BurnPlanLib.v3Swap(usdg, fee, RhcAddresses.WETH, 100e6, minOut);
        SafeTx[] memory txs =
            BurnPlanLib.batch(usdg, RhcAddresses.WETH, 100e6, minOut, block.timestamp + 1800, commands, inputs);
        uint256 wethBefore = IERC20View(RhcAddresses.WETH).balanceOf(safe);
        for (uint256 i; i < 3; ++i) {
            assertTrue(_exec(txs[i].to, txs[i].data), txs[i].label);
        }
        assertEq(IERC20View(RhcAddresses.WETH).balanceOf(safe) - wethBefore, quote, "received the quote");
        assertEq(IERC20View(usdg).allowance(safe, RhcAddresses.PERMIT2), 0);
    }
}

struct QuoteV3 {
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint24 fee;
    uint160 sqrtPriceLimitX96;
}

interface IQuoterV2Like {
    function quoteExactInputSingle(QuoteV3 memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}
