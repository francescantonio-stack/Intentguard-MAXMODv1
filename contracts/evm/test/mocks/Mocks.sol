// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @dev 6-decimals USDC stand-in for unit tests.
contract MockUSDC is ERC20 {
    function name() public pure override returns (string memory) { return "Mock USDC"; }
    function symbol() public pure override returns (string memory) { return "USDC"; }
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev WETH9-style wrapped MON for unit tests (same interface as WMON on Monad testnet).
contract MockWMON is ERC20 {
    function name() public pure override returns (string memory) { return "Wrapped MON"; }
    function symbol() public pure override returns (string memory) { return "WMON"; }
    function deposit() public payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "WMON: send failed");
    }
    receive() external payable { deposit(); }
}
