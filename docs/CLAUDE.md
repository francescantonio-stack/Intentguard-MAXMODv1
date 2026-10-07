# CLAUDE.md — IntentGuard (Monad Metropolis prototype)

You are helping build a **testnet-only** hackathon prototype for Monad Metropolis (Track 04: Trust, Identity & AI Infrastructure).
Work is **milestone-based**: there are no internal dates, and the official deadline is the one shown on the platform. Track 04 rewards **protocols, primitives and infrastructure other apps build on**, not standalone consumer products. Judging: product quality, technical excellence, Monad integration, track fit and innovation, 20% each.
The owner works part-time, with Claude Code. Work in small, verifiable steps. Each milestone below has a "done when" check. Never call a milestone done until its check passes.

## 1. What we are building

A **trust-layer primitive for AI agents**: any agent or wallet can move funds only within passkey-signed user policies. They are enforced on NEAR (policy contract + Chain Signatures) and on Monad (`PlanExecutor`, P256 precompile). The installable PWA below is the **reference integration**:

1. The user types a natural-language command, e.g.
   *"Porta 2 USDC da Base su Monad, cambiane metà in MON e metti il resto nel vault. Non spendere più di 5 USDC a settimana."*
2. An LLM parses the text into a **typed intent** (JSON schema). A deterministic regex parser is the fallback.
3. A **deterministic planner** (no LLM) turns the intent into an ordered list of concrete EVM transactions.
4. The user approves the **plan hash** with a **passkey** (WebAuthn, P-256). There is no seed phrase.
5. Every EVM tx is signed through **NEAR Chain Signatures**:
   - the PWA calls our **NEAR policy contract**;
   - the policy contract checks the allowlist (chain/contract/selector) and the weekly spend caps;
   - only then does it call the MPC signer `v1.signer-prod.testnet`.
6. On Monad, `PlanExecutor` **re-verifies the passkey signature on-chain** via the P256 precompile (`0x0100`), then does swap + vault deposit atomically.
7. Cross-chain leg: **real Circle CCTP V2** from Base Sepolia (domain 6) to Monad Testnet (domain 15). NEAR Intents 1Click has no testnet, so it appears only as an optional `dry: true` quote in the UI.

Two-layer guardrail story:
- **NEAR policy layer**: allowlist + caps, enforced before a signature exists.
- **Monad on-chain passkey layer**: an approved-plan check enforced at execution.

## 2. Hard safety rules (never violate)

- **Testnet only.** Allowed chains:
  - Monad testnet (chainId **10143**)
  - Base Sepolia (chainId **84532**)
  - NEAR **testnet**

  Refuse to add any mainnet RPC as a write target. The only mainnet exception is the read-only 1Click `dry: true` quote call.
- **No real keys in the repo.**
  - Secrets live only in `.env.local` (gitignored) or the Foundry keystore.
  - Never print private keys, never write them to files other than `.env.local`, and never commit `.env*` (except `.env.example` with empty values).
  - Add `gitleaks` (or an equivalent grep) to CI and to a pre-commit hook.
- **LLM API keys stay server-side** (Next.js route handler). They must never be in client bundles or `NEXT_PUBLIC_*` vars.
- **Only the command text goes to the LLM.** No keys, no personal data. The free tiers may use inputs for training.
- **No EIP-7702 on Monad.** Delegated EOAs are subject to the 10 MON reserve balance.
- Monad charges gas on the **gas limit**, not on the gas used. Always set an explicit `gas` = estimate × 1.1. Never use a blanket 1,000,000.
- **Send one tx at a time per address and wait for the receipt before the next one.** This avoids nonce races and the Monad reserve-balance edge cases.
- Keep everything free. Do not add paid services or SDKs that require paid plans.

## 3. Stack

