# IntentGuard SUPPOMOD v1 — riepilogo (snapshot del 7/10/2026)

Copia completa (con tutta la cronologia) del lavoro per **Monad Metropolis, Traccia 04**, presa dal ramo
`claude/epic-lamport-iete98` di `francescantonio-stack/Intentguard` (PR n. 1, CI verde). Solo testnet.

## Decisioni prese
- **Organizzazione degli agenti:** catena di montaggio (specifiche → contratti → audit → frontend → deploy) con audit
  **avversariale** (un agente costruisce, uno attacca con test di exploit). GitHub fa da bacheca: le etichette
  `agente:<ruolo>` avviano gli agenti (`.github/workflows/agents.yml`, ruoli in `.claude/agents/`), l'auditor si ferma
  dopo 3 giri (`serve-umano`). La **CI è il giudice**, Copilot è il secondo revisore.
- **Per distinguerci:** server MCP per qualsiasi agente AI (senza chiavi), demo "agente hackerato" fermato tre volte
  (planner, policy NEAR, PlanExecutor), registro live delle decisioni, test di invarianti, numeri Monad (~10,5k gas per
  la verifica della passkey).

## Cosa contiene
| Parte | Percorso |
|---|---|
| Contratti Monad (PlanExecutor, MiniSwap, DemoVault) + test, invarianti, vettori WebAuthn | `contracts/evm/` |
| Policy NEAR (allowlist, tetti, piani, tetto fee CCTP 0,5%) | `contracts/near-policy/` |
| Schema intento, parser, planner, planHash, WebAuthn | `packages/core/` |
| Client policy NEAR, firma MPC, CCTP, esecuzione piani, guard log | `packages/signer/` |
| Server MCP per agenti AI | `packages/mcp/` |
| PWA di riferimento (setup, approvazione con passkey, guard log, attack demo) | `apps/web/` |
| Script originali e verifiche live | `scripts/` |
| Indirizzi e transazioni testnet | `deployments/` |
| Piano, chiavi da incollare, copione video, write-up per i giudici | `docs/piano.md`, `docs/CHIAVI.md`, `docs/demo-script.md`, `docs/submission.md` |

Test: Foundry 43 passati, TypeScript 58 passati, Rust (policy) verdi in CI, gitleaks pulito.

## Cosa manca (fino alla consegna del 13/10, 14/10 ora di Roma)
1. Secret `CLAUDE_CODE_OAUTH_TOKEN`, progetto Vercel con Root Directory `apps/web` (+ `GEMINI_API_KEY` facoltativa),
   ruleset su `main` (vedi `docs/CHIAVI.md`).
2. Ridistribuire la policy NEAR aggiornata (tetto fee CCTP): `docs/CHIAVI.md` §5.
3. Nuovo utente demo con la passkey del telefono (Setup nella PWA) e faucet: MON (faucet.monad.xyz),
   USDC su Base Sepolia (faucet.circle.com), ETH su Base Sepolia (faucet CDP).
4. Prova reale dal telefono + 3 esecuzioni pulite di fila.
5. Consegna: team sulla piattaforma, video ≤ 3 min, profilo con traccia 04 e bounty, repo pubblico alla consegna.
