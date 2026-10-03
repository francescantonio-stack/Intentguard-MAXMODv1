// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

/// @dev Builds WebAuthn assertions exactly like a browser authenticator would
///      (clientDataJSON + authenticatorData, P-256 over sha256(authData || sha256(clientDataJSON))),
///      signing with Foundry's vm.signP256 cheatcode.
abstract contract WebAuthnHelper is Test {
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    bytes1 internal constant FLAGS_UP_UV = 0x05; // User Present + User Verified
    string internal constant ORIGIN = "https://intentguard.example";

    function passkeyPublic(uint256 pk) internal pure returns (bytes32 x, bytes32 y) {
        (uint256 px, uint256 py) = vm.publicKeyP256(pk);
        return (bytes32(px), bytes32(py));
    }

    function clientData(bytes32 challenge, string memory typ) internal pure returns (string memory) {
        return string.concat(
            '{"type":"', typ, '","challenge":"', Base64.encode(abi.encodePacked(challenge), true, true),
            '","origin":"', ORIGIN, '","crossOrigin":false}'
        );
    }

    function signAssertion(uint256 pk, bytes32 challenge) internal pure returns (WebAuthn.WebAuthnAuth memory) {
        return signAssertionCustom(pk, challenge, FLAGS_UP_UV, "webauthn.get", true);
    }

    function signAssertionCustom(uint256 pk, bytes32 challenge, bytes1 flags, string memory typ, bool lowS)
        internal
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        auth.authenticatorData = abi.encodePacked(sha256("intentguard.example"), flags, uint32(1));
        auth.clientDataJSON = clientData(challenge, typ);
        auth.typeIndex = 1; // position of `"type":"`
        auth.challengeIndex = _indexOf(auth.clientDataJSON, '"challenge":"');
        bytes32 digest = sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, digest);
        uint256 sv = uint256(s);
        bool isLow = sv <= P256_N / 2;
        if (lowS != isLow) sv = P256_N - sv; // force the requested form
        auth.r = r;
        auth.s = bytes32(sv);
    }

    function _indexOf(string memory hay, string memory needle) internal pure returns (uint256) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        for (uint256 i; i + n.length <= h.length; ++i) {
            bool ok = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) { ok = false; break; }
            }
            if (ok) return i;
        }
        revert("needle not found");
    }
}
