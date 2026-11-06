// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BurnPlan, BurnPlanLib, BurnConfig, BurnPlanOut, PoolKey, SafeTx} from "../script/BurnPlan.s.sol";
import {RhcAddresses} from "../script/lib/RhcAddresses.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// StateView stand-in etched at the real StateView address for local tests.
contract FakeStateView {
    uint160 public sqrtPrice;
    uint128 public liq;

    function set(uint160 p, uint128 l) external {
        sqrtPrice = p;
        liq = l;
    }

    function getSlot0(bytes32) external view returns (uint160, int24, uint24, uint24) {
        return (sqrtPrice, 0, 0, 3000);
    }

    function getLiquidity(bytes32) external view returns (uint128) {
        return liq;
    }
}

/// V4Quoter stand-in returning a fixed quote.
contract FakeQuoter {
    uint256 public out;

    function set(uint256 o) external {
        out = o;
    }

    function quoteExactInputSingle(bytes calldata) external view returns (uint256, uint256) {
        return (out, 100_000);
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(out, uint256(100_000));
    }
}

contract BurnHarness {
    function minOut(uint256 q, uint256 bps) external pure returns (uint256) {
        return BurnPlanLib.minOut(q, bps);
    }

    function age(uint256 at, uint256 nowTs) external pure {
        BurnPlanLib.checkQuoteAge(at, nowTs);
    }

    function pair(uint256 chainId, address a, address b) external pure {
        BurnPlanLib.checkErc20Pair(chainId, a, b);
    }
}

