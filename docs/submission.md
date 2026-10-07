# IntentGuard — submission write-up (Monad Metropolis, Track 04)

**One line.** AI agents propose; the user approves the plan once with a passkey; NEAR and Monad refuse everything outside it.

## The problem
Agents that move money read untrusted text (web pages, emails, docs). One prompt injection ("send 50 USDC to 0x…") is
enough to drain a wallet whose keys the agent can use. Today the choice is "agent holds keys" or "human signs every tx".

## What we built
A **trust-layer primitive** other agents and wallets plug into:
- **Passkey identity, no seed phrase.** One device passkey plus one NEAR account control a deterministic EVM address,
  identical on Monad and Base Sepolia (NEAR Chain Signatures).
- **Layer 1, NEAR policy contract (before a signature exists).** Allowlist per (chain, contract, selector) with calldata
  checks, own-recipients only, weekly cap, per-plan budget and signature count, gas/fee caps, CCTP fee ceiling (0.5%).
- **Layer 2, Monad `PlanExecutor` (at execution).** Verifies the WebAuthn passkey over the exact plan hash on-chain via the
  P256 precompile, with nonce, deadline, per-plan ceiling and on-chain weekly cap; swap + vault deposit atomically.
- **Integrations.** A TypeScript SDK (`packages/core`, `packages/signer`), an **MCP server** so any AI agent gets
  read + propose access with **no keys**, and a reference **PWA** (setup, one-tap approval, execution timeline, live guard
  log, attack demo).

## Judging criteria
| Criterion (20% each) | Evidence |
|---|---|
| **Product quality** | One natural-language command → readable plan → one fingerprint → real cross-chain execution with explorer links. Works without an LLM key (deterministic parser). Installable PWA. |
| **Technical excellence** | Two independent on-chain enforcement layers. Foundry: 5 invariants over 8,192 random calls (replays, foreign passkeys, edited plans, time jumps) plus a WebAuthn assertion produced by Chromium through the app's code verified by the contract. TS `planHash` pinned to the Solidity one. CI gates every change (TS, Foundry, Rust, gitleaks). |
| **Monad integration** | P256 precompile `0x0100` for passkeys (~10.5k gas per `WebAuthn.verify`), Monad gas-limit pricing handled (estimate × 1.1, fee caps in the policy), real Circle CCTP V2 Base Sepolia → Monad, contracts source-verified on Monad testnet. |
| **Track fit (04: Trust, Identity & AI Infrastructure)** | A primitive, not a closed app: passkey identity + user-signed spending policies + on-chain enforcement, consumed through an SDK and an MCP server by any agent. |
| **Innovation** | Prompt-injection-proof agent spending: the agent can only *propose*; signatures exist only inside the policy, and Monad re-checks the human's passkey on the exact plan. Demonstrated live: a hijacked agent is stopped three times. |

## Demo (≤ 3 min)
Command "Porta 2 USDC da Base su Monad, cambiane metà in MON e metti il resto nel vault. Non spendere più di 5 USDC a
settimana." → plan → passkey → Base burn → CCTP attestation → Monad mint → swap + vault. Then the attack demo:
blocked by the planner, rejected on-chain by the NEAR policy (nearblocks link), reverted by `PlanExecutor`.

## Bounties
- **Mera "One Passkey, Many Keys"**: one passkey + one NEAR account → deterministic keys on every EVM chain.
- **Aurora Intents (any-chain liquidity to Monad)**: real CCTP V2 into Monad gated by intent plans; NEAR Intents 1Click is
  the mainnet route (no testnet).
- **MetaMask Agent Wallet Plugin**: plan → passkey → policy-gated signing via SDK and MCP; a Snap wrapper is not built.

## Honest scope
Testnet only, unaudited. `MiniSwap` and `DemoVault` are ours (mock liquidity / mock vault); CCTP and Chain Signatures are
real. The shared policy contract owner curates the allowlist; users keep the full-access key needed to loosen their policy.
Built with AI coding assistants (see README, "AI tools disclosure").
