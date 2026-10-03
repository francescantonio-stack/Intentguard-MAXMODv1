// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DemoVault} from "../src/DemoVault.sol";
import {MockUSDC} from "./mocks/Mocks.sol";

contract DemoVaultTest is Test {
    MockUSDC usdc;
    DemoVault vault;
    address alice = makeAddr("alice");
    address attacker = makeAddr("attacker");

    function setUp() public {
        usdc = new MockUSDC();
        vault = new DemoVault(address(usdc), 6, "IntentGuard Demo Vault USDC", "igvUSDC");
    }

    function test_metadata() public view {
        assertEq(vault.asset(), address(usdc));
        assertEq(vault.decimals(), 12); // 6 asset decimals + 6 offset
        assertEq(vault.symbol(), "igvUSDC");
    }

    function testFuzz_depositRedeemRoundtrip(uint256 assets) public {
        assets = bound(assets, 1, 1e15); // up to 1B USDC
        usdc.mint(alice, assets);
        vm.startPrank(alice);
        usdc.approve(address(vault), assets);
        uint256 shares = vault.deposit(assets, alice);
        assertEq(vault.balanceOf(alice), shares);
        assertEq(vault.totalAssets(), assets);
        uint256 back = vault.redeem(shares, alice, alice);
        vm.stopPrank();
        assertEq(back, assets); // no yield, no loss
        assertEq(usdc.balanceOf(alice), assets);
    }

    /// Classic first-depositor inflation attack must not steal a meaningful part of a victim deposit.
    function test_inflationAttackMitigated() public {
        usdc.mint(attacker, 1_000e6 + 1);
        vm.startPrank(attacker);
        usdc.approve(address(vault), 1);
        vault.deposit(1, attacker);
        usdc.transfer(address(vault), 1_000e6); // donation
        vm.stopPrank();

        usdc.mint(alice, 1e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 1e6);
        uint256 shares = vault.deposit(1e6, alice);
        assertGt(shares, 0);
        uint256 back = vault.previewRedeem(shares);
        vm.stopPrank();
        assertGe(back, 0.99e6); // victim keeps >= 99%
    }
}