contract BurnTest is Test {
    BurnHarness internal h = new BurnHarness();
    BurnPlan internal planner = new BurnPlan();
    address internal usdg;
    address internal cpst;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = address(new MockERC20("USDG", "USDG"));
        cpst = address(new MockERC20("CPST", "CPST"));
    }

    function _cfg() internal returns (BurnConfig memory c) {
        c.chainId = block.chainid; // 31337: no Safe check on the local chain
        c.safe = makeAddr("safe");
        c.usdg = usdg;
        c.cpst = cpst;
        (address c0, address c1) = usdg < cpst ? (usdg, cpst) : (cpst, usdg);
        c.poolId = keccak256(abi.encode(PoolKey(c0, c1, 3000, 60, address(0))));
        c.fee = 3000;
        c.tickSpacing = 60;
        c.amountUsdg = 500;
        c.chunkUsdg = 1000;
        c.slippageBps = 100;
        c.nowTs = block.timestamp;
    }

    function _fakes(uint160 price, uint128 liq, uint256 quote) internal {
        vm.etch(RhcAddresses.V4_STATE_VIEW, address(new FakeStateView()).code);
        FakeStateView(RhcAddresses.V4_STATE_VIEW).set(price, liq);
        vm.etch(RhcAddresses.V4_QUOTER, address(new FakeQuoter()).code);
        FakeQuoter(payable(RhcAddresses.V4_QUOTER)).set(quote);
    }

    /// R8: no pool, an uninitialised pool, or zero liquidity: the plan refuses (DECISIONS #8).
    function test_refusesWithoutPool() public {
        BurnConfig memory c = _cfg();
        vm.expectRevert(BurnPlanLib.NoPool.selector); // no StateView code at all (no pool infrastructure)
        planner.plan(c);
        _fakes(0, 0, 1e18);
        vm.expectRevert(BurnPlanLib.NoPool.selector); // pool not initialised
        planner.plan(c);
        _fakes(1 << 96, 0, 1e18);
        vm.expectRevert(BurnPlanLib.NoLiquidity.selector);
        planner.plan(c);
        _fakes(1 << 96, 1e17, 1e18);
        c.poolId = bytes32(uint256(1));
        vm.expectRevert(); // PoolIdMismatch
        planner.plan(c);
        c = _cfg();
        c.v3 = true;
        c.v3Pool = makeAddr("no code");
        vm.expectRevert(BurnPlanLib.NoPool.selector);
        planner.plan(c);
        // with a pool and liquidity it plans
        BurnPlanOut memory p = planner.plan(_cfg());
        assertEq(p.txs.length, 4);
    }

    /// R9: minOut = quote x (1 - slippage), rounded down; a quote older than 60 s is refused.
    function testFuzz_minOut(uint256 quote, uint256 bps, uint256 lag) public {
        quote = bound(quote, 0, type(uint128).max);
        bps = bound(bps, 0, 1000);
        uint256 m = h.minOut(quote, bps);
        assertEq(m, (quote * (10_000 - bps)) / 10_000);
        assertLe(m, quote);
        assertGe(m * 10_000 + 10_000, quote * (10_000 - bps), "rounded down by less than one unit");
        vm.expectRevert(abi.encodeWithSelector(BurnPlanLib.BadSlippage.selector, 1001));
        h.minOut(quote, 1001);
        lag = bound(lag, 0, 3600);
        if (lag > 60) {
            vm.expectRevert(abi.encodeWithSelector(BurnPlanLib.StaleQuote.selector, lag));
        }
        h.age(1_000_000, 1_000_000 + lag);
        // the planner applies the same rule: a chain view 61 s behind the wall clock is refused
        _fakes(1 << 96, 1e17, 5e21);
        BurnConfig memory c = _cfg();
        c.nowTs = block.timestamp + 61;
        vm.expectRevert(abi.encodeWithSelector(BurnPlanLib.StaleQuote.selector, 61));
        planner.plan(c);
        c.nowTs = block.timestamp + 60;
        BurnPlanOut memory p = planner.plan(c);
        assertEq(p.minOut, (5e21 * 9900) / 10_000);
        assertEq(p.quote, 5e21);
    }

    /// R11: testnet burns use ERC-20 pairs only (WETH has no code on 46630; native ETH is never used).
    function test_testnetNoWeth() public {
        vm.expectRevert(abi.encodeWithSelector(BurnPlanLib.NotAnErc20Pair.selector, RhcAddresses.WETH));
        h.pair(46630, RhcAddresses.WETH, RhcAddresses.USDG_TESTNET);
        vm.expectRevert(abi.encodeWithSelector(BurnPlanLib.NotAnErc20Pair.selector, address(0)));
        h.pair(46630, address(0), RhcAddresses.USDG_TESTNET);
        vm.expectRevert(abi.encodeWithSelector(BurnPlanLib.NotAnErc20Pair.selector, address(0)));
        h.pair(4663, RhcAddresses.USDG_MAINNET, address(0));
        h.pair(46630, RhcAddresses.USDG_TESTNET, makeAddr("cpst"));
        h.pair(4663, RhcAddresses.USDG_MAINNET, RhcAddresses.WETH); // WETH has code on mainnet
        assertEq(RhcAddresses.usdg(46630), RhcAddresses.USDG_TESTNET);
    }

    /// R13 (BAT-1): deadline = plan time + 30 min; amounts above the chunk split into day chunks; only today's
    /// chunk is in the batch; approvals are exact and expire at the deadline.
    function test_deadlineAndChunks() public {
        uint256[] memory parts = BurnPlanLib.chunks(2500, 1000);
        assertEq(parts.length, 3);
        assertEq(parts[0], 1000);
        assertEq(parts[1], 1000);
        assertEq(parts[2], 500);
        assertEq(BurnPlanLib.chunks(1000, 1000).length, 1);
        assertEq(BurnPlanLib.chunks(1, 1000)[0], 1);
        vm.expectRevert(BurnPlanLib.ZeroAmount.selector);
        this.chunksExt(0, 1000);

        _fakes(1 << 96, 1e17, 9e22);
        BurnConfig memory c = _cfg();
        c.amountUsdg = 2500;
        BurnPlanOut memory p = planner.plan(c);
        assertEq(p.deadline, c.nowTs + 30 minutes);
        assertEq(p.chunkCount, 3);
        assertEq(p.remainingUsdg, 1500);
        assertEq(p.amountIn, 1000e6, "only today's chunk");
        // tx 0: exact ERC-20 approval to Permit2
        assertEq(p.txs[0].to, usdg);
        assertEq(p.txs[0].data, abi.encodeWithSignature("approve(address,uint256)", RhcAddresses.PERMIT2, 1000e6));
        // tx 1: Permit2 approval to the router, exact, expiring at the deadline
        assertEq(p.txs[1].to, RhcAddresses.PERMIT2);
        assertEq(
            p.txs[1].data,
            abi.encodeWithSignature(
                "approve(address,address,uint160,uint48)", usdg, RhcAddresses.UNIVERSAL_ROUTER, 1000e6, p.deadline
            )
        );
        // tx 2: router execute carries the deadline as its last argument
        assertEq(p.txs[2].to, RhcAddresses.UNIVERSAL_ROUTER);
        (,, uint256 deadline) = abi.decode(_args(p.txs[2].data), (bytes, bytes[], uint256));
        assertEq(deadline, p.deadline);
        // tx 3: burn of the guaranteed minimum
        assertEq(p.txs[3].to, cpst);
        assertEq(p.txs[3].data, abi.encodeWithSignature("burn(uint256)", p.minOut));
        // the batch JSON names the chain, the Safe and four calls
        string memory json = BurnPlanLib.txBuilderJson(31337, c.safe, p.txs, c.nowTs * 1000, "CPST burn test");
        assertEq(vm.parseJsonUint(json, ".createdAt"), c.nowTs * 1000);
        assertEq(vm.parseJsonString(json, ".chainId"), "31337");
        assertEq(vm.parseJsonAddress(json, ".meta.createdFromSafeAddress"), c.safe);
        assertEq(vm.parseJsonAddress(json, ".transactions[3].to"), cpst);
        assertEq(vm.parseJsonBytes(json, ".transactions[2].data"), p.txs[2].data);
    }

    function chunksExt(uint256 a, uint256 c) external pure returns (uint256[] memory) {
        return BurnPlanLib.chunks(a, c);
    }

    function _args(bytes memory data) internal pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = data[i + 4];
        }
    }
}
