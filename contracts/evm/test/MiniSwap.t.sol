// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MiniSwap} from "../src/MiniSwap.sol";
import {MockUSDC, MockWMON} from "./mocks/Mocks.sol";

contract MiniSwapTest is Test {
    MockUSDC usdc;
    MockWMON wmon;
    MiniSwap pool;
    address lp = makeAddr("lp");
    address trader = makeAddr("trader");

    uint256 constant SEED_USDC = 1_000e6; // 1,000 USDC
    uint256 constant SEED_WMON = 1_000e18; // 1,000 WMON → price 1 USDC/MON

    function setUp() public {
        usdc = new MockUSDC();
        wmon = new MockWMON();
        pool = new MiniSwap(address(usdc), address(wmon));
        usdc.mint(lp, SEED_USDC);
        vm.deal(lp, SEED_WMON);
        vm.startPrank(lp);
        wmon.deposit{value: SEED_WMON}();
        usdc.approve(address(pool), type(uint256).max);
        wmon.approve(address(pool), type(uint256).max);
        pool.addLiquidity(SEED_USDC, SEED_WMON);
        vm.stopPrank();
    }

    function test_seed() public view {
        (uint256 r0, uint256 r1) = pool.getReserves();
        assertEq(r0, SEED_USDC);
        assertEq(r1, SEED_WMON);
        assertEq(pool.sharesOf(address(0)), pool.MINIMUM_LIQUIDITY());
        assertGt(pool.sharesOf(lp), 0);
    }

    function test_swapUsdcForWmon_matchesQuoteAndFee() public {
        uint256 amountIn = 1e6; // 1 USDC
        uint256 quoted = pool.getAmountOut(address(usdc), amountIn);
        // 1 USDC at ~1:1 minus 0.3% fee and tiny price impact
        assertApproxEqRel(quoted, 0.997e18, 0.002e18);
        usdc.mint(trader, amountIn);
        vm.startPrank(trader);
        usdc.approve(address(pool), amountIn);
        uint256 out = pool.swapExactIn(address(usdc), amountIn, quoted, trader);
        vm.stopPrank();
        assertEq(out, quoted);
        assertEq(wmon.balanceOf(trader), quoted);
    }

    function test_revert_slippage() public {
        uint256 amountIn = 1e6;
        uint256 quoted = pool.getAmountOut(address(usdc), amountIn);
        usdc.mint(trader, amountIn);
        vm.startPrank(trader);
        usdc.approve(address(pool), amountIn);
        vm.expectRevert(abi.encodeWithSelector(MiniSwap.InsufficientOutput.selector, quoted, quoted + 1));
        pool.swapExactIn(address(usdc), amountIn, quoted + 1, trader);
        vm.stopPrank();
    }

    function test_revert_invalidToken() public {
        vm.expectRevert(MiniSwap.InvalidToken.selector);
        pool.getAmountOut(address(0xBEEF), 1);
    }

    function test_revert_zeroAmount() public {
        vm.expectRevert(MiniSwap.ZeroAmount.selector);
        pool.swapExactIn(address(usdc), 0, 0, trader);
    }

    function test_removeLiquidity_returnsProRata() public {
        uint256 shares = pool.sharesOf(lp);
        vm.prank(lp);
        (uint256 a0, uint256 a1) = pool.removeLiquidity(shares);
        // everything except the locked minimum liquidity
        assertApproxEqRel(a0, SEED_USDC, 1e12);
        assertApproxEqRel(a1, SEED_WMON, 1e12);
        vm.prank(lp);
        vm.expectRevert(MiniSwap.InsufficientShares.selector);
        pool.removeLiquidity(1);
    }

    /// Fuzz: k = r0*r1 never decreases on swaps (fee accrues to LPs) and output equals the quote.
    function testFuzz_swap_kNonDecreasing(uint256 amountIn, bool usdcIn) public {
        address tokenIn = usdcIn ? address(usdc) : address(wmon);
        amountIn = usdcIn ? bound(amountIn, 1, 10_000e6) : bound(amountIn, 1e9, 10_000e18);
        (uint256 r0, uint256 r1) = pool.getReserves();
        uint256 kBefore = r0 * r1;
        uint256 quoted = pool.getAmountOut(tokenIn, amountIn);
        vm.assume(quoted > 0);
        if (usdcIn) {
            usdc.mint(trader, amountIn);
        } else {
            vm.deal(trader, amountIn);
            vm.prank(trader);
            wmon.deposit{value: amountIn}();
        }
        vm.startPrank(trader);
        MockUSDC(tokenIn).approve(address(pool), amountIn);
        uint256 out = pool.swapExactIn(tokenIn, amountIn, 0, trader);
        vm.stopPrank();
        assertEq(out, quoted);
        (uint256 n0, uint256 n1) = pool.getReserves();
        assertGe(n0 * n1, kBefore);
        // output can never drain the pool
        assertGt(usdcIn ? n1 : n0, 0);
    }
}
