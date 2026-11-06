// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICPSTLock} from "./interfaces/ICPSTLock.sol";

/// @notice The three ERC-20 calls the lock makes.
interface IERC20Min {
    /// @notice Token balance of an account.
    function balanceOf(address account) external view returns (uint256);
    /// @notice Move tokens from the caller.
    function transfer(address to, uint256 amount) external returns (bool);
    /// @notice Move tokens with an allowance.
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title CPSTLock
/// @notice Locks CPST for API perks. No owner, no admin, no pause, no upgrade, no rescue function.
/// Accounting is per account and never reads the contract's balance for a user amount, so a plain transfer
/// (donation) to this contract changes nobody's lock; donated tokens stay here by design. A lock can always be
/// withdrawn in full by its owner once its unlock time has passed, whether or not any website exists.
contract CPSTLock is ICPSTLock {
    struct Lock {
        uint256 amount;
        uint64 unlockAt;
    }

    /// @notice Lock duration choice: 30 days.
    uint64 public constant DURATION_30D = 30 days;
    /// @notice Lock duration choice: 90 days.
    uint64 public constant DURATION_90D = 90 days;

    /// @notice The CPST token (immutable, must be a contract).
    address public immutable token;

    /// @notice Sum of every account's locked amount.
    uint256 public totalLocked;

    mapping(address account => Lock) private _locks;
    uint256 private _entered;

    /// @notice Duration is not 0, 30 days or 90 days.
    error BadDuration(uint64 duration);
    /// @notice Amount is zero.
    error ZeroAmount();
    /// @notice The lock has not reached its unlock time.
    error StillLocked(uint64 unlockAt);
    /// @notice The caller has nothing locked.
    error NothingLocked();
    /// @notice The lock received less than the amount (fee-on-transfer or a short transfer).
    error TransferShort();
    /// @notice A token call failed.
    error TransferFailed();
    /// @notice The token address has no code.
    error TokenNotContract();
    /// @notice Reentrant call.
    error Reentrant();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrant();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @notice Deploy the lock for one token.
    /// @param token_ The CPST token; must have code.
    constructor(address token_) {
        if (token_.code.length == 0) revert TokenNotContract();
        token = token_;
    }

    /// @notice Lock `amount` more tokens from the caller. The unlock time becomes max(existing, now + duration),
    /// so adding to a lock never shortens it.
    /// @param amount Tokens to pull from the caller (allowance required); nonzero.
    /// @param duration 0, 30 days or 90 days, in seconds.
    function lock(uint256 amount, uint64 duration) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (duration != 0 && duration != DURATION_30D && duration != DURATION_90D) revert BadDuration(duration);
        Lock storage l = _locks[msg.sender];
        // casting to 'uint64' is safe because unix seconds fit in 64 bits for billions of years
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 target = uint64(block.timestamp) + duration;
        uint64 unlockAt = l.unlockAt > target ? l.unlockAt : target;
        IERC20Min t = IERC20Min(token);
        uint256 before = t.balanceOf(address(this));
        _call(abi.encodeCall(IERC20Min.transferFrom, (msg.sender, address(this), amount)));
        if (t.balanceOf(address(this)) - before != amount) revert TransferShort();
        l.amount += amount;
        l.unlockAt = unlockAt;
        totalLocked += amount;
        emit Locked(msg.sender, amount, unlockAt);
    }

    /// @notice Withdraw the caller's whole lock once block.timestamp >= unlockAt. Always to the caller.
    function unlock() external nonReentrant {
        Lock memory l = _locks[msg.sender];
        if (l.amount == 0) revert NothingLocked();
        if (block.timestamp < l.unlockAt) revert StillLocked(l.unlockAt);
        delete _locks[msg.sender];
        totalLocked -= l.amount;
        emit Unlocked(msg.sender, l.amount);
        _call(abi.encodeCall(IERC20Min.transfer, (msg.sender, l.amount)));
    }

    /// @notice The locked amount and unlock time of an account.
    /// @param account The account.
    /// @return amount Tokens locked.
    /// @return unlockAt Unix time from which unlock succeeds.
    function lockedOf(address account) external view returns (uint256 amount, uint64 unlockAt) {
        Lock storage l = _locks[account];
        return (l.amount, l.unlockAt);
    }

    /// @dev Call the token and require success plus an empty or true return value.
    function _call(bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) revert TransferFailed();
    }
}
