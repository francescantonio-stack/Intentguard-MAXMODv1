# Review guidance for IntentGuard

IntentGuard is a testnet-only trust layer for AI agents: a NEAR policy contract gates Chain Signatures, and
PlanExecutor on Monad verifies a passkey (WebAuthn, P-256 precompile 0x0100) over the exact plan.

When reviewing, prioritize:
1. Anything that lets funds move without the user's passkey over the exact plan, or beyond the weekly cap.
2. Replay across chains, contracts, nonces or deadlines; signature malleability (high-S).
3. Allowlist bypass in the NEAR policy (calldata decoding, selectors, recipients, approvals, CCTP fields).
4. Mainnet endpoints, private keys or API keys in code, client bundles or NEXT_PUBLIC_* variables.
5. JS floats used for token amounts (must be bigint), missing tests for new invariants.
Keep comments specific; skip style nits.
