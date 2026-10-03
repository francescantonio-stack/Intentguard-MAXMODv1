# Prompt per Claude Code (da incollare nell'ordine)

Come usarli:
- Mettere `CLAUDE.md` nella root del repo **prima** del prompt 1.
- Incollare un prompt alla volta e passare al successivo solo quando il criterio "Done when" della milestone è soddisfatto.
- I prompt sono in inglese, come CLAUDE.md. Le parti fra `<…>` vanno compilate.
- Nessun prompt chiede a Claude Code di gestire chiavi reali. Le chiavi le mette Max a mano in `.env.local`.

---

## Prompt 1: scaffold del monorepo (M0)

```
Read CLAUDE.md fully. Then do milestone M0 only.

1. Create a pnpm workspace monorepo with the layout in CLAUDE.md §5 (apps/web, packages/core, packages/signer, packages/cctp, contracts/evm, contracts/near-policy, scripts, deployments, docs). Leave the folders empty except for minimal package.json / README stubs.
2. apps/web: Next.js App Router + TypeScript strict + Tailwind, with a PWA manifest and a minimal service worker. Show a placeholder page "IntentGuard: testnet only".
3. packages/core: set up Vitest with one trivial test.
4. Add .gitignore (node_modules, .next, out, cache, broadcast, target, .env*, keep .env.example), .env.example exactly as in CLAUDE.md §10 with empty secrets, an MIT LICENSE and a README skeleton.
5. Add a GitHub Actions CI that runs pnpm install, build and test, plus gitleaks. Add a pre-commit hook (simple-git-hooks or husky) that runs gitleaks protect --staged if gitleaks is installed and otherwise a grep for "PRIVATE_KEY=0x" and "AIza".
6. Before pinning versions, check the actual latest versions with `npm view <pkg> version` (next, viem, near-api-js, chainsig.js, zod, vitest). Do not guess.

Do not install any paid service. Do not create or print any keys.
When done, run the build and tests, show me the output, and list the files you created.
```

## Prompt 2: contratti EVM con Foundry (M1)

```
Do milestone M1 from CLAUDE.md (§6 for the contract specs).

1. In contracts/evm, init Foundry. Check `forge --version` is >= 1.8.0; if not, tell me the exact command to update it and stop. Configure foundry.toml with a `monad` profile using `network = "monad"`, plus solady (and OpenZeppelin only if needed) as dependencies.
2. Implement MiniSwap.sol, DemoVault.sol (ERC-4626 over a USDC address passed in the constructor) and PlanExecutor.sol, exactly per CLAUDE.md §6. Use Solady WebAuthn.sol for passkey verification (it calls the P256 precompile at 0x0100, which Monad implements via EIP-7951).
3. Tests:
   - unit tests for swap math, vault deposit/withdraw, and PlanExecutor happy path + bad signature + replay + expired deadline;
   - for WebAuthn, add a test that uses a fixed, real browser-generated vector. Leave a clearly marked TODO fixture file test/fixtures/webauthn-vector.json and a tiny HTML page (contracts/evm/tools/make-vector.html) that I can open on localhost to generate it with my own passkey (it must output x, y, authenticatorData, clientDataJSON, r, s with low-S normalized);
   - run the P256 tests with `anvil --network monad` or against a fork of https://testnet-rpc.monad.xyz, because the default EVM has no 0x0100 precompile.
4. Write script/Deploy.s.sol that deploys the three contracts with the Circle USDC address on Monad testnet (0x534b2f3A21130d7a60830c2Df862319e593943A3), writes the addresses to /deployments/monad-testnet.json, and uses explicit gas limits (Monad charges the gas limit).
5. Do NOT broadcast. Print the exact `forge script` command I should run myself with my Foundry keystore account, plus an estimate of the total MON cost at the current base fee (query eth_gasPrice read-only).

Show test output at the end.
```

## Prompt 3: policy contract NEAR e firma MPC (M2)

```
Do milestone M2 from CLAUDE.md (§4 NEAR constants, §6 policy contract spec).

1. Before coding, read the current MPC contract interface (https://github.com/near/mpc/blob/main/crates/contract/README.md) and confirm the sign request shape (path, payload_v2 {Ecdsa}, domain_id 0, 1 yocto deposit, >=10 Tgas). Read the installed chainsig.js type definitions for: address derivation for an arbitrary predecessor account + path, EVM tx preparation (prepareTransactionForSigning or the current equivalent), signature finalization, and broadcast. Summarize what you found in docs/architecture.md before writing code.
2. Implement contracts/near-policy in Rust with near-sdk and cargo-near:
   - owner-managed allowlist of (chain_id, to, selector);
   - per-user weekly cap per token with a rolling 7-day window;
   - request_signature that validates, computes the EIP-1559 signing hash, calls v1.signer-prod.testnet.sign with path "{predecessor},evm,1", attaches 1 yoctoNEAR from the contract balance, and uses a callback that rolls back the spend on failure;
   - NEP-297 events for accept/reject.
   Include unit tests for allow/deny, caps, window rollover and rollback.
3. packages/signer: a TypeScript client that derives the user's EVM address (predecessor = policy contract), builds the tx with viem (explicit gas = estimate*1.1, EIP-1559 fees from the RPC), calls request_signature via near-api-js, finalizes the signed tx and broadcasts it. Add a per-address queue that waits for the receipt before the next tx.
4. scripts/smoke-sign.ts: derive the address, print it, and (after I fund it) send a 0-value self-transfer on Monad testnet through policy→MPC. Print the explorer link.
5. Do NOT deploy or send anything yourself. Print the exact near-cli-rs commands for me to: create the policy account with --useFaucet, deploy, call init, and add the allowlist entries.

Show cargo test + vitest output.
```

