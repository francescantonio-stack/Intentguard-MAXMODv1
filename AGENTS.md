# AGENTS.md — IntentGuard (Monad Metropolis, Track 04)

Read [`docs/CLAUDE.md`](docs/CLAUDE.md) first: it holds the project spec, the hard safety rules (testnet only, no keys in
the repo, LLM keys server-side only) and the milestones. This file adds the current state and the next steps.

## Framing
Monad is the center of the story: `PlanExecutor` on Monad testnet verifies the user's passkey on-chain through the P256
precompile `0x0100` (10,450 gas per `WebAuthn.verify`). NEAR (policy + Chain Signatures) and Circle CCTP are supporting
layers for interoperability and settlement. Keep README, `docs/submission.md` and the deck consistent with this.

## Tooling
- **Foundry v1.8.1** (`foundryup --install v1.8.1`). Plain `foundryup` installs 1.5.x, which ignores
  `network = "monad"`: the P256 precompile is missing and the passkey tests fail.
- Node 22 + pnpm, Rust stable (+ `wasm32-unknown-unknown`, `cargo-near` 0.22 for the sandbox).

## Checks (run before every push)
```bash
cd contracts/evm && forge test                 # 44 passed, 1 skipped (Monad fork, runs with FORK=1)
pnpm install && pnpm -r test                   # 58 passed, 1 skipped (live planHash, runs with LIVE=1)
cd contracts/near-policy && cargo test --lib   # 27 passed
./run-all-checks.sh                            # everything, incl. fork, sandbox and read-only live checks
```
CI (`.github/workflows/ci.yml`) runs on `main`, on pull requests and on manual dispatch; last run green.
If a test count changes, update README.md, README.it.md, docs/submission.md and the deck (page 10).

## State (10 Oct 2026)
- Contracts deployed and verified on Monad testnet; addresses and tx hashes in `deployments/`.
- Real end-to-end run done headless (`scripts/cctp-base-to-monad.mjs --execute`).
- Real phone passkey vector in `contracts/evm/test/fixtures/browser_vector.json` (generated with
  `contracts/evm/tools/make-vector.html`).
- Repo public; gitleaks clean on the full history.

## Next steps (deadline: 13 Oct 2026)
1. Deploy the PWA (`apps/web`) on Vercel: import the repo, Root Directory `apps/web`, env vars from `.env.example`
   (LLM key optional: the rules parser is the fallback). HTTPS is required for real passkeys.
   The repo is deploy-ready (`apps/web/vercel.json`, monorepo tracing, rpId from the request host). The Vercel
   account connection is still a manual step.
2. One full run from the PWA with a real phone passkey (M4/M5 in `docs/CLAUDE.md`).
3. Record the 2-minute video following `docs/submission.md` ("Demo video").
4. Submit on the platform: team, Track 04, bounties (Mera, Aurora Intents, MetaMask), repo, video, deck, CI link.
5. Rename the default branch to `main`.
6. Optional: upgrade the deployed NEAR policy with the CCTP `maxFee` cap (`docs/CHIAVI.md` §5, needs the owner's keys).
