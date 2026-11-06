// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Plain ERC-20 for tests and the local (31337) deploy only. Anyone can mint: never deployed to a real chain.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal virtual {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Takes a 1% fee on every transfer: the lock must refuse it (TransferShort).
contract FeeOnTransferToken is MockERC20("Fee Token", "FEE") {
    function _move(address from, address to, uint256 amount) internal override {
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }
}

/// @notice Returns false instead of reverting on a failed transfer.
contract FalseReturnToken is MockERC20("False Token", "FALSE") {
    bool public fail;

    function setFail(bool f) external {
        fail = f;
    }

    function transferFrom(address, address, uint256) external view override returns (bool) {
        return !fail;
    }
}

interface ILockLike {
    function unlock() external;
    function lock(uint256 amount, uint64 duration) external;
}

/// @notice Calls back into the lock from inside transferFrom and records what the reentrant call returned.
contract ReentrantToken is MockERC20("Reentrant Token", "RE") {
    address public target;
    bool public attempted;
    bool public reentered;
    bytes public reentryError;

    function setTarget(address t) external {
        target = t;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        if (target != address(0) && !attempted) {
            attempted = true;
            try ILockLike(target).unlock() {
                reentered = true;
            } catch (bytes memory err) {
                reentryError = err;
            }
        }
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }
}