| Area | Choice |
|---|---|
| App | Next.js (App Router) + TypeScript (strict), installable PWA (manifest + service worker), Tailwind |
| EVM client | `viem` v2 |
| NEAR client | `near-api-js` v7 (or the `@near-js/*` packages it re-exports) |
| Chain Signatures | `chainsig.js` (the library recommended by the NEAR docs): address derivation, tx serialization, signature formatting, broadcast. The **signature request itself goes through our policy contract**, not directly to `v1.signer-prod.testnet` |
| Passkeys | Browser WebAuthn API (`@simplewebauthn/browser` is fine) |
| On-chain WebAuthn | Solady `WebAuthn.sol` / `P256.sol` (precompile at `0x…0100`; Monad implements EIP-7951 at that address) |
| EVM contracts | Foundry ≥ 1.8.0. `foundry.toml` sets `network = "monad"` for Monad profiles; tests run with `anvil --network monad` or `--fork-url https://testnet-rpc.monad.xyz` |
| NEAR contract | Rust + `near-sdk`, built with `cargo near`. Use `omni-transaction` to build the EIP-1559 tx/hash inside the contract if practical; otherwise accept tx fields and recompute the hash |
| Validation | `zod` (intent schema) + JSON Schema export for the LLM |
| LLM | Gemini API free tier, model `gemini-3.5-flash-lite`, with structured JSON output. Fallback: Groq `openai/gpt-oss-20b`. Final fallback: deterministic parser. Provider chosen by env var |
| Tests | Vitest (TS), `forge test`, `cargo test` (+ near-workspaces if cheap) |
| Package manager | pnpm workspaces |

Before writing integration code, **check the installed versions' actual APIs** (`node_modules/<pkg>/dist/*.d.ts`, `cargo doc`), because they change often. Do not guess method names.

## 4. Network and contract constants (verified 3 Oct 2026)

**Monad testnet (10143)**
- RPC: `https://testnet-rpc.monad.xyz` (50 rps; 25 rps for eth_call/estimateGas). Alternatives: `https://rpc.ankr.com/monad_testnet`, `https://rpc-testnet.monadinfra.com`
- Explorers: `https://testnet.monadvision.com`, `https://testnet.monadscan.com`
- Base fee was about 100 gwei.
- Circle USDC (6 dec): `0x534b2f3A21130d7a60830c2Df862319e593943A3`
- WMON: `0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541`
- Multicall3: `0xcA11bde05977b3631167028862bE2a173976CA11`
- P256 precompile: `0x0000000000000000000000000000000000000100`
- Reserve-balance precompile: `0x1001`

**Base Sepolia (84532)**
- RPC: `https://sepolia.base.org`
- Explorer: `https://sepolia.basescan.org`
- Circle USDC (6 dec): `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

**Circle CCTP V2 (testnet, identical on both chains)**
- TokenMessengerV2: `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`
- MessageTransmitterV2: `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`
- Domains: Base Sepolia = 6, Monad Testnet = 15.
- Attestation API (sandbox): `https://iris-api-sandbox.circle.com` (`/v2/messages/{srcDomain}?transactionHash=…`, fees `/v2/burn/USDC/fees/{src}/{dst}`). Verify the exact paths against Circle docs before coding.
- Upfront fees are not supported on Monad Testnet. Do not use them.

**NEAR testnet**
- MPC signer: `v1.signer-prod.testnet`.
- `sign({ request: { path, payload_v2: { Ecdsa: "<32-byte hex>" }, domain_id: 0 } })`.
- Each call needs a deposit of ≥ 1 yoctoNEAR (excess refunded) and ≥ 10 Tgas (~7 Tgas used).
- Function-call access keys cannot attach deposits. **So the policy contract attaches the 1 yocto itself from its own balance.**
- The derived EVM address depends on the **predecessor account** (= our policy contract) + `path`.
  - Use `path = "<user_account_id>,evm,1"`, so each user gets one EVM address that is the same on Monad and Base Sepolia.

**Kuru (stretch only)**
- Market MON/USDC testnet: `0xa241896A7Dbe8a550D2E5fF7A914bB1989ceD2D9` (quote token `0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570`, which is NOT Circle USDC).
- The router address conflicts between the Kuru docs and the Monad registry. Verify on-chain before use.

## 5. Repo layout

```
/apps/web                  Next.js PWA (chat, plan card, passkey, execution timeline)
  /app/api/parse/route.ts  server-side LLM call (Gemini | Groq | rules)
/packages/core             intent schema (zod), deterministic parser, planner, chain config, amounts (bigint only)
/packages/signer           policy-contract client (near-api-js), chainsig.js wrapper, tx queue, broadcaster
/packages/cctp             burn → attestation polling → receiveMessage helpers
/contracts/evm             Foundry: MiniSwap.sol, DemoVault.sol (ERC-4626), PlanExecutor.sol, tests, script/Deploy.s.sol
/contracts/near-policy     Rust near-sdk policy contract + tests
/scripts                   tsx scripts: derive-address, smoke-sign, seed-miniswap, e2e-demo
/deployments               monad-testnet.json, base-sepolia.json, near-testnet.json (addresses only)
/docs                      architecture.md, demo-script.md, submission.md
```

