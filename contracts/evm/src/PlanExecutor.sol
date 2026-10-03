// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WebAuthn} from "solady/utils/WebAuthn.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";

interface IMiniSwap {
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)
        external
        returns (uint256 amountOut);
}

interface IERC4626Deposit {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
}

interface IWMON {
    function withdraw(uint256 amount) external;
}

/// @title PlanExecutor
/// @notice Executes an AI-generated plan ("swap part of USDC to MON, deposit the rest into a vault")
///         ONLY if the plan hash was approved with the account's passkey (WebAuthn / P-256).
///         Verification uses Solady WebAuthn -> P256 precompile at 0x0100 (EIP-7951 on Monad).
/// @dev TESTNET DEMO. Second guardrail layer: the first is the NEAR policy contract that gates
///      Chain Signatures. Even if a signature for `execute` is obtained, funds move only with a
///      valid passkey signature over the exact plan, within on-chain limits, once (nonce), before deadline.
contract PlanExecutor is ReentrancyGuard {
    using SafeTransferLib for address;

    // ----------------------------------------------------------------- types

    struct Plan {
        address account; // owner of the funds (Chain-Signatures-derived EOA); receives outputs
        uint256 amountIn; // total USDC (6 decimals) pulled from `account`
        uint256 swapAmount; // part of amountIn swapped to WMON/MON; the rest is deposited in the vault
        uint256 minAmountOut; // slippage bound for the swap
        bool unwrap; // deliver native MON instead of WMON
        uint256 nonce; // must equal nonces[account]
        uint256 deadline; // unix seconds
    }

    struct Passkey {
        bytes32 x;
        bytes32 y;
    }

    struct Limits {
        uint128 weeklyCap; // max USDC per rolling 7-day period (0 = account not configured)
        uint128 spentInPeriod;
        uint64 periodStart;
    }

    // ------------------------------------------------------------- constants

    bytes32 public constant PLAN_TYPEHASH = keccak256(
        "Plan(address account,uint256 amountIn,uint256 swapAmount,uint256 minAmountOut,bool unwrap,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant ROTATE_TYPEHASH = keccak256("RotatePasskey(address account,bytes32 x,bytes32 y,uint256 nonce)");
    bytes32 public constant SET_CAP_TYPEHASH = keccak256("SetWeeklyCap(address account,uint256 weeklyCap,uint256 nonce)");
    uint256 public constant PERIOD = 7 days;

    // ----------------------------------------------------------- immutables

    address public immutable usdc;
    address public immutable wmon;
    IMiniSwap public immutable pool;
    IERC4626Deposit public immutable vault;
    /// @notice Hard ceiling for a single plan, regardless of user settings (protects the demo).
    uint256 public immutable maxPlanAmount;
    /// @notice Hard ceiling for any user-chosen weekly cap.
    uint256 public immutable maxWeeklyCap;

    // ---------------------------------------------------------------- state

    mapping(address => Passkey) public passkeys;
    mapping(address => Limits) public limits;
    mapping(address => uint256) public nonces;
    mapping(bytes32 => bool) public executed;

    // --------------------------------------------------------------- events

    event PasskeyRegistered(address indexed account, bytes32 x, bytes32 y, uint256 weeklyCap);
    event PasskeyRotated(address indexed account, bytes32 x, bytes32 y);
    event WeeklyCapChanged(address indexed account, uint256 weeklyCap);
    event PlanExecuted(
        bytes32 indexed planHash,
        address indexed account,
        uint256 amountIn,
        uint256 swapAmount,
        uint256 amountOut,
        uint256 vaultShares
    );

    // --------------------------------------------------------------- errors

    error AlreadyRegistered();
    error NotRegistered();
    error InvalidPasskey();
    error InvalidCap();
    error InvalidSignature();
    error BadNonce(uint256 expected, uint256 got);
    error Expired();
    error AlreadyExecuted();
    error InvalidAmounts();
    error OverPlanLimit(uint256 amountIn, uint256 maxPlanAmount);
    error OverWeeklyCap(uint256 requested, uint256 remaining);

    constructor(
        address usdc_,
        address wmon_,
        address pool_,
        address vault_,
        uint256 maxPlanAmount_,
        uint256 maxWeeklyCap_
    ) {
        usdc = usdc_;
        wmon = wmon_;
        pool = IMiniSwap(pool_);
        vault = IERC4626Deposit(vault_);
        maxPlanAmount = maxPlanAmount_;
        maxWeeklyCap = maxWeeklyCap_;
    }

    /// @dev Needed to receive native MON from WMON.withdraw.
    receive() external payable {
        if (msg.sender != wmon) revert();
    }

    // -------------------------------------------------------- registration

    /// @notice Binds a passkey (P-256 public key) and a weekly cap to msg.sender. One-time;
    ///         later changes require a signature from the current passkey.
    function registerPasskey(bytes32 x, bytes32 y, uint256 weeklyCap) external {
        if (passkeys[msg.sender].x != 0 || passkeys[msg.sender].y != 0) revert AlreadyRegistered();
        if (x == 0 && y == 0) revert InvalidPasskey();
        if (weeklyCap == 0 || weeklyCap > maxWeeklyCap) revert InvalidCap();
        passkeys[msg.sender] = Passkey(x, y);
        limits[msg.sender] = Limits(SafeCastLib.toUint128(weeklyCap), 0, SafeCastLib.toUint64(block.timestamp));
        emit PasskeyRegistered(msg.sender, x, y, weeklyCap);
    }

    /// @notice Rotates the passkey; authorized by the CURRENT passkey. Anyone may relay.
    function rotatePasskey(address account, bytes32 newX, bytes32 newY, WebAuthn.WebAuthnAuth calldata auth) external {
        if (newX == 0 && newY == 0) revert InvalidPasskey();
        bytes32 h = _hashTyped(keccak256(abi.encode(ROTATE_TYPEHASH, account, newX, newY, nonces[account])));
        _requirePasskey(account, h, auth);
        nonces[account]++;
        passkeys[account] = Passkey(newX, newY);
        emit PasskeyRotated(account, newX, newY);
    }

    /// @notice Changes the weekly cap; authorized by the passkey. Anyone may relay.
    function setWeeklyCap(address account, uint256 weeklyCap, WebAuthn.WebAuthnAuth calldata auth) external {
        if (weeklyCap == 0 || weeklyCap > maxWeeklyCap) revert InvalidCap();
        bytes32 h = _hashTyped(keccak256(abi.encode(SET_CAP_TYPEHASH, account, weeklyCap, nonces[account])));
        _requirePasskey(account, h, auth);
        nonces[account]++;
        limits[account].weeklyCap = SafeCastLib.toUint128(weeklyCap);
        emit WeeklyCapChanged(account, weeklyCap);
    }

    // ------------------------------------------------------------ execution

    /// @notice Domain-separated hash of a plan. This 32-byte value is the WebAuthn challenge.
    function planHash(Plan calldata plan) public view returns (bytes32) {
        return _hashTyped(
            keccak256(
                abi.encode(
                    PLAN_TYPEHASH,
                    plan.account,
                    plan.amountIn,
                    plan.swapAmount,
                    plan.minAmountOut,
                    plan.unwrap,
                    plan.nonce,
                    plan.deadline
                )
            )
        );
    }

    /// @notice Remaining USDC allowance for the current rolling period.
    function remainingThisPeriod(address account) public view returns (uint256) {
        Limits memory l = limits[account];
        if (block.timestamp >= uint256(l.periodStart) + PERIOD) return l.weeklyCap;
        return l.spentInPeriod >= l.weeklyCap ? 0 : l.weeklyCap - l.spentInPeriod;
    }

    /// @notice Executes `plan` if `auth` is a valid passkey assertion over `planHash(plan)`.
    ///         Anyone may relay (the passkey signature is the authorization); outputs always go to plan.account.
    function execute(Plan calldata plan, WebAuthn.WebAuthnAuth calldata auth)
        external
        nonReentrant
        returns (uint256 amountOut, uint256 vaultShares)
    {
        bytes32 h = planHash(plan);
        if (executed[h]) revert AlreadyExecuted();
        if (block.timestamp > plan.deadline) revert Expired();
        if (plan.nonce != nonces[plan.account]) revert BadNonce(nonces[plan.account], plan.nonce);
        if (plan.amountIn == 0 || plan.swapAmount > plan.amountIn) revert InvalidAmounts();
        if (plan.amountIn > maxPlanAmount) revert OverPlanLimit(plan.amountIn, maxPlanAmount);
        _requirePasskey(plan.account, h, auth);
        _consumeCap(plan.account, plan.amountIn);

        executed[h] = true;
        nonces[plan.account]++;

        usdc.safeTransferFrom(plan.account, address(this), plan.amountIn);

        if (plan.swapAmount > 0) {
            usdc.safeApprove(address(pool), plan.swapAmount);
            if (plan.unwrap) {
                amountOut = pool.swapExactIn(usdc, plan.swapAmount, plan.minAmountOut, address(this));
                IWMON(wmon).withdraw(amountOut);
                plan.account.safeTransferETH(amountOut);
            } else {
                amountOut = pool.swapExactIn(usdc, plan.swapAmount, plan.minAmountOut, plan.account);
            }
        }

        uint256 toDeposit = plan.amountIn - plan.swapAmount;
        if (toDeposit > 0) {
            usdc.safeApprove(address(vault), toDeposit);
            vaultShares = vault.deposit(toDeposit, plan.account);
        }

        emit PlanExecuted(h, plan.account, plan.amountIn, plan.swapAmount, amountOut, vaultShares);
    }

    // ------------------------------------------------------------- internals

    function _hashTyped(bytes32 structHash) internal view returns (bytes32) {
        // Bind to this chain and this contract (prevents cross-chain / cross-deployment replay).
        return keccak256(abi.encodePacked(bytes2(0x1901), block.chainid, address(this), structHash));
    }

    function _requirePasskey(address account, bytes32 h, WebAuthn.WebAuthnAuth calldata auth) internal view {
        Passkey memory pk = passkeys[account];
        if (pk.x == 0 && pk.y == 0) revert NotRegistered();
        // requireUserVerification = true: the authenticator must have verified the user (biometric/PIN).
        if (!WebAuthn.verify(abi.encodePacked(h), true, auth, pk.x, pk.y)) revert InvalidSignature();
    }

    function _consumeCap(address account, uint256 amount) internal {
        Limits storage l = limits[account];
        if (block.timestamp >= uint256(l.periodStart) + PERIOD) {
            l.periodStart = SafeCastLib.toUint64(block.timestamp);
            l.spentInPeriod = 0;
        }
        uint256 remaining = l.spentInPeriod >= l.weeklyCap ? 0 : l.weeklyCap - l.spentInPeriod;
        if (amount > remaining) revert OverWeeklyCap(amount, remaining);
        l.spentInPeriod += SafeCastLib.toUint128(amount);
    }
}
