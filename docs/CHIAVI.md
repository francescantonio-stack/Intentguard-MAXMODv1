# Le sole cose da incollare (e i pochi clic)

Tutto il resto ha valori di default per la testnet. Nessuna chiave privata va mai nel repo o in chat.

## 1. GitHub: agenti (Settings → Secrets and variables → Actions → New repository secret)

| Secret | Da dove | Serve a |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | sul tuo PC: `claude setup-token` (usa il tuo abbonamento Claude) | far lavorare gli agenti (`.github/workflows/agents.yml`) |

In alternativa a quello: `ANTHROPIC_API_KEY` (a consumo). Basta uno dei due.
Facoltativo: variabile `AGENT_CLAUDE_ARGS` (es. un modello diverso per gli agenti).

## 2. Vercel: la PWA (Project → Settings → Environment Variables)

Import del progetto (una volta): New Project → importa il repo → **Framework Next.js**, **Root Directory `apps/web`**, **Node 22.x**. Install/build sono già in `apps/web/vercel.json` (`pnpm install --frozen-lockfile --filter @intentguard/web...` / `pnpm build`). Elenco completo e default testnet: [`.env.example`](../.env.example). Sezioni README: [EN](../README.md#deploy-on-vercel) · [IT](../README.it.md#deploy-della-pwa-su-vercel).

| Variabile | Dove | Da dove | Obbligatoria? |
|---|---|---|---|
| `NEXT_PUBLIC_POLICY_CONTRACT_ID` | Pubblica | default `intentguard-973f6c.testnet` | no |
| `NEXT_PUBLIC_RP_ID` | Pubblica | lascia vuoto (usa l'host della pagina) | no |
| `NEXT_PUBLIC_APP_URL` | Pubblica | solo se hai un dominio custom | no |
| `GEMINI_API_KEY` | Solo server | aistudio.google.com → Get API key (gratis, senza carta; restringila alla Gemini API) | no: senza chiave l'app usa il parser deterministico |
| `GROQ_API_KEY` | Solo server | console.groq.com (riserva) | no |
| `LLM_PROVIDER` | Solo server | `rules` / `gemini` / `groq` | no |
| `MONAD_RPC_URL` / `BASE_SEPOLIA_RPC_URL` / `NEAR_RPC_URL` / `CIRCLE_IRIS_API_URL` | Solo server | default testnet in `.env.example` | no |

Nessuna chiave privata (`NEAR_PRIVATE_KEY`, `DEPLOYER_*`) e nessun segreto in `NEXT_PUBLIC_*`.

## 3. Sul telefono: la tua passkey e il tuo account

Apri l'URL Vercel → **Setup**. L'app genera la chiave del dispositivo e ti mostra i 3 comandi `near` già compilati (account, tetto 5 USDC, indirizzo derivato): copiali nel terminale dove hai `near-cli-rs` e le tue credenziali testnet. Poi «Create passkey», faucet, «Register on Monad».

## 4. Clic su GitHub (non sono chiavi)

1. Settings → Rules → Rulesets → New branch ruleset su `main`: «Require status checks» con i 4 job di CI (`ts (core, signer, mcp, web)`, `evm (forge test)`, `near (cargo test)`, `secrets (gitleaks, full history)`) e «Automatically request Copilot code review».
2. Le etichette `agente:architetto|contratti|auditor|frontend|deploy` si creano da sole al primo uso.

## 5. Aggiornare la policy NEAR (tetto sulla fee CCTP, una volta, dopo il merge)

Sul PC con le credenziali di `intentguard-973f6c.testnet` (lo stato resta, non serve migrazione):
```bash
cd contracts/near-policy && cargo near build non-reproducible-wasm
near contract deploy intentguard-973f6c.testnet use-file target/near/intentguard_policy.wasm without-init-call network-config testnet sign-with-legacy-keychain send
```

## 6. Agenti AI esterni (MCP): nessuna chiave

```bash
claude mcp add intentguard -e NEAR_USER=<tuo>.testnet -e APP_URL=<url vercel> -- npx tsx <percorso repo>/packages/mcp/src/server.ts
```
