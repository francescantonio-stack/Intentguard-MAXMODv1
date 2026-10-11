# IntentGuard — submission write-up (Monad Metropolis, Track 04)

**One line.** IntentGuard brings safe AI agents to Monad with on-chain P256 passkey verification: the agent proposes, the
user approves the plan once with a passkey, and Monad executes only that plan.

**Repo:** https://github.com/francescantonio-stack/Intentguard-MAXMODv1 · **Testnet only, unaudited.**

## The problem
Agents that move money read untrusted text (web pages, emails, docs). One prompt injection ("send 50 USDC to 0x…") is
enough to drain a wallet whose keys the agent can use. Today the choice is "the agent holds keys" or "a human signs every
tx". Off-chain policy engines only move the trust to a server.

## What we built on Monad
**`PlanExecutor`, the enforcement layer**
([`0x3f1391EC12002E10E18Efa82Af5E491f8159faC1`](https://testnet.monadexplorer.com/address/0x3f1391EC12002E10E18Efa82Af5E491f8159faC1),
Monad testnet, chain 10143, source-verified on Sourcify):
- **Passkey verified on-chain on every plan.** `execute` runs only with a valid WebAuthn assertion over `planHash(plan)`.
  The check uses Solady `WebAuthn` on top of Monad's **P256 precompile `0x0100` (EIP-7951)** and costs **10,450 gas**
  (`contracts/evm/test/MonadGas.t.sol`). A pure-Solidity P-256 verifier costs hundreds of thousands of gas.
- **The passkey is the account's authority.** `registerPasskey` binds a passkey and a weekly cap to the account.
  `rotatePasskey` and `setWeeklyCap` need a signature from the current passkey.
- **Hard limits on-chain.** `planHash` is bound to the chain id and the contract address. `PlanExecutor` also enforces a
  per-account nonce, `executed[hash]`, a deadline, a per-plan ceiling (100 USDC) and a rolling 7-day cap. Swap and vault
  deposit run atomically, and outputs go only to `plan.account`.
- **Monad-aware engineering.** Foundry runs with `network = "monad"`, so the tests exercise the real precompile. Monad
  charges the gas limit, so every tx sets the limit from an estimate plus a margin, and the policy caps gas limit and fees.

**Supporting layers (interoperability and settlement into Monad):**
- **NEAR, a second check before any signature exists.** A policy contract plus Chain Signatures MPC give each user one
  EVM address on Monad, with no seed phrase and no key on the agent side. The policy enforces an allowlist per
  (chain, contract, selector) with calldata checks, own recipients only, a weekly cap, a per-plan budget and signature
  count, gas and fee caps, and a CCTP fee ceiling (0.5%).
- **Circle CCTP V2** brings real testnet USDC from Base Sepolia into Monad.

**Integrations:** five contract calls, no SDK required. TypeScript reference packages (`packages/core`, `packages/signer`),
an **MCP server** that gives any AI agent read + propose access with **no keys**, and a reference **PWA** (setup,
one-tap passkey approval, execution timeline, live guard log, attack demo).

## Proof on Monad testnet
| What | Tx |
|---|---|
| Passkey-verified `execute`: 1.999479 USDC, half swapped to native MON, half into the vault (582,218 gas) | [0x4c0501ea…](https://testnet.monadexplorer.com/tx/0x4c0501ea37f917411543aab82536235a5a7fb6c2ecbba4339499a5919852585d) |
| CCTP `receiveMessage`: 1.99974 USDC minted on Monad | [0x57986db9…](https://testnet.monadexplorer.com/tx/0x57986db9ce312e0d50b418d84d3add2fd4903911299e1a57adc9b9928679feaa) |
| `registerPasskey` | [0xd0664407…](https://testnet.monadexplorer.com/tx/0xd0664407272683196866a2b455ca42cca374082853b10cbdd92d23b0ce8db3c8) |

The full run (Base Sepolia burn → CCTP → Monad mint → passkey execution) took **135 s** with **one** passkey approval
covering 5 MPC signatures. `MiniSwap` and `DemoVault` are also deployed on Monad; all addresses and hashes are in
`deployments/`.

**Attacks blocked on-chain:**
- A 6 USDC plan **with a valid passkey signature** reverts in `PlanExecutor` on Monad with `OverWeeklyCap` (simulated
  with `eth_call` against the deployed contract).
- A plan over the weekly cap is rejected by NEAR `commit_plan`.
- "Send 50 USDC to 0xabc" is rejected by NEAR `request_signature` (recipient not in the allowlist).

## Judging criteria
| Criterion (20% each) | Evidence |
|---|---|
| **Monad integration** | Monad is where the user's approval is enforced: passkeys verified by the P256 precompile `0x0100` on every plan (10,450 gas per `WebAuthn.verify`), passkey-gated rotation and caps, real passkey-approved executions on Monad testnet, Monad gas-limit pricing handled, contracts source-verified. Real USDC reaches Monad through Circle CCTP V2. |
| **Technical excellence** | Two independent on-chain layers: if NEAR were bypassed, Monad still refuses without the passkey. Foundry: 44 passed, including 5 invariants over 8,192 random calls (replays, foreign passkeys, edited plans, time jumps), a WebAuthn assertion from a real phone passkey, and one produced by Chromium through the app's code. TypeScript: 58 passed, with the TS `planHash` pinned to the Solidity one. NEAR policy: 27 unit tests plus a sandbox test. CI gates every change (TS, Foundry, Rust, gitleaks). |
| **Product quality** | One natural-language command → readable plan → one fingerprint → execution on Monad with explorer links. Works without an LLM key (deterministic parser). Installable PWA. |
| **Track fit (04: Trust, Identity & AI Infrastructure)** | A primitive for Monad, not a closed app: passkey identity verified on Monad, user-signed spending policies and on-chain enforcement, consumed by any agent through five calls or the MCP server. |
| **Innovation** | Prompt-injection-proof agent spending: the agent can only *propose*. Signatures exist only inside the policy, and Monad re-checks the human's passkey on the exact plan. Demonstrated live: a hijacked agent is stopped three times. |

## Demo video (2 min)
- **0:00–0:30, the problem.** A hijacked agent tries to overspend and to pay a foreign address. The PWA attack demo
  shows the attempts blocked.
- **0:30–1:15, execution on Monad.** The user approves the plan with a passkey (WebAuthn). `PlanExecutor` on Monad
  verifies the P256 signature on-chain and executes the swap + vault deposit (Monad explorer). The cross-chain leg
  (Base Sepolia → CCTP → Monad) is shown pre-recorded, to avoid testnet bridge latency.
- **1:15–2:00, results and repo.** `forge test` passing, the `MonadGas` output (10,450 gas), the completed flow in the
  terminal, and the README with the Monad addresses.

## Bounties
- **Mera "One Passkey, Many Keys"**: one passkey + one NEAR account → deterministic keys on every EVM chain, used on Monad.
- **Aurora Intents (any-chain liquidity to Monad)**: real CCTP V2 into Monad gated by intent plans; NEAR Intents 1Click is
  the mainnet route (no testnet).
- **MetaMask Agent Wallet Plugin**: plan → passkey → policy-gated signing via the reference packages and MCP; a Snap
  wrapper is not built.

## Honest scope
Testnet only, unaudited. `MiniSwap` and `DemoVault` are ours (mock liquidity, mock vault); CCTP and Chain Signatures are
real. The passkey is verified on Monad, not yet on NEAR. The passkey in the headless runs is a software test key; the PWA
uses a real device passkey. The shared policy contract owner curates the allowlist; users keep the full-access key needed
to loosen their policy. Built with AI coding assistants (see README, "AI tools disclosure").

## Roadmap

**Planned, not built.** Monad stays the enforcement center: a `PlanExecutor` on each new chain still verifies the same
device passkey through a cheap P256 precompile. The live demo remains USDC ↔ MON on Monad testnet. Extra MiniSwap demo
tokens are out of scope here: the deployed `PlanExecutor` hardcodes USDC/WMON and the NEAR policy allowlists only those
targets. Changing that would need a new executor, new pools and owner `add_rule` calls — it would replace the live demo.

**Multichain execution.** Same derived EVM address on every EVM chain via path `"<user>,evm,1"`. Each chain gets its own
`PlanExecutor`. First wave (cheap P256 + Circle CCTP V2 + a public testnet): Base, Arbitrum, Unichain. Then Ethereum, OP,
Linea, World Chain, Ink, Avalanche, Polygon PoS, BNB Chain (no CCTP USDC), Sei (P256 at `0x1011`). After the EVM set:
Solana (Ed25519 Chain Signatures, new executor). Requires a NEAR policy upgrade: chain ids are hardcoded today to 10143
and 84532, USDC is set only in `new()`, and rules are single-spender / single-domain. That upgrade needs a `set_usdc`
setter and multi-spender / multi-domain rule variants.

**Any-token swaps on mainnet.** A DEX aggregator (not more in-house MiniSwap pools) with token safety checks (honeypot /
sell-tax, contract verification, liquidity thresholds), a price oracle so per-plan and weekly caps are denominated in
USD rather than USDC only, and allowlisted routers in the NEAR policy. The live testnet path stays Circle USDC →
MiniSwap → DemoVault.

**On-device planner.** A small local model (e.g. Gemma / Qwen 1–4B via llama.cpp or MLC) on the phone, no cloud API.
Small models make more mistakes; IntentGuard is why that is fine: the rules live outside the agent (NEAR policy before
any signature, passkey check on Monad at execution). Today the planner is a deterministic rules parser plus an optional
server-side LLM. "No cloud API required" is already true (`LLM_PROVIDER=rules`). On-device AI is planned, not built.
