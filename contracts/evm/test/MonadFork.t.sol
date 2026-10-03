// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WebAuthn} from "solady/utils/WebAuthn.sol";
import {WebAuthnHelper} from "./utils/WebAuthnHelper.sol";
import {MiniSwap} from "../src/MiniSwap.sol";
import {DemoVault} from "../src/DemoVault.sol";
import {PlanExecutor} from "../src/PlanExecutor.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IWMONReal is IERC20 {
    function deposit() external payable;
}

/// @notice Integration test on a LOCAL fork of Monad testnet with the REAL Circle USDC and WMON contracts.
///         Nothing is sent to the real network. Run with:  FORK=1 forge test --match-contract MonadFork -vv
contract MonadForkTest is WebAuthnHelper {
    address constant USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3; // Circle USDC, Monad testnet
    address constant WMON = 0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541;
    address constant CCTP_TOKEN_MESSENGER_V2 = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    address constant CCTP_MESSAGE_TRANSMITTER_V2 = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275;
    // Example Chain-Signatures-derived address: predecessor "intentguard-policy.testnet", path "maxz-demo.testnet,evm,1"
    address constant DERIVED = 0x99C0a0818d8aDBED43ae2EC6ea1F2B539B249E5B;
    uint256 constant PASSKEY = 0xA11CE5EC2E7;

    MiniSwap pool;
    DemoVault vault;
    PlanExecutor ex;

    function setUp() public {
        if (!vm.envOr("FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.rpcUrl("monad_testnet"));
        assertEq(block.chainid, 10143);
    }

    function test_fork_realContractsPresent() public view {
        assertGt(USDC.code.length, 0);
        assertGt(WMON.code.length, 0);
        assertGt(CCTP_TOKEN_MESSENGER_V2.code.length, 0);
        assertGt(CCTP_MESSAGE_TRANSMITTER_V2.code.length, 0);
        assertEq(IERC20(USDC).decimals(), 6);
    }

    function test_fork_fullDemoPlan_realUsdcAndWmon() public {
        // deploy our contracts on the fork
        pool = new MiniSwap(USDC, WMON);
        vault = new DemoVault(USDC, 6, "IntentGuard Demo Vault USDC", "igvUSDC");
        ex = new PlanExecutor(USDC, WMON, address(pool), address(vault), 100e6, 1_000e6);

        // seed liquidity: 20 USDC / 20 WMON (fork-only balances via cheatcodes)
        address lp = makeAddr("lp");
        deal(USDC, lp, 20e6);
        vm.deal(lp, 20 ether);
        vm.startPrank(lp);
        IWMONReal(WMON).deposit{value: 20 ether}();
        IERC20(USDC).approve(address(pool), type(uint256).max);
        IERC20(WMON).approve(address(pool), type(uint256).max);
        pool.addLiquidity(20e6, 20 ether);
        vm.stopPrank();

        // the derived EOA received 2 USDC via CCTP (simulated with deal) and registers its passkey
        deal(USDC, DERIVED, 2e6);
        (bytes32 x, bytes32 y) = passkeyPublic(PASSKEY);
        vm.startPrank(DERIVED);
        ex.registerPasskey(x, y, 5e6);
        IERC20(USDC).approve(address(ex), 2e6);
        vm.stopPrank();

        PlanExecutor.Plan memory p = PlanExecutor.Plan({
            account: DERIVED,
            amountIn: 2e6,
            swapAmount: 1e6,
            minAmountOut: pool.getAmountOut(USDC, 1e6) * 99 / 100,
            unwrap: true,
            nonce: 0,
            deadline: block.timestamp + 10 minutes
        });
        WebAuthn.WebAuthnAuth memory auth = signAssertion(PASSKEY, ex.planHash(p));
        uint256 monBefore = DERIVED.balance;
        uint256 g = gasleft();
        (uint256 out, uint256 shares) = ex.execute(p, auth);
        emit log_named_uint("execute() gas used on fork", g - gasleft());
        assertEq(DERIVED.balance - monBefore, out);
        assertEq(vault.convertToAssets(shares), 1e6);
        assertEq(IERC20(USDC).balanceOf(DERIVED), 0);

        // negative on fork: over-cap plan rejected
        deal(USDC, DERIVED, 10e6);
        vm.prank(DERIVED);
        IERC20(USDC).approve(address(ex), 10e6);
        p.amountIn = 4e6;
        p.swapAmount = 0;
        p.minAmountOut = 0;
        p.nonce = 1;
        WebAuthn.WebAuthnAuth memory a2 = signAssertion(PASSKEY, ex.planHash(p));
        vm.expectRevert(abi.encodeWithSelector(PlanExecutor.OverWeeklyCap.selector, 4e6, 3e6));
        ex.execute(p, a2);
    }
}
