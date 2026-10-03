// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MiniSwap} from "../src/MiniSwap.sol";
import {DemoVault} from "../src/DemoVault.sol";
import {PlanExecutor} from "../src/PlanExecutor.sol";

/// @notice Deploys MiniSwap + DemoVault + PlanExecutor. Testnet only (refuses any other chain).
///
/// Local rehearsal (no funds):  anvil --fork-url https://testnet-rpc.monad.xyz --network monad
///   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key #0>
/// Real Monad testnet (Max, after faucet):
///   forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast --account <keystore-name>
contract Deploy is Script {
    address constant MONAD_USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;
    address constant MONAD_WMON = 0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541;

    function run() external returns (MiniSwap pool, DemoVault vault, PlanExecutor ex) {
        require(block.chainid == 10143, "Deploy: Monad testnet (or its local fork) only");
        uint256 maxPlan = vm.envOr("MAX_PLAN_USDC", uint256(100e6)); // 100 USDC per plan
        uint256 maxWeekly = vm.envOr("MAX_WEEKLY_CAP_USDC", uint256(1_000e6)); // ceiling for user caps

        vm.startBroadcast();
        pool = new MiniSwap(MONAD_USDC, MONAD_WMON);
        vault = new DemoVault(MONAD_USDC, 6, "IntentGuard Demo Vault USDC", "igvUSDC");
        ex = new PlanExecutor(MONAD_USDC, MONAD_WMON, address(pool), address(vault), maxPlan, maxWeekly);
        vm.stopBroadcast();

        console2.log("MiniSwap     ", address(pool));
        console2.log("DemoVault    ", address(vault));
        console2.log("PlanExecutor ", address(ex));

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "usdc", MONAD_USDC);
        vm.serializeAddress(k, "wmon", MONAD_WMON);
        vm.serializeAddress(k, "miniSwap", address(pool));
        vm.serializeAddress(k, "demoVault", address(vault));
        string memory json = vm.serializeAddress(k, "planExecutor", address(ex));
        string memory file = vm.envOr("DEPLOYMENTS_FILE", string("../../deployments/monad-testnet.local-fork.json"));
        vm.writeJson(json, file);
    }
}
