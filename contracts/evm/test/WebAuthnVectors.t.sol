// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";
import {P256} from "solady/utils/P256.sol";

/// @notice Cross-checks with vectors produced by an independent implementation (Python `cryptography`,
///         scripts/live-checks/*.py), not by Foundry cheatcodes.
contract WebAuthnVectorsTest is Test {
    function _load(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/", name));
    }

    function test_precompileAvailable() public view {
        assertTrue(P256.hasPrecompile(), "P256 precompile 0x0100 missing (need network = monad / Osaka)");
    }

    function test_rawP256Vector() public view {
        string memory j = _load("p256_vector.json");
        bytes32 h = vm.parseJsonBytes32(j, ".hash");
        bytes32 r = vm.parseJsonBytes32(j, ".r");
        bytes32 s = vm.parseJsonBytes32(j, ".s");
        bytes32 x = vm.parseJsonBytes32(j, ".x");
        bytes32 y = vm.parseJsonBytes32(j, ".y");
        assertTrue(P256.verifySignature(h, r, s, x, y));
        assertFalse(P256.verifySignature(h ^ bytes32(uint256(1)), r, s, x, y));
        // direct precompile call, same as the live eth_call check
        (bool ok, bytes memory ret) = address(0x100).staticcall(abi.encodePacked(h, r, s, x, y));
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint256)), 1);
    }

    function _auth(string memory j) internal pure returns (WebAuthn.WebAuthnAuth memory a) {
        a.authenticatorData = vm.parseJsonBytes(j, ".authenticatorData");
        a.clientDataJSON = vm.parseJsonString(j, ".clientDataJSON");
        a.challengeIndex = vm.parseJsonUint(j, ".challengeIndex");
        a.typeIndex = vm.parseJsonUint(j, ".typeIndex");
        a.r = vm.parseJsonBytes32(j, ".r");
        a.s = vm.parseJsonBytes32(j, ".s");
    }

    function test_independentWebAuthnVector() public view {
        string memory j = _load("webauthn_vector.json");
        WebAuthn.WebAuthnAuth memory a = _auth(j);
        bytes memory challenge = vm.parseJsonBytes(j, ".challenge");
        bytes32 x = vm.parseJsonBytes32(j, ".x");
        bytes32 y = vm.parseJsonBytes32(j, ".y");
        assertTrue(WebAuthn.verify(challenge, true, a, x, y));
        challenge[31] = challenge[31] ^ 0x01;
        assertFalse(WebAuthn.verify(challenge, true, a, x, y));
    }

    /// TODO(Max): replace test/fixtures/browser_vector.json with a vector produced by a REAL browser passkey
    ///            (see tools/make-vector.html). Until then this test is skipped.
    function test_browserVector_ifPresent() public {
        string memory path = string.concat(vm.projectRoot(), "/test/fixtures/browser_vector.json");
        if (!vm.exists(path)) {
            vm.skip(true);
            return;
        }
        string memory j = vm.readFile(path);
        WebAuthn.WebAuthnAuth memory a = _auth(j);
        assertTrue(
            WebAuthn.verify(
                vm.parseJsonBytes(j, ".challenge"), true, a, vm.parseJsonBytes32(j, ".x"), vm.parseJsonBytes32(j, ".y")
            )
        );
    }
}
