# Monad Metropolis: piano del prototipo

*Redatto sabato 3/10/2026 (ora di Roma). Le fonti sono state controllate oggi; [DA VERIFICARE] indica un fatto che non ho potuto confermare da fonte ufficiale o senza login.*

---

## 1. Regole dell'hackathon (sintesi verificata)

| Voce | Cosa risulta | Fonte |
|---|---|---|
| Formato | Online, globale. Si partecipa da soli o in team | monad.xyz/metropolis (FAQ) |
| Iscrizione | **Aperta**. La piattaforma indica "Intake · Open 1 Sep to 13 Oct". Si accede con GitHub, Google o Discord; ogni provider crea un account separato | https://hackathon.monad.xyz |
| **Deadline di consegna** | L'header della piattaforma mostra **"Oct 14 · 03:59 UTC"**; l'app dichiara "UTC (official event time)". In ora di Roma (CEST, UTC+2): **mercoledì 14/10/2026 alle 05:59**, cioè martedì 13/10 alle 23:59 ora di New York. L'etichetta compare in un tooltip, quindi dopo il login conviene controllare che sia la "Submission deadline" | hackathon.monad.xyz/projects |
| Obiettivo pratico | **Consegnare entro la sera di lunedì 12/10.** Martedì 13/10 resta come buffer | |
| Giudizio / risultati | Giudizio dal 14 al 27/10; vincitori annunciati il 3/11 | monad.xyz/metropolis |
| Cosa si consegna | "A working product with a public project profile: a demo, a short write-up, and a link to the code". Dopo la chiusura i progetti diventano pubblici | FAQ + piattaforma |
| Open source | Incoraggiato ma non obbligatorio. I giudici devono però poter verificare cosa è stato costruito nelle 6 settimane: il repo pubblico con lo storico dei commit serve a questo | FAQ |
| Regola "lavoro nuovo" | Sono ammessi progetti esistenti, ma "what you show on 13 Oct should have been built during the six weeks" (dall'1/09). I nostri documenti di architettura vanno bene; il codice nasce adesso | FAQ |
| Tracce | 4 tracce, ciascuna da $30.000 divisi fra 3 team ($10.000 a team). Grand Champion da $25.000 scelto fra tutte le tracce. In più ci sono i bounty degli sponsor | monad.xyz/metropolis |
| Durata del video, deck, criteri di giudizio | **Non pubblicati** sulla pagina pubblica. Le regole ufficiali sono sulla piattaforma, dietro login [DA VERIFICARE dopo l'iscrizione] | |
| Idoneità (Italia, KYC per i premi) | "Eligibility restrictions are listed in the official rules on the application platform" [DA VERIFICARE dopo l'iscrizione] | monad.xyz/metropolis |
| Deploy su Monad | La pagina non dice esplicitamente se basta la testnet o serve la mainnet. L'header della piattaforma mostra "Chain ID 143" (mainnet), ma sembra un elemento grafico. Noi usiamo la testnet (chain 10143) [DA VERIFICARE nelle regole] | |

### Registrazione: è gratuita?
- Né la pagina pubblica né il codice della piattaforma menzionano quote, pagamenti o checkout. Il login usa account gratuiti (GitHub, Google, Discord).
- L'unica cifra trovata è "$50" su un evento Luma: si tratta di un'attivazione fisica facoltativa (Singapore, 6/10), non serve.
- **Conclusione: risulta gratuita**, ma non ho visto le regole ufficiali dietro login [DA VERIFICARE leggendo i termini al momento dell'iscrizione]. Se compare una qualsiasi richiesta di pagamento o di wallet/seed, fermarsi: la piattaforma stessa avverte che il team "will never request your wallet's private key or seed phrase".

### Traccia scelta
**04: Trust, Identity & AI Infrastructure.** Fra gli esempi della traccia ci sono "Passkey-native accounts using P256 and WebAuthn, with no seed phrase" e l'identità degli agenti. Il nostro punto forte è proprio l'agente AI con guardrail su due livelli: policy su NEAR e approvazione con passkey verificata on-chain su Monad tramite il precompile P256.

Bounty compatibili, da selezionare se la piattaforma lo consente [DA VERIFICARE i requisiti di ciascuno sulla piattaforma]:
- "Best Agent Wallet Plugin" ($2.500)
- "Mera: One Passkey, Many Keys" ($2.500)
- "Bring Any-Chain Liquidity to Monad" ($5.000; giudice/sponsor probabile Aurora Intents [DA VERIFICARE])
- Kuru ($5.000), solo se si completa lo stretch goal

---

## 2. La demo

**Comando (in italiano, nella chat della PWA):**
> "Porta 2 USDC da Base su Monad, cambiane metà in MON e metti il resto nel vault. Non spendere più di 5 USDC a settimana."

**Cosa vede il giudice, passo per passo:**
1. **Account.** Account NEAR testnet + passkey del dispositivo. Nessuna seed phrase per l'utente. L'indirizzo EVM è **unico e uguale** su Base Sepolia e Monad testnet, ed è derivato con NEAR Chain Signatures.
2. **Parsing.** L'agente AI trasforma il testo in un intento JSON validato da uno schema. Se l'LLM non risponde, entra in gioco un parser deterministico di riserva, così la demo non dipende dall'LLM.
3. **Piano.** Il planner, deterministico, mostra il piano: (a) burn USDC su Base Sepolia via **Circle CCTP V2**, (b) mint su Monad, (c) swap di 1 USDC→MON, (d) deposito di 1 USDC nel vault ERC-4626. Per ogni passo indica costi gas stimati, limiti di policy e rischi.
4. **Approvazione.** Una sola conferma con passkey (WebAuthn) sull'hash del piano.
5. **Firma.** Ogni transazione EVM passa dal **policy contract su NEAR** (allowlist di contratti/funzioni, tetto settimanale), che chiama l'MPC `v1.signer-prod.testnet`.
6. **Su Monad.** Il contratto `PlanExecutor` **verifica on-chain la firma passkey** con il precompile P256 (`0x0100`) e solo dopo esegue swap e deposito in modo atomico.
7. **Test negativo.** "Manda 50 USDC a 0xabc…" viene rifiutato dalla policy (tetto superato, destinatario non in allowlist) e il rifiuto si vede in UI.
8. **Opzionale.** Accanto al passo cross-chain la UI mostra la quote reale di **NEAR Intents 1Click** (`dry: true`, nessun fondo) sulla rotta mainnet Base→Monad, con la nota "in produzione questo passo passa da NEAR Intents".

**Perché CCTP e non un bridge mock:** Circle CCTP V2 è attivo e gratuito in testnet fra Base Sepolia (dominio 6) e Monad Testnet (dominio 15), con gli stessi contratti su entrambe: TokenMessengerV2 `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`, MessageTransmitterV2 `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`. Gli USDC di test sono gratuiti dal faucet Circle. Il passo cross-chain diventa così **reale**, non simulato. 1Click invece non ha testnet: rimane come quote dimostrativa.

**Perché il DEX è nostro (MiniSwap) e Kuru è uno stretch goal:** il mercato MON/USDC di Kuru in testnet esiste. Oggi ho letto `bestBidAsk`: c'è un ask a ~1,001 USDC/MON e non risultano bid. Però usa un USDC di test (`0x3bA3…1570`) che non è mintabile pubblicamente e che è diverso dall'USDC Circle (`0x534b…43A3`). In più la doc di Kuru e il registry di Monad riportano indirizzi del router diversi [DA VERIFICARE]. Per avere una demo affidabile lo swap passa quindi da un nostro pool constant-product minimale (USDC Circle / MON) con liquidità messa da noi. Lo dichiariamo apertamente nel write-up.

### Dentro lo scope
- PWA Next.js (installabile, chat, scheda piano, timeline di esecuzione con link agli explorer).
- Passkey: registrazione e approvazione del piano.
- Account NEAR testnet e chiave function-call limitata al policy contract.
- Policy contract NEAR (Rust): allowlist per chain/contratto/selettore, tetto settimanale per token, registro degli hash di piano.
- Firma tramite MPC.
- Contratti su Monad testnet: `MiniSwap`, `DemoVault` (ERC-4626), `PlanExecutor` (WebAuthn/P256).
- CCTP V2 da Base Sepolia a Monad testnet.
- Parser LLM con JSON schema più fallback deterministico.
- Test negativo della policy.
- README, video, write-up.

### Fuori scope
- Mainnet di qualsiasi tipo, 1Click reale e fondi reali.
- Arbitrum, Zora, Solana, Robinhood Chain.
- Take-profit e ordini condizionali, Telegram, APK Capacitor.
- EIP-7702 su Monad: con la delega l'account non può scendere sotto la riserva di 10 MON.
- Verifica P256 dentro il contratto NEAR.
- Recovery dell'account.

### Stretch goal (solo con il core finito)
1. Adapter Kuru (calldata `placeAndExecuteMarketBuy` dall'SDK) per il bounty Kuru.
2. Quote 1Click `dry` nella UI.
3. Login tramite wallet NEAR (Near Connect) al posto della chiave importata.

---

## 3. Milestone (in ordine; gli intervalli di giorni sono indicativi)

I "giorni" sono giorni di lavoro part-time contati da oggi, non date fisse. Se si va più veloci si passa alla milestone successiva. **Conta il criterio "fatto".**

| # | Milestone | Indicativo | Fatto quando… |
|---|---|---|---|
| M0 | Setup e account (vedi §5, "cosa fa Max") | giorno 1 | Max è iscritto con la traccia 04. Il repo GitHub pubblico esiste con il primo commit. Hai: un account NEAR testnet, un EOA di sviluppo solo testnet con MON + ETH Base Sepolia, USDC di test su Base Sepolia, una chiave LLM gratuita. `.env.local` compilato e **non** committato |
| M1 | Contratti EVM (Foundry) | giorni 1–3 | `forge test` passa con `network = "monad"`, compreso un test che verifica una firma WebAuthn reale (vettore fisso) tramite il precompile `0x0100`. `MiniSwap`, `DemoVault`, `PlanExecutor` sono deployati su Monad testnet e gli indirizzi sono in `deployments/monad-testnet.json` |
| M2 | Policy contract NEAR e firma MPC | giorni 2–4 | `cargo test` passa (allowlist, tetto settimanale, rifiuti). Il contratto è deployato su testnet. Uno script deriva l'indirizzo EVM, chiede la firma via policy→MPC e trasmette una tx da 0 MON su Monad testnet; l'hash è visibile su monadvision |
| M3 | Agente: schema, parser, planner | giorni 3–5 | Il comando della demo e altri 9 comandi di test producono intenti validi (unit test). Il parser di riserva copre il comando della demo. Il planner genera i passi con importi esatti (6 decimali USDC) |
| M4 | PWA end-to-end su Monad | giorni 4–7 | Dal browser: login, registrazione passkey, comando, piano, approvazione con passkey, swap e deposito su Monad eseguiti, timeline con link agli explorer. Funziona da URL HTTPS (Vercel) e da telefono |
| M5 | Passo cross-chain CCTP | giorni 5–8 | Il comando completo porta USDC da Base Sepolia a Monad (burn, attestazione Iris sandbox, `receiveMessage`) e prosegue con swap e deposito in un unico flusso. Il test negativo viene rifiutato e mostrato in UI |
| M6 | Rifinitura e stretch | giorni 7–9 | Tre esecuzioni consecutive senza errori. Stati di errore leggibili. Gli stretch vanno fatti solo se M5 è chiusa |
| M7 | Consegna | giorni 8–9 | Fatti README, video, write-up, eventuale deck, profilo del progetto con traccia e bounty. **Consegnato entro la sera di lunedì 12/10.** Martedì 13/10 rimane buffer (e la deadline ufficiale è il 14/10 alle 05:59 ora di Roma) |

**Regola di taglio:** se a metà percorso M5 è a rischio, si consegna M4 (tutto su Monad), con CCTP indicato come "next" e la quote 1Click mostrata in UI. La storia per la traccia 04, cioè passkey + policy + agente, regge anche senza il passo cross-chain.

---

## 4. Budget essenziale (solo costi inevitabili)

**Totale previsto di spesa nuova: 0 €**, a condizione che i faucet gratuiti diano abbastanza MON (vedi rischio R1).

| Voce | Costo | Note verificate |
|---|---|---|
| Iscrizione a Metropolis | 0 € | Nessuna quota indicata. Login con GitHub, Google o Discord [DA VERIFICARE nei termini dietro login] |
| Claude Code | già sostenuto | Max lo usa già. Non serve un piano superiore |
| Account NEAR testnet | 0 € | `near create-account <nome>.testnet --useFaucet` (near-cli-rs): il faucet copre la creazione, "testnet only". Nessun prerequisito |
| Firma MPC (Chain Signatures) | ~0 | Il contratto MPC richiede **1 yoctoNEAR** di deposito (l'eccesso è rimborsato) e ≥10 Tgas, pagati con NEAR di testnet. Il deploy del policy contract richiede qualche NEAR testnet per lo storage, che dà il faucet [DA VERIFICARE quanto accredita il faucet per account] |
| MON testnet | 0 € | Faucet ufficiale https://faucet.monad.xyz: si collega il wallet; X e Discord sono **facoltativi** e alzano il limite. La pagina ufficiale non richiede saldi in mainnet (la pagina live è dietro un controllo anti-bot, quindi non ho visto le soglie esatte) [DA VERIFICARE]. Fonti secondarie indicano quantità molto basse (~0,05 MON) senza Discord o saldo in mainnet. **Il faucet Alchemy invece richiede ≥0,001 ETH su Ethereum mainnet + attività: da evitare** |
| ETH Base Sepolia | 0 € | Faucet CDP di Coinbase: 0,0001 ETH per richiesta, fino a 1.000 richieste ogni 24h. Serve un **account CDP gratuito**. Il gas su Base Sepolia oggi è ~0,006 gwei, quindi ne basta pochissimo. QuickNode supporta Base Sepolia [DA VERIFICARE prerequisiti] |
| USDC di test (Base Sepolia, Monad testnet) | 0 € | Faucet Circle https://faucet.circle.com: pubblico, senza account. Supporta Base Sepolia e Monad Testnet [DA VERIFICARE quantità per richiesta] |
| ETH Arbitrum Sepolia | 0 € (non serve) | Fuori scope. Per info: QuickNode dichiara di non richiedere saldi in mainnet [fonte secondaria, DA VERIFICARE]; Alchemy richiede 0,001 ETH in mainnet; l2faucet.com usa l'attestazione del dispositivo |
| LLM per il parser | 0 € | Gemini API free tier (disponibile in Italia, senza carta) oppure Groq free (vedi sotto) |
| Hosting PWA | 0 € | Vercel Hobby (sottodominio vercel.app con HTTPS, necessario per passkey e PWA). Non serve un dominio |
| RPC | 0 € | RPC pubbliche: `testnet-rpc.monad.xyz` (50 rps), `sepolia.base.org`, `rpc.testnet.near.org` o equivalenti. In più i crediti gratuiti per partecipanti (QuickNode 3 mesi, ecc.) |
| Video e deck | 0 € | OBS / registrazione schermo del sistema; Google Slides |

**Spesa da NON fare:** ETH in mainnet per sbloccare faucet (salvo l'ultima risorsa di R1), 1Click in mainnet, dominio, piani LLM a pagamento, eventi fisici Luma, piani RPC a pagamento.

**Unica spesa eventuale (ultima risorsa):** se senza Discord i faucet danno troppo poco MON, alcune fonti secondarie indicano che il faucet ufficiale dà di più a wallet con ≥0,01 ETH in mainnet e almeno una tx in uscita [DA VERIFICARE]. Prima vanno provate tutte le vie gratuite (vedi R1).

**Quanti MON servono davvero.** Misurato oggi: base fee su Monad testnet 100 gwei; Monad addebita il gas **sul gas limit**, non sul gas usato.
- Una tx da 200k gas limit costa circa 0,02 MON.
- Deploy dei 3 contratti: circa 0,3–0,6 MON.
- Ogni esecuzione della demo (5–6 tx): circa 0,07 MON.
- Liquidità iniziale di MiniSwap: circa 1 MON.
- **Totale stimato per tutto l'hackathon: circa 2–3 MON.** Stima con ampio margine di errore; dipende dai gas limit reali.

### LLM gratuito per il parser (verificato)

| Opzione | Modello consigliato | Limiti | Note |
|---|---|---|---|
| **Gemini API free tier** (scelta primaria) | `gemini-3.5-flash-lite`: free tier "Free of charge" per input e output | Google **non pubblica più** RPM/RPD nella documentazione: si vedono in AI Studio per progetto [DA VERIFICARE in AI Studio]. Le quote sono per progetto, non per chiave; l'RPD si azzera a mezzanotte del Pacifico (09:00 ora di Roma) | Italia fra le regioni supportate. **Nel free tier i contenuti possono essere usati da Google per migliorare i prodotti**: inviare solo il testo del comando, mai chiavi o dati personali. I modelli 2.5 sono ora riservati a chi li usava già: un progetto nuovo deve usare la serie 3.x. Un forum Google segnala che dal 19/06/2026 non si accettano chiavi API "unrestricted": restringere la chiave all'API Gemini [DA VERIFICARE]. Output strutturato con JSON schema supportato (verificato sulla scheda di 2.5 Flash; per 3.5 Flash-Lite [DA VERIFICARE]) |
| **Groq** (riserva) | `openai/gpt-oss-20b` | Dalla doc ufficiale: 30 RPM, 1.000 RPD, 8.000 TPM, 200.000 TPD. La pagina non chiarisce se sono i limiti del piano gratuito; i limiti esatti dell'organizzazione sono nella console [DA VERIFICARE] | Molto veloce. Supporto a `json_schema` [DA VERIFICARE per il modello] |
| **Parser deterministico** (sempre attivo) | regex + regole | nessuno | Copre il comando della demo, così video e giudici non dipendono dall'LLM |

Per una demo servono poche decine di richieste al giorno: entrambi i free tier bastano con ampio margine.

---

## 5. Cosa deve fare Max di persona (non delegabile a Claude Code)
1. **Iscriversi** su https://hackathon.monad.xyz con GitHub, che conviene perché serve anche per il repo. Scegliere la **traccia 04** e leggere i termini ufficiali: gratuità, idoneità Italia/KYC, durata del video, deck, criteri, testnet ammessa.
2. Creare il **repo GitHub pubblico** (es. `intent-guard-monad`).
3. Generare un **EOA di sviluppo solo testnet** (`cast wallet new`) per i deploy. La chiave va solo in `.env.local` / keystore Foundry, mai in git e mai in chat.
4. Creare l'**account NEAR testnet** con near-cli-rs (`--useFaucet`) per sé e uno per il policy contract.
5. Usare i **faucet**:
   - MON: faucet ufficiale, collegando Discord/X se serve più MON; eventualmente ottenere il ruolo sul Discord di Monad;
   - USDC: Circle (Base Sepolia + Monad);
   - ETH Base Sepolia: CDP, con account gratuito.
6. Creare la **chiave API Gemini** in AI Studio (gratis, nessuna carta) ed eventualmente quella Groq.
7. Creare un account **Vercel** gratuito, collegato a GitHub.
8. Registrare il **video** e compilare il **form di consegna**.

---

## 6. Checklist di consegna
- [ ] Repo pubblico con licenza MIT, README (cosa fa, architettura, come eseguirlo, indirizzi deployati, cosa è mock e cosa è reale), storico dei commit dal 3/10 in poi.
- [ ] Indirizzi dei contratti su Monad testnet con link a monadvision/monadscan; hash di una tx demo per ogni passo.
- [ ] Demo live su URL Vercel, con istruzioni per i giudici (account di test o video se l'onboarding è troppo lungo).
- [ ] Video: durata secondo le regole [DA VERIFICARE]; se non specificata, 2–3 minuti. Struttura: problema (15s), comando (15s), piano + passkey (30s), esecuzione con explorer (60s), test negativo (20s), architettura (20s).
- [ ] Write-up breve: problema, soluzione, uso di Monad (P256 precompile, contratti, CCTP), cosa è nato nelle 6 settimane, prossimi passi (1Click in mainnet).
- [ ] Deck (se richiesto [DA VERIFICARE]): 5–7 slide.
- [ ] Profilo del progetto sulla piattaforma: traccia 04 + bounty selezionati; consegnato **entro la sera del 12/10**.
- [ ] Ricontrollo finale: nessuna chiave privata o API key nel repo (`git log -p | grep -i key`; gitleaks).

---

## 7. Rischi e contromisure

| # | Rischio | Contromisura |
|---|---|---|
| R1 | **Pochi MON dal faucet** senza Discord o saldo in mainnet | Collegare Discord e X al faucet (gratis). Chiedere il ruolo sul Discord di Monad. Provare il faucet QuickNode, che elenca Monad [DA VERIFICARE prerequisiti], e OpenBuild, che si basa sul rank GitHub. Chiedere al supporto dell'hackathon dalla piattaforma. Testare tutto su `anvil --fork-url` (gratis) e fare su testnet solo i deploy finali. Gas limit stretti |
| R2 | Latenza o indisponibilità dell'MPC in testnet (firma in alcuni secondi) | Firmare in sequenza con UI di attesa. Retry idempotente (richieste duplicate vengono messe in coda e ricevono la stessa risposta). Video registrato quando la rete è stabile |
| R3 | Tempi di attestazione CCTP da Base Sepolia | Fast Transfer (`minFinalityThreshold` 1000) con `maxFee` dalla API fee. In alternativa un video con un taglio dichiarato. Regola di taglio §3 |
| R4 | La firma WebAuthn non verifica on-chain (DER→r,s, low-S, formato clientDataJSON) | Usare `WebAuthn.sol` di Solady (usa il precompile all'indirizzo 0x100, lo stesso di Monad) e un test con un vettore reale registrato dal browser |
| R5 | Insidie di Monad: gas addebitato sul limit; riserva di 10 MON per gli account delegati; nonce | Niente EIP-7702. Stima del gas +10% e limit esplicito. Una tx per volta per indirizzo, aspettando la receipt |
| R6 | Limiti o modifiche del free tier LLM | Parser deterministico sempre attivo; Groq come seconda opzione |
| R7 | Regole non viste (testnet ammessa? video? KYC?) | Leggerle subito dopo l'iscrizione (M0) e aggiornare questo file |
| R8 | Tempo part-time | Regola di taglio; stretch goal solo dopo M5 |

---

## 8. Link
- Hackathon: https://monad.xyz/metropolis · piattaforma: https://hackathon.monad.xyz · Luma: https://luma.com/monad-metropolis
- Monad testnet: https://docs.monad.xyz/developer-essentials/testnets · differenze da Ethereum: https://docs.monad.xyz/developer-essentials/differences · faucet: https://faucet.monad.xyz · explorer: https://testnet.monadvision.com
- Registry dei protocolli in testnet: https://github.com/monad-crypto/protocols/tree/main/testnet
- NEAR Chain Signatures: https://docs.near.org/chain-abstraction/chain-signatures/implementation · contratto MPC: https://github.com/near/mpc/blob/main/crates/contract/README.md
- near-cli-rs: https://docs.near.org/tools/cli
- Circle CCTP (indirizzi e domini): https://developers.circle.com/cctp/references/contract-addresses · faucet: https://faucet.circle.com
- Faucet CDP: https://docs.cdp.coinbase.com/faucets/introduction/welcome
- Gemini: https://ai.google.dev/gemini-api/docs/pricing · https://ai.google.dev/gemini-api/docs/rate-limits · Groq: https://console.groq.com/docs/rate-limits
- Solady WebAuthn/P256: https://github.com/Vectorized/solady/tree/main/src/utils
