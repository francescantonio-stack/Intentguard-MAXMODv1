// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WebAuthn} from "solady/utils/WebAuthn.sol";
import {WebAuthnHelper} from "./utils/WebAuthnHelper.sol";
import {MockUSDC, MockWMON} from "./mocks/Mocks.sol";
import {MiniSwap} from "../src/MiniSwap.sol";
import {DemoVault} from "../src/DemoVault.sol";
import {PlanExecutor} from "../src/PlanExecutor.sol";

contract PlanExecutorTest is WebAuthnHelper {
    MockUSDC usdc;
    MockWMON wmon;
    MiniSwap pool;
    DemoVault vault;
    PlanExecutor ex;

    // Passkey private keys (P-256 scalars), test-only.
    uint256 constant PASSKEY = 0xA11CE5EC2E7;
    uint256 constant ATTACKER_PASSKEY = 0xBADBADBAD;

    address account = makeAddr("derivedEoa"); // stands in for the Chain-Signatures-derived EOA
    address relayer = makeAddr("relayer");

    uint256 constant MAX_PLAN = 100e6; // 100 USDC per plan (contract ceiling)
    uint256 constant MAX_WEEKLY = 1_000e6; // ceiling for user caps
    uint256 constant USER_CAP = 5e6; // "Non spendere più di 5 USDC a settimana"

    function setUp() public {
        vm.warp(1_790_000_000);
        usdc = new MockUSDC();
        wmon = new MockWMON();
        pool = new MiniSwap(address(usdc), address(wmon));
        vault = new DemoVault(address(usdc), 6, "IntentGuard Demo Vault USDC", "igvUSDC");
        ex = new PlanExecutor(address(usdc), address(wmon), address(pool), address(vault), MAX_PLAN, MAX_WEEKLY);

        // seed pool 1,000 USDC / 1,000 WMON
        address lp = makeAddr("lp");
        usdc.mint(lp, 1_000e6);
        vm.deal(lp, 1_000e18);
        vm.startPrank(lp);
        wmon.deposit{value: 1_000e18}();
        usdc.approve(address(pool), type(uint256).max);
        wmon.approve(address(pool), type(uint256).max);
        pool.addLiquidity(1_000e6, 1_000e18);
        vm.stopPrank();

        // the user's derived EOA holds 50 USDC (arrived via CCTP in the real flow)
        usdc.mint(account, 50e6);
        (bytes32 x, bytes32 y) = passkeyPublic(PASSKEY);
        vm.startPrank(account);
        ex.registerPasskey(x, y, USER_CAP);
        usdc.approve(address(ex), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _plan(uint256 amountIn, uint256 swapAmount, bool unwrap) internal view returns (PlanExecutor.Plan memory p) {
        p = PlanExecutor.Plan({
            account: account,
            amountIn: amountIn,
            swapAmount: swapAmount,
            minAmountOut: 0,
            unwrap: unwrap,
            nonce: ex.nonces(account),
            deadline: block.timestamp + 10 minutes
        });
        if (swapAmount > 0) p.minAmountOut = pool.getAmountOut(address(usdc), swapAmount) * 99 / 100; // 1% slippage
    }

    function _sign(PlanExecutor.Plan memory p, uint256 pk) internal view returns (WebAuthn.WebAuthnAuth memory) {
        return signAssertion(pk, ex.planHash(p));
    }

    // ------------------------------------------------------------- happy path

    /// The demo: "2 USDC: metà in MON, il resto nel vault" — native MON delivered.
    function test_demoPlan_swapHalfToMon_depositRest() public {
        PlanExecutor.Plan memory p = _plan(2e6, 1e6, true);
        WebAuthn.WebAuthnAuth memory auth = _sign(p, PASSKEY);
        uint256 monBefore = account.balance;
        uint256 expectedOut = pool.getAmountOut(address(usdc), 1e6);

        vm.expectEmit(true, true, false, true, address(ex));
        emit PlanExecutor.PlanExecuted(ex.planHash(p), account, 2e6, 1e6, expectedOut, 1e6 * 1e6);
        vm.prank(relayer); // anyone can relay: the passkey signature is the authorization
        (uint256 out, uint256 shares) = ex.execute(p, auth);

        assertEq(out, expectedOut);
        assertEq(account.balance - monBefore, out); // native MON received
        assertEq(usdc.balanceOf(account), 48e6);
        assertEq(vault.balanceOf(account), shares);
        assertEq(vault.convertToAssets(shares), 1e6);
        assertEq(ex.nonces(account), 1);
        assertTrue(ex.executed(ex.planHash(p)));
        assertEq(ex.remainingThisPeriod(account), USER_CAP - 2e6);
        // executor keeps nothing
        assertEq(usdc.balanceOf(address(ex)), 0);
        assertEq(wmon.balanceOf(address(ex)), 0);
        assertEq(address(ex).balance, 0);
    }

    function test_plan_wmonDelivery_noUnwrap() public {
        PlanExecutor.Plan memory p = _plan(1e6, 1e6, false);
        ex.execute(p, _sign(p, PASSKEY));
        assertGt(wmon.balanceOf(account), 0);
        assertEq(vault.balanceOf(account), 0);
    }

    function test_plan_depositOnly() public {
        PlanExecutor.Plan memory p = _plan(3e6, 0, false);
        (uint256 out, uint256 shares) = ex.execute(p, _sign(p, PASSKEY));
        assertEq(out, 0);
        assertEq(vault.convertToAssets(shares), 3e6);
    }

    // -------------------------------------------- negative: authorization

    /// NEGATIVE (required): a plan signed by a different passkey is rejected.
    function test_revert_unauthorizedPasskey() public {
        PlanExecutor.Plan memory p = _plan(2e6, 1e6, true);
        WebAuthn.WebAuthnAuth memory _a = _sign(p, ATTACKER_PASSKEY);
        vm.expectRevert(PlanExecutor.InvalidSignature.selector);
        ex.execute(p, _a);
    }

    /// The agent (or a compromised frontend) tampers with the plan after approval.
    function test_revert_tamperedPlan() public {
        PlanExecutor.Plan memory p = _plan(2e6, 1e6, true);
        WebAuthn.WebAuthnAuth memory auth = _sign(p, PASSKEY);
        p.swapAmount = 2e6; // changed after signing
        vm.expectRevert(PlanExecutor.InvalidSignature.selector);
        ex.execute(p, auth);
    }

    function test_revert_planForOtherAccount() public {
        address victim = makeAddr("victim");
        PlanExecutor.Plan memory p = _plan(1e6, 0, false);
        p.account = victim; // victim never registered
        WebAuthn.WebAuthnAuth memory _a = _sign(p, PASSKEY);
        vm.expectRevert(PlanExecutor.NotRegistered.selector);
        ex.execute(p, _a);
    }

    function test_revert_replay() public {
        PlanExecutor.Plan memory p = _plan(1e6, 0, false);
        WebAuthn.WebAuthnAuth memory auth = _sign(p, PASSKEY);
        ex.execute(p, auth);
        vm.expectRevert(PlanExecutor.AlreadyExecuted.selector);
        ex.execute(p, auth);
    }

    function test_revert_badNonce() public {
        PlanExecutor.Plan memory p = _plan(1e6, 0, false);
        p.nonce = 7;
        WebAuthn.WebAuthnAuth memory _a = _sign(p, PASSKEY);
        vm.expectRevert(abi.encodeWithSelector(PlanExecutor.BadNonce.selector, 0, 7));
        ex.execute(p, _a);
    }

    function test_revert_expired() public {
        PlanExecutor.Plan memory p = _plan(1e6, 0, false);
        WebAuthn.WebAuthnAuth memory auth = _sign(p, PASSKEY);
        vm.warp(p.deadline + 1);
        vm.expectRevert(PlanExecutor.Expired.selector);
        ex.execute(p, auth);
    }

    function test_revert_highS_malleable() public {
        PlanExecutor.Plan memory p = _plan(1e6, 0, false);
        WebAuthn.WebAuthnAuth memory auth =
            signAssertionCustom(PASSKEY, ex.planHash(p), FLAGS_UP_UV, "webauthn.get", false);
        vm.expectRevert(PlanExecutor.InvalidSignature.selector);
        ex.execute(p, auth);
    }

    function test_revert_userNotVerified() public {
        PlanExecutor.Plan memory p = _plan(1e6, 0, false);
        WebAuthn.WebAuthnAuth memory auth = signAssertionCustom(PASSKEY, ex.planHash(p), 0x01, "webauthn.get", true);
        vm.expectRevert(PlanExecutor.InvalidSignature.selector);
        ex.execute(p, auth);
    }

    function test_revert_wrongClientDataType() public {
        PlanExecutor.Plan memory p = _plan(1e6, 0, false);
        WebAuthn.WebAuthnAuth memory auth =
            signAssertionCustom(PASSKEY, ex.planHash(p), FLAGS_UP_UV, "webauthn.create", true);
        vm.expectRevert(PlanExecutor.InvalidSignature.selector);
        ex.execute(p, auth);
    }

    function test_revert_crossDeploymentReplay() public {
        // same plan, same passkey, but signed for another PlanExecutor deployment
        PlanExecutor other =
            new PlanExecutor(address(usdc), address(wmon), address(pool), address(vault), MAX_PLAN, MAX_WEEKLY);
        PlanExecutor.Plan memory p = _plan(1e6, 0, false);
        WebAuthn.WebAuthnAuth memory authForOther = signAssertion(PASSKEY, other.planHash(p));
        vm.expectRevert(PlanExecutor.InvalidSignature.selector);
        ex.execute(p, authForOther);
    }

    // ------------------------------------------------- negative: limits

    /// NEGATIVE (required): over the user's weekly cap → rejected even with a valid passkey.
    function test_revert_overWeeklyCap_singlePlan() public {
        PlanExecutor.Plan memory p = _plan(6e6, 3e6, true); // cap is 5 USDC
        WebAuthn.WebAuthnAuth memory _a = _sign(p, PASSKEY);
        vm.expectRevert(abi.encodeWithSelector(PlanExecutor.OverWeeklyCap.selector, 6e6, 5e6));
        ex.execute(p, _a);
    }

    function test_revert_overWeeklyCap_cumulative_thenResetAfter7Days() public {
        PlanExecutor.Plan memory p1 = _plan(4e6, 0, false);
        ex.execute(p1, _sign(p1, PASSKEY));
        PlanExecutor.Plan memory p2 = _plan(2e6, 0, false);
        WebAuthn.WebAuthnAuth memory a2 = _sign(p2, PASSKEY);
        vm.expectRevert(abi.encodeWithSelector(PlanExecutor.OverWeeklyCap.selector, 2e6, 1e6));
        ex.execute(p2, a2);
        // after the rolling period the cap is available again
        vm.warp(block.timestamp + 7 days);
        p2.deadline = block.timestamp + 10 minutes;
        ex.execute(p2, _sign(p2, PASSKEY));
        assertEq(ex.remainingThisPeriod(account), 3e6);
    }

    function test_revert_overPlanLimit() public {
        // raise the user cap to the ceiling via passkey, then exceed the per-plan ceiling
        ex.setWeeklyCap(account, MAX_WEEKLY, signAssertion(PASSKEY, _capHash(MAX_WEEKLY)));
        usdc.mint(account, 200e6);
        PlanExecutor.Plan memory p = _plan(MAX_PLAN + 1, 0, false);
        WebAuthn.WebAuthnAuth memory _a = _sign(p, PASSKEY);
        vm.expectRevert(abi.encodeWithSelector(PlanExecutor.OverPlanLimit.selector, MAX_PLAN + 1, MAX_PLAN));
        ex.execute(p, _a);
    }

    function test_revert_invalidAmounts() public {
        PlanExecutor.Plan memory p = _plan(1e6, 0, false);
        p.swapAmount = 2e6;
        WebAuthn.WebAuthnAuth memory _a = _sign(p, PASSKEY);
        vm.expectRevert(PlanExecutor.InvalidAmounts.selector);
        ex.execute(p, _a);
        p = _plan(0, 0, false);
        _a = _sign(p, PASSKEY);
        vm.expectRevert(PlanExecutor.InvalidAmounts.selector);
        ex.execute(p, _a);
    }

    function test_revert_slippageBubblesUp() public {
        PlanExecutor.Plan memory p = _plan(2e6, 1e6, true);
        p.minAmountOut = 10e18; // impossible
        WebAuthn.WebAuthnAuth memory _a = _sign(p, PASSKEY);
        vm.expectRevert();
        ex.execute(p, _a);
        assertEq(ex.nonces(account), 0); // nothing consumed
        assertEq(ex.remainingThisPeriod(account), USER_CAP);
    }

    // ------------------------------------------------ registration / admin

    function test_revert_registerTwice() public {
        (bytes32 x, bytes32 y) = passkeyPublic(ATTACKER_PASSKEY);
        vm.prank(account);
        vm.expectRevert(PlanExecutor.AlreadyRegistered.selector);
        ex.registerPasskey(x, y, USER_CAP);
    }

    function test_revert_registerInvalidCap() public {
        address fresh = makeAddr("fresh");
        (bytes32 x, bytes32 y) = passkeyPublic(PASSKEY);
        vm.startPrank(fresh);
        vm.expectRevert(PlanExecutor.InvalidCap.selector);
        ex.registerPasskey(x, y, 0);
        vm.expectRevert(PlanExecutor.InvalidCap.selector);
        ex.registerPasskey(x, y, MAX_WEEKLY + 1);
        vm.stopPrank();
    }

    function _capHash(uint256 cap) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(ex.SET_CAP_TYPEHASH(), account, cap, ex.nonces(account)));
        return keccak256(abi.encodePacked(bytes2(0x1901), block.chainid, address(ex), structHash));
    }

    function _rotateHash(bytes32 x, bytes32 y) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(ex.ROTATE_TYPEHASH(), account, x, y, ex.nonces(account)));
        return keccak256(abi.encodePacked(bytes2(0x1901), block.chainid, address(ex), structHash));
    }

    function test_setWeeklyCap_requiresPasskey() public {
        WebAuthn.WebAuthnAuth memory _a = signAssertion(ATTACKER_PASSKEY, _capHash(50e6));
        vm.expectRevert(PlanExecutor.InvalidSignature.selector);
        ex.setWeeklyCap(account, 50e6, _a);
        ex.setWeeklyCap(account, 50e6, signAssertion(PASSKEY, _capHash(50e6)));
        (uint128 cap,,) = ex.limits(account);
        assertEq(cap, 50e6);
    }

    function test_rotatePasskey() public {
        (bytes32 nx, bytes32 ny) = passkeyPublic(ATTACKER_PASSKEY); // "new device" key
        WebAuthn.WebAuthnAuth memory _a = signAssertion(ATTACKER_PASSKEY, _rotateHash(nx, ny));
        vm.expectRevert(PlanExecutor.InvalidSignature.selector);
        ex.rotatePasskey(account, nx, ny, _a);
        ex.rotatePasskey(account, nx, ny, signAssertion(PASSKEY, _rotateHash(nx, ny)));
        // old passkey no longer works, new one does
        PlanExecutor.Plan memory p = _plan(1e6, 0, false);
        _a = _sign(p, PASSKEY);
        vm.expectRevert(PlanExecutor.InvalidSignature.selector);
        ex.execute(p, _a);
        ex.execute(p, _sign(p, ATTACKER_PASSKEY));
    }

    function test_revert_receiveFromNonWmon() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(ex).call{value: 1}("");
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ fuzz

    /// Any plan within limits, approved by the right passkey, executes and conserves value.
    function testFuzz_withinLimits_executes(uint256 amountIn, uint256 swapBps, bool unwrap) public {
        amountIn = bound(amountIn, 1, USER_CAP);
        uint256 swapAmount = amountIn * bound(swapBps, 0, 10_000) / 10_000;
        PlanExecutor.Plan memory p = _plan(amountIn, swapAmount, unwrap);
        if (swapAmount > 0) vm.assume(pool.getAmountOut(address(usdc), swapAmount) > 0);
        uint256 usdcBefore = usdc.balanceOf(account);
        (, uint256 shares) = ex.execute(p, _sign(p, PASSKEY));
        assertEq(usdcBefore - usdc.balanceOf(account), amountIn);
        assertEq(vault.convertToAssets(shares), amountIn - swapAmount);
        assertEq(usdc.balanceOf(address(ex)), 0);
        assertEq(ex.remainingThisPeriod(account), USER_CAP - amountIn);
    }

    /// Any plan above the weekly cap is rejected, regardless of split.
    function testFuzz_overCap_rejected(uint256 amountIn, uint256 swapBps) public {
        amountIn = bound(amountIn, USER_CAP + 1, MAX_PLAN);
        uint256 swapAmount = amountIn * bound(swapBps, 0, 10_000) / 10_000;
        PlanExecutor.Plan memory p = _plan(amountIn, swapAmount, true);
        WebAuthn.WebAuthnAuth memory auth = _sign(p, PASSKEY);
        vm.expectRevert(abi.encodeWithSelector(PlanExecutor.OverWeeklyCap.selector, amountIn, USER_CAP));
        ex.execute(p, auth);
    }

    /// Any passkey other than the registered one is rejected.
    function testFuzz_randomPasskey_rejected(uint256 pk) public {
        pk = bound(pk, 1, P256_N - 1);
        vm.assume(pk != PASSKEY);
        PlanExecutor.Plan memory p = _plan(1e6, 5e5, true);
        WebAuthn.WebAuthnAuth memory auth = _sign(p, pk);
        vm.expectRevert(PlanExecutor.InvalidSignature.selector);
        ex.execute(p, auth);
    }
}
