// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WebAuthn} from "solady/utils/WebAuthn.sol";
import {P256} from "solady/utils/P256.sol";

/// @notice Read-only live probe. NEVER deployed: its creation code is executed via `eth_call`
///         (no `to`), so the constructor runs on the real chain node and returns
///         abi.encode(hasPrecompile, webauthnValid, webauthnTamperedValid) — zero funds needed.
contract WebAuthnProbe {
    constructor(bytes memory challenge, WebAuthn.WebAuthnAuth memory auth, bytes32 x, bytes32 y) {
        bool hasPre = P256.hasPrecompile();
        bool ok = WebAuthn.verify(challenge, true, auth, x, y);
        challenge[0] = challenge[0] ^ 0x01; // tamper one bit of the challenge
        bool tampered = WebAuthn.verify(challenge, true, auth, x, y);
        bytes memory ret = abi.encode(hasPre, ok, tampered);
        assembly {
            return(add(ret, 0x20), mload(ret))
        }
    }
}
