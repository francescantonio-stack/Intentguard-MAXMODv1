// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";
import {WebAuthnHelper} from "./utils/WebAuthnHelper.sol";

/// @notice Gas of the on-chain passkey check with Monad's P256 precompile (0x0100, EIP-7951),
///         under foundry.toml `network = "monad"`. Run: forge test --match-contract MonadGas -vv
contract MonadGasTest is WebAuthnHelper {
    function test_gas_webauthnVerify_withPrecompile() public view {
        uint256 pk = 0xA11CE5EC2E7;
        bytes32 challenge = keccak256("plan");
        (bytes32 x, bytes32 y) = passkeyPublic(pk);
        WebAuthn.WebAuthnAuth memory auth = signAssertion(pk, challenge);
        uint256 g = gasleft();
        bool ok = WebAuthn.verify(abi.encodePacked(challenge), true, auth, x, y);
        uint256 used = g - gasleft();
        assertTrue(ok);
        assertLt(used, 50_000); // a pure-Solidity P-256 verifier costs hundreds of thousands of gas
        console2.log("WebAuthn.verify gas (P256 precompile):", used);
    }
}