## 6. Contracts (spec)

**MiniSwap (Monad)**
- Constant-product pool for Circle USDC ↔ native MON.
- Functions: `addLiquidity`, `swapExactUsdcForMon(uint256 usdcIn, uint256 minMonOut, address to)`, `swapExactMonForUsdc`, `quote*` views.
- 0.3% fee, reentrancy guard. Keep it small and readable. The README states that "testnet liquidity is seeded by us".

**DemoVault (Monad)**
- ERC-4626 over Circle USDC (Solady or OpenZeppelin ERC4626).
- No strategy: it just holds the asset. Clearly labeled as a mock vault.

**PlanExecutor (Monad)**
- `registerPasskey(bytes32 x, bytes32 y)`: called by the user's MPC-derived EOA; one passkey per EOA.
- `execute(Plan calldata plan, WebAuthn.WebAuthnAuth calldata auth)`:
  1. compute `planHash = keccak256(abi.encode(plan, block.chainid, address(this), nonce[msg.sender]))`;
  2. require `WebAuthn.verify(abi.encode(planHash), /*requireUV*/ true, auth, x, y)`;
  3. pull USDC with `transferFrom`;
  4. swap part on MiniSwap;
  5. deposit the rest into DemoVault for `msg.sender`;
  6. increment the nonce and emit `PlanExecuted`.
- Reverts on a bad signature, replay, or expired `plan.deadline`.

**NEAR policy contract**
- State:
  - `owner`;
  - per-user config: `weekly_cap[token]`, `spent_this_week[token]` with a rolling 7-day window based on `env::block_timestamp`;
  - allowlist of `(chain_id, to, selector)`;
  - `approved_plans` (optional).
- `request_signature(chain_id, tx: Eip1559Fields, plan_hash) -> Promise`:
  - rejects chains other than 10143/84532 and targets/selectors not in the allowlist;
  - decodes static ABI args for the allowlisted selectors (`approve`, `depositForBurn`, `receiveMessage`, `execute`, `registerPasskey`) to get the USDC amount, and checks/updates the cap;
  - computes the EIP-1559 signing hash and calls the MPC with path `"{predecessor},evm,1"`, attaching 1 yocto;
  - in the callback, returns the signature, **rolling back the spend if the MPC call failed**;
  - emits a NEP-297 event for every accept/reject.
- `approve` spender must be in the allowlist (PlanExecutor, TokenMessengerV2). Unlimited approvals are rejected; the amount must be ≤ the remaining cap.

## 7. Intent schema (v1)

```ts
type Intent = {
  version: 1;
  actions: Array<
    | { type: "bridge"; token: "USDC"; amount: string; from: "base-sepolia"; to: "monad-testnet" }
    | { type: "swap"; chain: "monad-testnet"; sell: "USDC"; buy: "MON"; amount: string | { fractionOfPrevious: number } }
    | { type: "deposit"; chain: "monad-testnet"; vault: "demo-usdc"; amount: string | "remaining" }
    | { type: "transfer"; chain: "monad-testnet" | "base-sepolia"; token: "USDC" | "MON"; amount: string; to: string }
  >;
  limits?: { weeklyCap?: { token: "USDC"; amount: string } };
  rawText: string;
};
```

Amounts are decimal strings. They are converted to bigint with token decimals only in the planner. Never use JS floats for amounts.

## 8. Milestones (ordered; no dates; move on as soon as "done when" passes)

