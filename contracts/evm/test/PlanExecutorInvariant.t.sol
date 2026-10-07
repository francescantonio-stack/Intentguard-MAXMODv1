// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WebAuthn} from "solady/utils/WebAuthn.sol";
import {WebAuthnHelper} from "./utils/WebAuthnHelper.sol";
import {MockUSDC, MockWMON} from "./mocks/Mocks.sol";
import {MiniSwap} from "../src/MiniSwap.sol";
import {DemoVault} from "../src/DemoVault.sol";
import {PlanExecutor} from "../src/PlanExecutor.sol";

/// @notice Random sequences of honest executions, replays, forged and tampered plans, and time jumps.
///         Any successful attack is recorded as a violation instead of reverting, so the invariants can see it.
contract PlanExecutorHandler is WebAuthnHelper {
    PlanExecutor public immutable ex;
    MockUSDC public immutable usdc;
    MiniSwap public immutable pool;
    address public immutable account;
    uint256 internal constant PASSKEY = 0xA11CE5EC2E7;
    uint256 internal constant ATTACKER_PASSKEY = 0xBADBADBAD;

    uint256 public executions;
    uint256 public violations;
    uint256[] public execTimes;
    uint256[] public execAmounts;

    PlanExecutor.Plan internal lastPlan;
    WebAuthn.WebAuthnAuth internal lastAuth;
    bool internal hasLast;

    constructor(PlanExecutor ex_, MockUSDC usdc_, MiniSwap pool_, address account_) {
        ex = ex_;
        usdc = usdc_;
        pool = pool_;
        account = account_;
    }

    function _plan(uint256 amountSeed, uint256 swapBps, bool unwrap)
        internal
        view
        returns (PlanExecutor.Plan memory p)
    {
        uint256 amountIn = bound(amountSeed, 1, 6e6); // around the 5 USDC weekly cap
        uint256 swapAmount = amountIn * bound(swapBps, 0, 10_000) / 10_000;
        p = PlanExecutor.Plan({
            account: account,
            amountIn: amountIn,
            swapAmount: swapAmount,
            minAmountOut: swapAmount == 0 ? 0 : pool.getAmountOut(address(usdc), swapAmount) * 99 / 100,
            unwrap: unwrap,
            nonce: ex.nonces(account),
            deadline: block.timestamp + 10 minutes
        });
    }

    function execute(uint256 amountSeed, uint256 swapBps, bool unwrap) external {
        PlanExecutor.Plan memory p = _plan(amountSeed, swapBps, unwrap);
        WebAuthn.WebAuthnAuth memory auth = signAssertion(PASSKEY, ex.planHash(p));
        try ex.execute(p, auth) {
            executions++;
            execTimes.push(block.timestamp);
            execAmounts.push(p.amountIn);
            lastPlan = p;
            lastAuth = auth;
            hasLast = true;
        } catch {} // over the cap: expected to revert
    }

    function replay() external {
        if (!hasLast) return;
        try ex.execute(lastPlan, lastAuth) {
            violations++;
        } catch {}
    }

    function forged(uint256 amountSeed) external {
        PlanExecutor.Plan memory p = _plan(amountSeed, 5_000, true);
        try ex.execute(p, signAssertion(ATTACKER_PASSKEY, ex.planHash(p))) {
            violations++;
        } catch {}
    }

    function tampered(uint256 amountSeed) external {
        PlanExecutor.Plan memory p = _plan(amountSeed, 0, false);
        WebAuthn.WebAuthnAuth memory auth = signAssertion(PASSKEY, ex.planHash(p));
        p.amountIn += 1; // the agent changes the plan after the user approved it
        try ex.execute(p, auth) {
            violations++;
        } catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 3 days));
    }

    function spentSince(uint256 start) external view returns (uint256 total) {
        for (uint256 i; i < execTimes.length; i++) {
            if (execTimes[i] >= start) total += execAmounts[i];
        }
    }
}

contract PlanExecutorInvariantTest is WebAuthnHelper {
    PlanExecutor ex;
    MockUSDC usdc;
    MockWMON wmon;
    PlanExecutorHandler handler;
    address account = makeAddr("derivedEoa");
    uint256 constant USER_CAP = 5e6;

    function setUp() public {
        vm.warp(1_790_000_000);
        usdc = new MockUSDC();
        wmon = new MockWMON();
        MiniSwap pool = new MiniSwap(address(usdc), address(wmon));
        DemoVault vault = new DemoVault(address(usdc), 6, "IntentGuard Demo Vault USDC", "igvUSDC");
        ex = new PlanExecutor(address(usdc), address(wmon), address(pool), address(vault), 100e6, 1_000e6);

        address lp = makeAddr("lp");
        usdc.mint(lp, 1_000e6);
        vm.deal(lp, 1_000e18);
        vm.startPrank(lp);
        wmon.deposit{value: 1_000e18}();
        usdc.approve(address(pool), type(uint256).max);
        wmon.approve(address(pool), type(uint256).max);
        pool.addLiquidity(1_000e6, 1_000e18);
        vm.stopPrank();

        usdc.mint(account, 10_000e6);
        (bytes32 x, bytes32 y) = passkeyPublic(0xA11CE5EC2E7);
        vm.startPrank(account);
        ex.registerPasskey(x, y, USER_CAP);
        usdc.approve(address(ex), type(uint256).max);
        vm.stopPrank();

        handler = new PlanExecutorHandler(ex, usdc, pool, account);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = PlanExecutorHandler.execute.selector;
        selectors[1] = PlanExecutorHandler.replay.selector;
        selectors[2] = PlanExecutorHandler.forged.selector;
        selectors[3] = PlanExecutorHandler.tampered.selector;
        selectors[4] = PlanExecutorHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Replays, foreign passkeys and edited plans never move funds.
    function invariant_onlyApprovedPlansExecute() public view {
        assertEq(handler.violations(), 0);
    }

    /// The on-chain weekly counter never exceeds the cap the user signed for.
    function invariant_capNeverExceeded() public view {
        (uint128 cap, uint128 spent,) = ex.limits(account);
        assertLe(spent, cap);
    }

    /// Independent check: everything actually executed in the current period fits the cap.
    function invariant_executedInPeriodFitsCap() public view {
        (,, uint64 periodStart) = ex.limits(account);
        assertLe(handler.spentSince(periodStart), USER_CAP);
    }

    /// One nonce per executed plan: no plan executes twice, none is skipped.
    function invariant_nonceCountsExecutions() public view {
        assertEq(ex.nonces(account), handler.executions());
    }

    /// Guard against vacuous passes: the honest path must actually run.
    function afterInvariant() public view {
        assertGt(handler.executions(), 0);
    }

    /// The executor never keeps user funds.
    function invariant_executorHoldsNothing() public view {
        assertEq(usdc.balanceOf(address(ex)), 0);
        assertEq(wmon.balanceOf(address(ex)), 0);
        assertEq(address(ex).balance, 0);
    }
}
