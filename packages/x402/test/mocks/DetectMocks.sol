// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Mocks for EIP-3009 detection tests. MockGood3009 behaves like USDG today (typehash, authorizationState,
/// DOMAIN_SEPARATOR with version "1"; version() and eip712Domain() revert FacetNotFound). The others each break
/// one detection condition.
abstract contract DomainBase {
    error FacetNotFound();

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function _domain(string memory version) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Global Dollar")),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }

    fallback() external {
        revert FacetNotFound();
    }
}

contract MockGood3009 is DomainBase {
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domain("1");
    }
}

/// A token with a domain separator but no EIP-3009 functions at all (plain ERC-20 with permit).
contract MockNo3009 {
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this)));
    }
}

/// The EIP-3009 facet was swapped out: authorizationState reverts FacetNotFound (through the fallback).
contract MockFacetRemoved is DomainBase {
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domain("1");
    }
}

/// Everything present, but the domain uses version "2".
contract MockDomainV2 is DomainBase {
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domain("2");
    }
}
