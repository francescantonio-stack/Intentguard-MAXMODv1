# Demo video (≤ 3 minutes)

Record on the phone (screen) + laptop (explorers). Testnet only. Do one dry run first: Setup done, faucets used,
passkey registered on Monad, weekly allowance ≥ 2 USDC on both NEAR and Monad.

| Time | Scene | Show |
|---|---|---|
| 0:00–0:20 | Problem | "AI agents can move money. A prompt injection is enough to drain a wallet." |
| 0:20–0:50 | Primitive | README diagram: agent proposes → passkey approves the plan → NEAR policy gates every signature → Monad verifies the passkey on-chain (P256 precompile, ~10.5k gas). |
| 0:50–1:30 | Approve | App: demo command → plan card (amounts, cap, 30 min validity) → one fingerprint. |
| 1:30–2:20 | Execute | Timeline: Base burn (CCTP V2) → attestation → Monad mint → swap + vault in one `execute`. Click the explorer links. |
| 2:20–2:45 | Attack | Attack demo: hijacked agent → blocked by the planner → bypass the app → **rejected on-chain** (nearblocks link) → forged passkey → `InvalidSignature` revert. Guard log shows the rejection. |
| 2:45–3:00 | Integrate | MCP: `intentguard_propose_plan` from Claude returns an approval link; "any agent, no keys". |