## Prompt 4: agente (schema, parser, planner) (M3)

```
Do milestone M3 from CLAUDE.md (§7 intent schema).

1. packages/core: implement the Intent zod schema and export a JSON Schema version for the LLM.
2. Rules parser (no LLM) that handles at least the demo command in Italian ("Porta 2 USDC da Base su Monad, cambiane metà in MON e metti il resto nel vault. Non spendere più di 5 USDC a settimana.") and simple variants (amounts with comma decimals, "metà", "il resto", "massimo X a settimana").
3. apps/web/app/api/parse/route.ts: a server-side route that uses LLM_PROVIDER (gemini | groq | rules). Gemini: use the official SDK or REST with structured output (response JSON schema) and the model from GEMINI_MODEL; check the current SDK API in node_modules before coding. Groq: OpenAI-compatible endpoint with json_schema/json_object, validated with zod. On any error, timeout (>4s) or invalid output, fall back to the rules parser. Only send the user's command text plus the schema to the LLM. Never send keys or addresses.
4. Deterministic planner: Intent → ordered steps with exact bigint amounts (USDC 6 decimals):
   - for the bridge action: approve TokenMessengerV2 + depositForBurn on Base Sepolia (destination domain 15, mintRecipient = user's derived address as bytes32) → wait for attestation → receiveMessage on Monad;
   - then approve PlanExecutor + execute(plan) on Monad.
   Each step carries a human-readable Italian description, the estimated gas and the policy checks it will face.
5. Vitest: the demo command + 9 more commands (including invalid ones and the negative "manda 50 USDC a 0xabc…") with the LLM mocked; snapshot the planner output.

Show test output.
```

## Prompt 5: PWA end-to-end su Monad (M4)

```
Do milestone M4 from CLAUDE.md.

Build the PWA flow in apps/web (Italian UI copy, clean and mobile-first):
1. Onboarding: enter NEAR testnet account id; generate a function-call access key restricted to POLICY_CONTRACT_ID (method request_signature), show me the near-cli-rs command to add it to my account, and store the private key in IndexedDB encrypted with a key derived from a WebAuthn PRF output if the browser supports PRF (otherwise a non-extractable WebCrypto key, with a warning that this is a testnet demo).
2. Passkey registration (WebAuthn, P-256, userVerification required). Extract x,y and call PlanExecutor.registerPasskey through the signer (policy→MPC).
3. Chat input → /api/parse → plan card (steps, amounts, gas, policy checks, "cosa è reale / cosa è mock").
4. "Approva con passkey": WebAuthn assertion over the plan hash (challenge = planHash), convert DER to r,s with low-S, and build the WebAuthnAuth struct for PlanExecutor.
5. Execute the Monad-only part (assume USDC is already on the derived address): approve + execute, one tx at a time, with a live timeline and explorer links (testnet.monadvision.com).
6. Show policy rejections from the NEAR contract as readable Italian errors.
7. Make it deployable on Vercel Hobby (free): list the env vars to set there. Secrets stay server-side.

Test locally on https://localhost (WebAuthn needs a secure context) and tell me exactly what to click to verify the "done when" of M4.
```

## Prompt 6: passo cross-chain CCTP e consegna (M5 → M7)

```
Do milestone M5, then prepare M7 assets.

1. packages/cctp: before coding, read the Circle CCTP V2 docs for the sandbox Iris API (messages + fees endpoints) and confirm the TokenMessengerV2.depositForBurn signature (amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold). Implement: fee query → depositForBurn on Base Sepolia (fast transfer if available, maxFee from the API) → poll attestation with backoff and a visible countdown → MessageTransmitterV2.receiveMessage on Monad testnet. All txs go through packages/signer (policy→MPC).
2. Wire the full demo command into the UI and into scripts/e2e-demo.ts. Add the negative command to the demo and make sure the rejection is visible.
3. Run the acceptance checklist of CLAUDE.md §9 and report each item as pass/fail with evidence (test output, tx hashes).
4. Write docs/demo-script.md (2–3 min video script, scene by scene, in Italian with an English subtitle line), docs/submission.md (short write-up in English: problem, solution, what runs on Monad, what is real vs mock, what was built during the hackathon, next steps with NEAR Intents 1Click on mainnet) and update README with deployed addresses and explorer links.
5. Final safety pass: run gitleaks over the full history and grep for private keys/API keys; confirm no NEXT_PUBLIC_ var contains a secret.

Stretch (only if everything above passes): a read-only 1Click dry quote panel for the Base→Monad route, then a Kuru adapter behind a feature flag after verifying the router address on-chain.
```
