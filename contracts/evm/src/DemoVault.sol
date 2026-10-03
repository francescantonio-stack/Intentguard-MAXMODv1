// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC4626} from "solady/tokens/ERC4626.sol";

/// @title DemoVault
/// @notice MOCK ERC-4626 vault over a single asset (Circle USDC on Monad testnet).
/// @dev TESTNET DEMO. No strategy, no yield: assets simply sit in the vault. Clearly labeled as a mock.
contract DemoVault is ERC4626 {
    address internal immutable _asset;
    uint8 internal immutable _assetDecimals;
    string internal _name;
    string internal _symbol;

    constructor(address asset_, uint8 assetDecimals_, string memory name_, string memory symbol_) {
        _asset = asset_;
        _assetDecimals = assetDecimals_;
        _name = name_;
        _symbol = symbol_;
    }

    function asset() public view override returns (address) {
        return _asset;
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function _underlyingDecimals() internal view override returns (uint8) {
        return _assetDecimals;
    }

    /// @dev Virtual-share offset mitigates the ERC-4626 inflation/donation attack (shares have 6+6 decimals).
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