| # | Milestone | Done when | Status |
|---|---|---|---|
| M0 | Repo, secret scanning, `.env.example` | Private repo with MIT license; gitleaks clean on full history; forge deps as submodules | done |
| M1 | EVM contracts | `forge test` green (WebAuthn vectors, Monad fork). Deployed and Sourcify-verified on Monad testnet; addresses in `deployments/monad-testnet.json` | done |
| M2 | NEAR policy + MPC signing | `cargo test` + sandbox green. Deployed; MPC-signed tx broadcast on Monad; recovered signer = derived address | done |
| M3 | Agent: schema, parsers, planner | Demo command + 9 more map to the expected intents (LLM mocked); the planner emits exact amounts and the `PlanExecutor.Plan` | done (`packages/core`: zod schema + JSON Schema, rules parser, LLM-with-fallback wrapper, planner; `pnpm -r test`). Provider adapters (Gemini/Groq) go in the app |
| M4 | Reference integration (PWA) | Browser: onboarding, real device passkey, command → plan → approval → execute, explorer timeline | code done (`apps/web`; Chromium WebAuthn vector verified in Foundry); todo: one run on a real phone via the Vercel URL |
| M5 | Full cross-chain flow | One passkey-approved plan: Base burn → attestation → Monad `receiveMessage` → `execute`; negatives rejected | done headless (`scripts/cctp-base-to-monad.mjs --execute`); wired in the PWA (`runPlan`), todo: one real run from the UI |
| M6 | Hardening | Three consecutive clean runs, readable errors, adequate pool liquidity, `maxFee` cap in the CCTP rule | todo |
| M7 | Submission | Judge-facing English README framed for Track 04 (done); **video ≤ 3 minutes**; **team created** on the platform; project profile with Track 04 + bounties (Mera "One Passkey, Many Keys", Aurora Intents any-chain liquidity, MetaMask Agent Wallet Plugin); repo made **public at submission** with an **OSI license** (MIT); final gitleaks run | todo |

## 9. Acceptance tests (must pass before submission)

1. `pnpm -r test`, `forge test` and `cargo test` are all green.
2. **Address consistency:** the derived EVM address for a user is identical on Monad and Base Sepolia and matches the `chainsig.js` derivation for predecessor = policy contract.
3. **Policy:**
   - a tx to a non-allowlisted contract is rejected;
   - an `approve` over the remaining weekly cap is rejected;
   - two plans summing to more than 5 USDC in 7 days: the second is rejected.
4. **Passkey:**
   - `execute` with a signature over a different planHash reverts;
   - a replay of the same signature reverts;
   - a valid signature succeeds.
5. **E2E:** the demo command on testnets ends with MON received and vault shares minted for the user's derived address; all tx hashes are shown in the UI.
6. **Resilience:** with the LLM key unset, the demo command still works via the rules parser.
7. **Secrets:** `git log -p` contains no private keys or API keys (gitleaks clean). No `NEXT_PUBLIC_` var contains a secret.

## 10. Environment variables (`.env.example`, all values empty in git)

```
# Networks (testnet only)
MONAD_RPC_URL=https://testnet-rpc.monad.xyz
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
NEAR_NETWORK_ID=testnet
NEAR_RPC_URL=
MPC_CONTRACT_ID=v1.signer-prod.testnet
POLICY_CONTRACT_ID=            # e.g. policy-<name>.testnet

# Deployer (dev-only EOA, testnet funds only; prefer Foundry keystore over raw key)
DEPLOYER_PRIVATE_KEY=

# NEAR (dev scripts only; the PWA stores its own function-call key in IndexedDB)
NEAR_ACCOUNT_ID=
NEAR_PRIVATE_KEY=

# LLM (server-side only)
LLM_PROVIDER=gemini            # gemini | groq | rules
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-20b

# CCTP
CIRCLE_IRIS_API_URL=https://iris-api-sandbox.circle.com

# Optional (stretch): 1Click quote, read-only dry run
ONECLICK_API_URL=https://1click.chaindefuser.com
ONECLICK_JWT=

# Public (safe)
NEXT_PUBLIC_MONAD_CHAIN_ID=10143
NEXT_PUBLIC_BASE_SEPOLIA_CHAIN_ID=84532
NEXT_PUBLIC_POLICY_CONTRACT_ID=
NEXT_PUBLIC_PLAN_EXECUTOR_ADDRESS=
```

## 11. Working conventions

- Keep diffs small. After each step, run the relevant tests and report what passed.
- When an external API/ABI is uncertain, write a tiny probe script first (read-only call), then code against the observed result.
- Prefer testing on `anvil --fork-url` (free) before spending testnet MON. Testnet MON is scarce.
- Every on-chain write in scripts prints chain, from, to, value, gas limit and the explorer URL, and asks for confirmation (`--yes` to skip) before sending.
- Document every mock honestly in the README ("MiniSwap/DemoVault are ours; CCTP and Chain Signatures are real").
