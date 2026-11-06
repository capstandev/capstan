// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RhcAddresses} from "./lib/RhcAddresses.sol";
import {SafeCheck} from "./lib/SafeCheck.sol";
import {Guard} from "./lib/Guard.sol";
import {BurnDemo} from "../test/fork/BurnFixture.sol";

/// @notice Uniswap v4 pool key.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice One Safe call in the batch.
struct SafeTx {
    address to;
    bytes data;
    string label;
}

/// @notice The inputs of one burn plan.
struct BurnConfig {
    uint256 chainId;
    address safe;
    address usdg;
    address cpst;
    bool v3; // false: Uniswap v4 pool; true: Uniswap v3 pool (mainnet only)
    bytes32 poolId; // v4
    uint24 fee; // v4 (v3 reads it from the pool)
    int24 tickSpacing; // v4
    address hooks; // v4
    address v3Pool; // v3
    uint256 amountUsdg; // whole USDG for the whole burn
    uint256 chunkUsdg; // whole USDG per day (BAT-1)
    uint256 slippageBps;
    uint256 nowTs; // wall-clock unix seconds at plan time
}

/// @notice The plan for today's chunk.
struct BurnPlanOut {
    SafeTx[] txs;
    uint256 amountIn; // raw USDG (6 dp) of this chunk
    uint256 quote; // raw CPST out quoted for amountIn
    uint256 minOut; // quote x (1 - slippage), rounded down; also the amount burned
    uint256 deadline; // plan time + 30 minutes
    uint256 chunkCount;
    uint256 remainingUsdg; // whole USDG left for later days
    uint256 quotedAt; // timestamp of the chain block the quote was read at
}

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128);
}

struct QuoteExactSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 exactAmount;
    bytes hookData;
}

