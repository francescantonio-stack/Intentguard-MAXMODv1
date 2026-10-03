// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

/// @title MiniSwap
/// @notice Minimal constant-product (x*y=k) pool for two ERC-20 tokens (USDC / WMON on Monad testnet).
/// @dev TESTNET DEMO. Liquidity is seeded by the IntentGuard team. Not audited. 0.30% fee stays in the pool.
///      LP shares are tracked internally (no LP token) to keep the code small.
contract MiniSwap is ReentrancyGuard {
    using SafeTransferLib for address;

    uint256 public constant FEE_BPS = 30; // 0.30%
    uint256 private constant BPS = 10_000;
    uint256 public constant MINIMUM_LIQUIDITY = 1_000;

    address public immutable token0;
    address public immutable token1;

    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1, uint256 shares);
    event LiquidityRemoved(address indexed provider, uint256 amount0, uint256 amount1, uint256 shares);
    event Swap(address indexed sender, address indexed tokenIn, uint256 amountIn, uint256 amountOut, address indexed to);

    error InvalidToken();
    error ZeroAmount();
    error InsufficientLiquidity();
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);
    error InsufficientShares();

    constructor(address _token0, address _token1) {
        if (_token0 == _token1 || _token0 == address(0) || _token1 == address(0)) revert InvalidToken();
        token0 = _token0;
        token1 = _token1;
    }

    // ----------------------------------------------------------------- views

    /// @notice Output amount for an exact input, including the fee.
    function getAmountOut(address tokenIn, uint256 amountIn) public view returns (uint256) {
        (uint256 rIn, uint256 rOut) = _reservesFor(tokenIn);
        return _getAmountOut(amountIn, rIn, rOut);
    }

    function getReserves() external view returns (uint256, uint256) {
        return (reserve0, reserve1);
    }

    // ------------------------------------------------------------- liquidity

    /// @notice Adds liquidity. The first deposit sets the price; later deposits should match the ratio
    ///         (the excess of the larger side is donated to the pool).
    function addLiquidity(uint256 amount0, uint256 amount1) external nonReentrant returns (uint256 shares) {
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();
        token0.safeTransferFrom(msg.sender, address(this), amount0);
        token1.safeTransferFrom(msg.sender, address(this), amount1);

        if (totalShares == 0) {
            shares = FixedPointMathLib.sqrt(amount0 * amount1);
            if (shares <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            // Lock MINIMUM_LIQUIDITY forever (owned by address(0)) to avoid share-price manipulation.
            sharesOf[address(0)] = MINIMUM_LIQUIDITY;
            totalShares = MINIMUM_LIQUIDITY;
            shares -= MINIMUM_LIQUIDITY;
        } else {
            shares = FixedPointMathLib.min(amount0 * totalShares / reserve0, amount1 * totalShares / reserve1);
            if (shares == 0) revert InsufficientLiquidity();
        }
        sharesOf[msg.sender] += shares;
        totalShares += shares;
        _sync();
        emit LiquidityAdded(msg.sender, amount0, amount1, shares);
    }

    function removeLiquidity(uint256 shares) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (shares == 0) revert ZeroAmount();
        if (sharesOf[msg.sender] < shares) revert InsufficientShares();
        amount0 = shares * reserve0 / totalShares;
        amount1 = shares * reserve1 / totalShares;
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        token0.safeTransfer(msg.sender, amount0);
        token1.safeTransfer(msg.sender, amount1);
        _sync();
        emit LiquidityRemoved(msg.sender, amount0, amount1, shares);
    }

    // ------------------------------------------------------------------ swap

    /// @notice Swaps an exact `amountIn` of `tokenIn` (pulled from msg.sender) for the other token.
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        (uint256 rIn, uint256 rOut) = _reservesFor(tokenIn);
        amountOut = _getAmountOut(amountIn, rIn, rOut);
        if (amountOut == 0 || amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);
        address tokenOut = tokenIn == token0 ? token1 : token0;
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenOut.safeTransfer(to, amountOut);
        _sync();
        emit Swap(msg.sender, tokenIn, amountIn, amountOut, to);
    }

    // ------------------------------------------------------------- internals

    function _reservesFor(address tokenIn) internal view returns (uint256 rIn, uint256 rOut) {
        if (tokenIn == token0) return (reserve0, reserve1);
        if (tokenIn == token1) return (reserve1, reserve0);
        revert InvalidToken();
    }

    function _getAmountOut(uint256 amountIn, uint256 rIn, uint256 rOut) internal pure returns (uint256) {
        if (rIn == 0 || rOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * (BPS - FEE_BPS);
        return amountInWithFee * rOut / (rIn * BPS + amountInWithFee);
    }

    function _sync() internal {
        reserve0 = token0.balanceOf(address(this));
        reserve1 = token1.balanceOf(address(this));
    }
}
