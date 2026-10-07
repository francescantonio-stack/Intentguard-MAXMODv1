// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PlanExecutor} from "../src/PlanExecutor.sol";

/// @notice Pins PlanExecutor.planHash to the value computed off-chain by packages/core (planHash.ts),
///         so the passkey challenge built by the client always matches what the contract verifies.
contract PlanHashVectorTest is Test {
    address constant MONAD_PLAN_EXECUTOR = 0x3f1391EC12002E10E18Efa82Af5E491f8159faC1;

    function test_planHash_matchesCoreVector() public {
        vm.chainId(10143);
        deployCodeTo(
            "PlanExecutor.sol:PlanExecutor",
            abi.encode(address(1), address(2), address(3), address(4), uint256(100e6), uint256(1000e6)),
            MONAD_PLAN_EXECUTOR
        );
        PlanExecutor.Plan memory p = PlanExecutor.Plan({
            account: 0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B,
            amountIn: 1_000_000,
            swapAmount: 500_000,
            minAmountOut: 123_456_789,
            unwrap: true,
            nonce: 7,
            deadline: 1_800_000_000
        });
        assertEq(PlanExecutor(payable(MONAD_PLAN_EXECUTOR)).planHash(p), bytes32(0x5e684f0da345231ea31b267600824e68a2b06e4a489ec4a574643e7ab4c65147));
    }
}