interface IV4Quoter {
    function quoteExactInputSingle(QuoteExactSingleParams memory params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
}

struct QuoteExactInputSingleParamsV3 {
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint24 fee;
    uint160 sqrtPriceLimitX96;
}

interface IQuoterV2 {
    function quoteExactInputSingle(QuoteExactInputSingleParamsV3 memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

interface IV3Pool {
    function liquidity() external view returns (uint128);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

/// @notice v4-periphery IV4Router.ExactInputSingleParams, current layout (with minHopPriceX36), as the router on
/// Robinhood Chain decodes it (proved by test/fork/BurnFork.t.sol against the deployed router).
struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36; // 0 = no per-hop price floor (amountOutMinimum still applies)
    bytes hookData;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2Approve {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IBurnable {
    function burn(uint256 amount) external;
}

/// @title BurnPlanLib
/// @notice Pure rules of the monthly CPST burn plan (DECISIONS #37, BAT-1).
library BurnPlanLib {
    uint256 internal constant MAX_QUOTE_AGE = 60;
    uint256 internal constant DEADLINE_WINDOW = 30 minutes;
    uint256 internal constant DEFAULT_SLIPPAGE_BPS = 100;
    uint256 internal constant MAX_SLIPPAGE_BPS = 1000;
    uint256 internal constant DEFAULT_CHUNK_USDG = 1000;
    uint256 internal constant USDG_UNIT = 1e6;

    // Universal Router command and v4 router action codes (Commands.sol, Actions.sol)
    bytes1 internal constant CMD_V3_SWAP_EXACT_IN = 0x00;
    bytes1 internal constant CMD_V4_SWAP = 0x10;
    uint8 internal constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant ACT_SETTLE_ALL = 0x0c;
    uint8 internal constant ACT_TAKE_ALL = 0x0f;
    /// @dev ActionConstants.MSG_SENDER: the router pays the swap output to the caller (the Safe).
    address internal constant MSG_SENDER = address(1);

    /// @notice No CPST pool exists (DECISIONS #8: no burn before a real pool).
    error NoPool();
    /// @notice The pool exists but holds no liquidity.
    error NoLiquidity();
    /// @notice The pool does not trade USDG against CPST.
    error WrongPool();
    /// @notice The v4 pool id does not match the key built from the inputs.
    error PoolIdMismatch(bytes32 given, bytes32 computed);
    /// @notice The chain view behind the quote is older than 60 seconds.
    error StaleQuote(uint256 age);
    /// @notice Slippage is above the 10% cap.
    error BadSlippage(uint256 bps);
    /// @notice Native ETH or WETH on testnet (WETH has no code on 46630): testnet burns use ERC-20 pairs only.
    error NotAnErc20Pair(address currency);
    /// @notice Amount is zero.
    error ZeroAmount();
    /// @notice The quote is zero.
    error ZeroQuote();

    /// @notice quote x (1 - bps / 10,000), rounded down.
    function minOut(uint256 quote, uint256 bps) internal pure returns (uint256) {
        if (bps > MAX_SLIPPAGE_BPS) revert BadSlippage(bps);
        return (quote * (10_000 - bps)) / 10_000;
    }

    /// @notice Refuse a quote read from a chain view older than MAX_QUOTE_AGE seconds.
    function checkQuoteAge(uint256 quotedAt, uint256 nowTs) internal pure {
        uint256 age = nowTs > quotedAt ? nowTs - quotedAt : 0;
        if (age > MAX_QUOTE_AGE) revert StaleQuote(age);
    }

    /// @notice Split a whole-USDG amount into day chunks of at most `chunk` (the last one smaller).
    function chunks(uint256 amount, uint256 chunk) internal pure returns (uint256[] memory out) {
        if (amount == 0 || chunk == 0) revert ZeroAmount();
        uint256 n = (amount + chunk - 1) / chunk;
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = i + 1 < n ? chunk : amount - chunk * (n - 1);
        }
    }

    /// @notice Both pair currencies must be ERC-20s; on testnet WETH (no code there) is refused too.
    function checkErc20Pair(uint256 chainId, address a, address b) internal pure {
        if (a == address(0)) revert NotAnErc20Pair(a);
        if (b == address(0)) revert NotAnErc20Pair(b);
        if (chainId == RhcAddresses.TESTNET) {
            if (a == RhcAddresses.WETH) revert NotAnErc20Pair(a);
            if (b == RhcAddresses.WETH) revert NotAnErc20Pair(b);
        }
    }

    /// @notice keccak256(abi.encode(key)), the v4 PoolId.
    function poolId(PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    /// @notice Universal Router input for an exact-in single-pool v4 swap paid by and paid to the caller.
    function v4Swap(PoolKey memory key, address tokenIn, uint256 amountIn, uint256 minOut_)
        internal
        pure
        returns (bytes memory commands, bytes[] memory inputs)
    {
        bool zeroForOne = tokenIn == key.currency0;
        address tokenOut = zeroForOne ? key.currency1 : key.currency0;
        bytes memory actions = abi.encodePacked(ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams(key, zeroForOne, uint128(amountIn), uint128(minOut_), 0, ""));
        params[1] = abi.encode(tokenIn, amountIn);
        params[2] = abi.encode(tokenOut, minOut_);
        commands = abi.encodePacked(CMD_V4_SWAP);
        inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
    }

    /// @notice Universal Router input for an exact-in single-pool v3 swap (payer is the caller, output to the caller).
    function v3Swap(address tokenIn, uint24 fee, address tokenOut, uint256 amountIn, uint256 minOut_)
        internal
        pure
        returns (bytes memory commands, bytes[] memory inputs)
    {
        commands = abi.encodePacked(CMD_V3_SWAP_EXACT_IN);
        inputs = new bytes[](1);
        // (recipient, amountIn, amountOutMin, path, payerIsUser, minHopPriceX36[]): the router decodes six fields
        inputs[0] =
            abi.encode(MSG_SENDER, amountIn, minOut_, abi.encodePacked(tokenIn, fee, tokenOut), true, new uint256[](0));
    }

    /// @notice The Safe batch: exact USDG approval to Permit2, Permit2 approval to the router until the deadline,
    /// the swap with the deadline, then burn of the guaranteed minimum.
    function batch(
        address usdg,
        address cpst,
        uint256 amountIn,
        uint256 minOut_,
        uint256 deadline,
        bytes memory commands,
        bytes[] memory inputs
    ) internal pure returns (SafeTx[] memory txs) {
        txs = new SafeTx[](4);
        txs[0] = SafeTx(
            usdg,
            abi.encodeCall(IERC20Approve.approve, (RhcAddresses.PERMIT2, amountIn)),
            "USDG approve Permit2 (exact)"
        );
        txs[1] = SafeTx(
            RhcAddresses.PERMIT2,
            abi.encodeCall(
                IPermit2Approve.approve, (usdg, RhcAddresses.UNIVERSAL_ROUTER, uint160(amountIn), uint48(deadline))
            ),
            "Permit2 approve Universal Router (exact, expires at the deadline)"
        );
        txs[2] = SafeTx(
            RhcAddresses.UNIVERSAL_ROUTER,
            abi.encodeCall(IUniversalRouter.execute, (commands, inputs, deadline)),
            "Universal Router swap USDG to CPST, output to the Safe, deadline plan + 30 min"
        );
        txs[3] = SafeTx(cpst, abi.encodeCall(IBurnable.burn, (minOut_)), "CPST burn (the guaranteed minimum bought)");
    }

    /// @notice Safe Transaction Builder batch JSON.
    function txBuilderJson(uint256 chainId, address safe, SafeTx[] memory txs, uint256 createdAtMs, string memory name)
        internal
        pure
        returns (string memory json)
    {
        string memory list;
        for (uint256 i; i < txs.length; ++i) {
            list = string.concat(
                list,
                i == 0 ? "" : ",\n",
                '    { "to": "',
                _hexAddr(txs[i].to),
                '", "value": "0", "data": "',
                _hex(txs[i].data),
                '", "contractMethod": null, "contractInputsValues": null }'
            );
        }
        json = string.concat(
            '{\n  "version": "1.0",\n  "chainId": "',
            _dec(chainId),
            '",\n  "createdAt": ',
            _dec(createdAtMs),
            ',\n  "meta": { "name": "',
            name,
            '", "description": "Monthly CPST burn: buy with USDG on Uniswap, burn the guaranteed minimum. Re-run the plan once the deadline has passed.", "txBuilderVersion": "1.18.0", "createdFromSafeAddress": "',
            _hexAddr(safe),
            '", "createdFromOwnerAddress": "" },\n  "transactions": [\n',
            list,
            "\n  ]\n}\n"
        );
    }

    function _dec(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory b;
        while (v > 0) {
            b = abi.encodePacked(bytes1(uint8(48 + (v % 10))), b);
            v /= 10;
        }
        return string(b);
    }

    function _hex(bytes memory data) private pure returns (string memory) {
        bytes16 symbols = "0123456789abcdef";
        bytes memory out = new bytes(2 + data.length * 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i; i < data.length; ++i) {
            out[2 + i * 2] = symbols[uint8(data[i]) >> 4];
            out[3 + i * 2] = symbols[uint8(data[i]) & 0x0f];
        }
        return string(out);
    }

    function _hexAddr(address a) private pure returns (string memory) {
        return _hex(abi.encodePacked(a));
    }
}

/// @title BurnPlan
/// @notice Read-only planner for the monthly CPST burn. It never sends anything and holds no key: it checks the pool,
/// quotes, and writes a Safe Transaction Builder batch to out/burn/<UTC date>.json for the brand Safe's signers.
/// Inputs (env): EXPECTED_CHAIN_ID, BRAND_SAFE, CPST_ADDRESS, POOL_KIND (v4 or v3), CPST_POOL (v4 pool id or v3 pool
/// address), CPST_POOL_FEE, CPST_POOL_TICK_SPACING, CPST_POOL_HOOKS (v4), AMOUNT_USDG (whole USDG),
/// BURN_CHUNK_USDG (default 1,000), MAX_SLIPPAGE_BPS (default 100), BURN_OUT_DIR, BURN_FORCE.
contract BurnPlan is Script {
    /// @notice The chain id differs from EXPECTED_CHAIN_ID.
    error ChainMismatch(uint256 expected, uint256 actual);
    /// @notice A batch file for today already exists (pass BURN_FORCE=1 to overwrite).
    error BatchExists(string path);

    /// @notice Plan today's chunk and write the batch file.
    function run() external returns (BurnPlanOut memory p) {
        uint256 expected = vm.envUint("EXPECTED_CHAIN_ID");
        if (block.chainid != expected) revert ChainMismatch(expected, block.chainid);
        BurnConfig memory c = _config();
        if (vm.envOr("BURN_DEMO_POOL", false)) c = _demo(c);
        p = plan(c);
        string memory date = _date(c.nowTs);
        string memory dir = vm.envOr("BURN_OUT_DIR", string("../out/burn"));
        string memory path = string.concat(dir, "/", date, ".json");
        if (vm.exists(path) && !vm.envOr("BURN_FORCE", false)) revert BatchExists(path);
        vm.createDir(dir, true);
        vm.writeFile(
            path, BurnPlanLib.txBuilderJson(c.chainId, c.safe, p.txs, c.nowTs * 1000, string.concat("CPST burn ", date))
        );
        console.log("quote (raw CPST):", p.quote);
        console.log("min out and burn (raw CPST):", p.minOut);
        console.log("amount in (raw USDG):", p.amountIn);
        console.log("deadline (unix):", p.deadline);
        console.log("chunks:", p.chunkCount, "remaining whole USDG for later days:", p.remainingUsdg);
        console.log("batch file:", path);
    }

    /// @notice Check the Safe and the pool, quote today's chunk, and build the batch. Read-only on chain.
    function plan(BurnConfig memory c) public returns (BurnPlanOut memory p) {
        if (c.slippageBps > BurnPlanLib.MAX_SLIPPAGE_BPS) revert BurnPlanLib.BadSlippage(c.slippageBps);
        BurnPlanLib.checkErc20Pair(c.chainId, c.usdg, c.cpst);
        if (c.chainId == RhcAddresses.MAINNET || c.chainId == RhcAddresses.TESTNET) SafeCheck.check(c.safe);
        uint256[] memory parts = BurnPlanLib.chunks(c.amountUsdg, c.chunkUsdg);
        p.chunkCount = parts.length;
        p.remainingUsdg = c.amountUsdg - parts[0];
        p.amountIn = parts[0] * BurnPlanLib.USDG_UNIT;
        bytes memory commands;
        bytes[] memory inputs;
        if (c.v3) {
            uint24 fee = _checkV3Pool(c);
            p.quote = _quoteV3(c.usdg, c.cpst, fee, p.amountIn);
            p.minOut = BurnPlanLib.minOut(p.quote, c.slippageBps);
            (commands, inputs) = BurnPlanLib.v3Swap(c.usdg, fee, c.cpst, p.amountIn, p.minOut);
        } else {
            PoolKey memory key = _checkV4Pool(c);
            p.quote = _quoteV4(key, c.usdg, p.amountIn);
            p.minOut = BurnPlanLib.minOut(p.quote, c.slippageBps);
            (commands, inputs) = BurnPlanLib.v4Swap(key, c.usdg, p.amountIn, p.minOut);
        }
        if (p.quote == 0 || p.minOut == 0) revert BurnPlanLib.ZeroQuote();
        p.quotedAt = block.timestamp;
        BurnPlanLib.checkQuoteAge(p.quotedAt, c.nowTs);
        p.deadline = c.nowTs + BurnPlanLib.DEADLINE_WINDOW;
        p.txs = BurnPlanLib.batch(c.usdg, c.cpst, p.amountIn, p.minOut, p.deadline, commands, inputs);
    }

    function _checkV4Pool(BurnConfig memory c) internal view returns (PoolKey memory key) {
        (address c0, address c1) = c.usdg < c.cpst ? (c.usdg, c.cpst) : (c.cpst, c.usdg);
        key = PoolKey(c0, c1, c.fee, c.tickSpacing, c.hooks);
        bytes32 id = BurnPlanLib.poolId(key);
        if (c.poolId != id) revert BurnPlanLib.PoolIdMismatch(c.poolId, id);
        if (RhcAddresses.V4_STATE_VIEW.code.length == 0) revert BurnPlanLib.NoPool();
        (uint160 sqrtPriceX96,,,) = IStateView(RhcAddresses.V4_STATE_VIEW).getSlot0(id);
        if (sqrtPriceX96 == 0) revert BurnPlanLib.NoPool();
        if (IStateView(RhcAddresses.V4_STATE_VIEW).getLiquidity(id) == 0) revert BurnPlanLib.NoLiquidity();
    }

    function _checkV3Pool(BurnConfig memory c) internal view returns (uint24 fee) {
        if (c.v3Pool.code.length == 0) revert BurnPlanLib.NoPool();
        IV3Pool pool = IV3Pool(c.v3Pool);
        (address t0, address t1) = (pool.token0(), pool.token1());
        if (!((t0 == c.usdg && t1 == c.cpst) || (t0 == c.cpst && t1 == c.usdg))) revert BurnPlanLib.WrongPool();
        if (pool.liquidity() == 0) revert BurnPlanLib.NoLiquidity();
        fee = pool.fee();
    }

    function _quoteV4(PoolKey memory key, address tokenIn, uint256 amountIn) internal returns (uint256 out) {
        (out,) = IV4Quoter(RhcAddresses.V4_QUOTER)
            .quoteExactInputSingle(QuoteExactSingleParams(key, tokenIn == key.currency0, uint128(amountIn), ""));
    }

    function _quoteV3(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) internal returns (uint256 out) {
        (out,,,) = IQuoterV2(RhcAddresses.V3_QUOTER_V2)
            .quoteExactInputSingle(QuoteExactInputSingleParamsV3(tokenIn, tokenOut, amountIn, fee, 0));
    }

    function _config() internal view returns (BurnConfig memory c) {
        c.chainId = block.chainid;
        c.safe = vm.envOr("BRAND_SAFE", address(0));
        c.usdg = vm.envOr("USDG_ADDRESS", RhcAddresses.usdg(block.chainid));
        c.cpst = vm.envOr("CPST_ADDRESS", address(0));
        c.v3 = keccak256(bytes(vm.envOr("POOL_KIND", string("v4")))) == keccak256("v3");
        if (c.v3) c.v3Pool = vm.envOr("CPST_POOL", address(0));
        else c.poolId = vm.envOr("CPST_POOL", bytes32(0));
        c.fee = uint24(vm.envOr("CPST_POOL_FEE", uint256(3000)));
        c.tickSpacing = int24(vm.envOr("CPST_POOL_TICK_SPACING", int256(60)));
        c.hooks = vm.envOr("CPST_POOL_HOOKS", address(0));
        c.amountUsdg = vm.envOr("AMOUNT_USDG", uint256(0));
        c.chunkUsdg = vm.envOr("BURN_CHUNK_USDG", BurnPlanLib.DEFAULT_CHUNK_USDG);
        c.slippageBps = vm.envOr("MAX_SLIPPAGE_BPS", BurnPlanLib.DEFAULT_SLIPPAGE_BPS);
        c.nowTs = vm.unixTime() / 1000;
    }

    /// @dev Demo mode for a local fork only (ops/deploy/burn-plan.sh fork-local): builds a throwaway Safe, CPST and a
    /// CPST/USDG pool inside this script's own simulation, so the planner can be exercised before a real pool exists.
    /// Nothing is sent: this script has no broadcast step at all.
    function _demo(BurnConfig memory c) internal returns (BurnConfig memory) {
        (address safe, address cpst, bytes32 id) = new BurnDemo().build(c.usdg);
        c.safe = safe;
        c.cpst = cpst;
        c.poolId = id;
        c.v3 = false;
        if (c.amountUsdg == 0) c.amountUsdg = 2500;
        console.log("demo: throwaway Safe, CPST and pool built in simulation only");
        return c;
    }

    function _date(uint256 ts) internal pure returns (string memory) {
        return Guard.utcDate(ts);
    }
}
