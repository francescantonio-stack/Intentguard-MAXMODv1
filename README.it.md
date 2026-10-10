# IntentGuard: codice del prototipo (Monad Metropolis, solo testnet)

*Versione italiana (note di lavoro dettagliate). The judge-facing English README is [README.md](README.md).*

*Stato al 3/10/2026 (ora di Roma). Solo testnet: NEAR testnet e Monad testnet (chain 10143). Nessun fondo reale, nessuna chiave nel repo. Le chiavi di test stanno solo sulla macchina locale, fuori dal repo.*

Layout del repo: codice nella radice, documenti di progetto in `docs/` (`piano.md`, `CLAUDE.md`, `prompts.md`), prototipo dell'interfaccia in `app-demo/intentguard.html`.

## Cosa c'è

| Parte | Percorso | Stato |
|---|---|---|
| **MiniSwap**: pool x·y=k USDC/WMON con fee 0,30% e quote LP interne | `contracts/evm/src/MiniSwap.sol` | completo e testato |
| **DemoVault**: vault ERC-4626 **mock** su USDC (nessuna strategia, offset anti-inflation) | `contracts/evm/src/DemoVault.sol` | completo e testato |
| **PlanExecutor**: verifica della passkey (WebAuthn P-256 via Solady → precompile `0x0100`), hash del piano legato a chain e contratto, nonce + `executed[hash]` contro il replay, scadenza, tetto settimanale on-chain, tetto per piano, swap + deposito atomici, MON nativo opzionale, rotazione passkey e cambio del tetto solo con la passkey | `contracts/evm/src/PlanExecutor.sol` | completo e testato |
| Script di deploy (accetta solo la chain 10143) | `contracts/evm/script/Deploy.s.sol` | provato su fork locale |
| **Policy contract NEAR** (Rust, near-sdk 5.29) | `contracts/near-policy/` | completo, con test unitari e sandbox |
| Contratto MPC finto, solo per la sandbox locale (**mai** su testnet) | `contracts/mock-mpc/` | usato dal test sandbox |
| Verifiche live in sola lettura | `scripts/live-checks/` | tutte superate |
| Pagina che genera un vettore WebAuthn con la **tua** passkey | `contracts/evm/tools/make-vector.html` | pronta, da usare |

**Il policy contract NEAR in breve.** Gli indirizzi EVM vengono derivati da *questo* contratto + il path `"<utente>,evm,1"`. Quindi l'unico modo di ottenere una firma è passare dai suoi controlli:
- allowlist per (chain, contratto, selettore), con controllo degli argomenti:
  - `approve` solo verso uno spender ammesso e mai illimitato;
  - CCTP `depositForBurn` solo verso il dominio 15, con token USDC e destinatario in allowlist;
  - `PlanExecutor.execute` solo per un indirizzo dell'utente;
- **commit del piano**, che consuma il tetto settimanale "rolling";
- budget per piano, scadenza, numero massimo di firme;
- limiti di gas e fee (su Monad si paga il gas *limit*);
- solo chain 10143 e 84532.

Alzare il tetto o aggiungere destinatari richiede **1 yoctoNEAR**: lo può fare solo la chiave full-access (il wallet), non la chiave function-call della PWA. Infine il contratto chiama `sign` sull'MPC (`payload_v2.Ecdsa`, `domain_id` 0, 1 yocto) con una callback che restituisce lo slot di firma se l'MPC fallisce. Gli eventi sono NEP-297.

## Risultati dei test (rieseguiti il 10/10/2026)

| Suite | Risultato |
|---|---|
| `forge test` (unit + fuzz da 512 run + 5 invarianti + vettori indipendenti, incluso quello Chromium) | **43 passati, 0 falliti**, 2 saltati (fork disattivato di default; vettore "browser" in attesa del tuo file) |
| `forge test --match-contract MonadGas -vv` (gas di `WebAuthn.verify` con il precompile P256 di Monad) | **10.450 gas** |
| `FORK=1 forge test --match-contract MonadFork` (fork locale di Monad testnet con USDC Circle e WMON reali) | **2 passati, 0 falliti** (ultima esecuzione 3/10/2026: serve l'RPC di Monad) |
| `pnpm -r test` (pacchetti TypeScript core, signer, MCP) | **58 passati, 0 falliti**, 1 saltato (controllo live di `planHash`, si attiva con `LIVE=1`) |
| `cargo test --lib` (policy NEAR) | **27 passati, 0 falliti** |
| `cargo test --test sandbox -- --ignored` (sandbox NEAR locale: policy → MPC finto → callback) | **1 passato, 0 falliti** (ultima esecuzione 3/10/2026) |

Test negativi richiesti, tutti verdi:
- **Lato EVM**:
  - passkey non autorizzata (`test_revert_unauthorizedPasskey`, più un fuzz su chiavi casuali);
  - piano oltre il tetto settimanale (`test_revert_overWeeklyCap_*`, più un fuzz);
  - piano oltre il tetto per piano, piano manomesso dopo la firma, replay, nonce errato, scadenza;
  - firma high-S, flag UV assente, tipo `webauthn.create`, replay su un altro deployment.
- **Lato NEAR**:
  - "manda 50 USDC a 0xabc…" respinto (`negative_demo_send_50_usdc_to_stranger`);
  - target o selettore fuori allowlist, chain mainnet, approve illimitato, CCTP verso un altro destinatario/dominio/token;
  - fee drain, piano scaduto o esaurito, aggiunta di un destinatario senza deposito, owner che prova ad autorizzare la mainnet.

Gas misurato sul fork di Monad: `execute` (swap + unwrap + deposito) **≈ 567.000 gas**. Deploy dei 3 contratti **≈ 4,53 M gas**; forge stima che serva un saldo di **≈ 0,92 MON** (con max fee 203 gwei; il costo effettivo a 100–103 gwei è circa la metà).

## Verifiche live (sola lettura, RPC pubbliche)

| Verifica | Esito |
|---|---|
| Chain ID Monad testnet / Base Sepolia | **10143** / **84532** ✔ |
| **Precompile P256 `0x0100` su Monad testnet** (eth_call con un vettore valido) | restituisce `…01` ✔; con firma alterata restituisce `0x` (vuoto, come da EIP-7951/RIP-7212) ✔. Stesso esito su Base Sepolia |
| **WebAuthn completo eseguito sul nodo Monad reale** (creation code di `WebAuthnProbe` via eth_call, senza deploy) | `hasPrecompile=true`, `webauthnValid=true`, `tamperedValid=false` ✔ |
| CCTP V2 su **entrambe** le chain: TokenMessengerV2 `0x8FE6…2DAA`, MessageTransmitterV2 `0xE737…E275`, TokenMinterV2 `0xb43d…F192`, MessageV2 `0xbaC0…90C4` | bytecode presente ✔; `localDomain()` = **15** su Monad e **6** su Base Sepolia ✔ |
| Collegamento USDC fra le due chain | su Monad `getLocalToken(6, USDC Base)` = USDC Monad; su Base `getLocalToken(15, USDC Monad)` = USDC Base; `remoteTokenMessengers` impostati in entrambe le direzioni ✔ |
| Selettori CCTP | `depositForBurn` V2 (`0x8e0250ee`) e `receiveMessage` (`0x57ecfd28`) presenti nelle implementazioni ✔ |
| USDC Circle | Monad `0x534b2f3A21130d7a60830c2Df862319e593943A3` e Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`: "USDC", 6 decimali ✔ |
| WMON / Multicall3 su Monad | bytecode presente ✔ |
| **Derivazione Chain Signatures** (predecessor `intentguard-policy.testnet`, path `maxz-demo.testnet,evm,1`) | offline (chainsig.js) = view `derived_public_key` su `v1.signer-prod.testnet` = **`0x99C0a0818d8aDBED43ae2EC6ea1F2B539B249E5B`** ✔. La chiave root di chainsig.js coincide con quella live del contratto ✔ |
| Gas price | Monad testnet ≈ 102 gwei (base fee 100); Base Sepolia ≈ 0,006 gwei |

Nota: l'esempio usa account d'esempio (`intentguard-policy.testnet`, `maxz-demo.testnet`) che **non** sono stati creati. Serve solo a dimostrare che il codice di derivazione funziona.

## Come rieseguire tutto

Prerequisiti, già installati su questa macchina: Foundry ≥ 1.8 (qui 1.8.4), Rust stable + target `wasm32-unknown-unknown`, `cargo-near` 0.22, Node 20, Python 3 con `cryptography`.

```bash
git clone --recurse-submodules https://github.com/francescantonio-stack/Intentguard-MAXMODv1 && cd Intentguard-MAXMODv1
# (se hai già clonato: git submodule update --init --recursive)
./run-all-checks.sh                       # tutto: forge, fork, cargo, sandbox, verifiche live

# oppure i singoli pezzi
cd contracts/evm && forge test                                   # unit + fuzz
FORK=1 forge test --match-contract MonadFork -vv                 # fork locale di Monad testnet
cd ../near-policy && cargo test --lib                            # policy NEAR
cargo near build non-reproducible-wasm                           # wasm (≈226 KB)
cargo test --test sandbox -- --ignored --nocapture               # sandbox NEAR locale (prima build anche di ../mock-mpc)
cd ../../scripts && npm i && node live-checks/near_derivation.mjs # derivazione (PREDECESSOR=… DERIVATION_PATH=… per altri account)
```

Prova di deploy **solo in locale** (senza chiavi: account sbloccato di anvil):

```bash
anvil --fork-url https://testnet-rpc.monad.xyz --network monad
cd contracts/evm && forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

## Deploy NEAR testnet (3/10/2026)

Solo testnet, zero soldi reali. Gli account sono stati creati con il faucet (10 NEAR ciascuno). Le chiavi stanno solo in `~/.near-credentials/testnet/` sul box, mai nel repo. Tutti gli hash sono in `deployments/near-testnet.json`.

| Cosa | Valore |
|---|---|
| Contratto policy (anche owner) | `intentguard-973f6c.testnet` |
| Utente demo | `intentguard-user-973f6c.testnet` (tetto 5 USDC/settimana, destinatario = indirizzo derivato) |
| MPC | `v1.signer-prod.testnet` |
| Indirizzo EVM derivato (path `intentguard-user-973f6c.testnet,evm,1`) | `0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B` |
| Deploy + init | [7cvYMvb2…](https://testnet.nearblocks.io/txns/7cvYMvb2UE6PbNaM5YxpHcV2chPBPg4nHR81bbffFsLB) |
| Firma MPC #1 (300 Tgas allegati) | [DtBoYFLq…](https://testnet.nearblocks.io/txns/DtBoYFLq6kSbvT3VZYMeQbJ1gMNZ3ysWoM6Z2MJYAbHw): indirizzo recuperato = derivato ✅, 5,3 s on-chain (8,9 s dalla CLI) |
| Firma MPC #2 (100 Tgas allegati) | [7iC7QFJ1…](https://testnet.nearblocks.io/txns/7iC7QFJ1TyGmECMiVd6pCak9EmKvqksChTcJm73SXDSQ): indirizzo recuperato = derivato ✅, 4,85 s on-chain (8,5 s dalla CLI) |

La transazione firmata è fittizia: EIP-1559 su chain 10143, `USDC.transfer(derivato, 1 USDC)`. **Non è stata trasmessa** perché l'indirizzo derivato non ha MON. Per verificarla:

`node scripts/live-checks/verify_mpc_signature.mjs <near_tx> <signer> <tx.json> <indirizzo>`

**Gas.** Totale bruciato 13,48 Tgas: 2,98 per la policy e 4,33 + 3,52 per l'MPC. Il client deve allegare **100 Tgas**.

**Casi negativi, rifiutati on-chain:**
- piano da 50 USDC → «weekly cap exceeded»;
- firma di un trasferimento di 50 USDC a `0x…0abc` → «recipient … not in your allowlist».

**Regole configurate:**
- approve USDC Base Sepolia → TokenMessengerV2;
- depositForBurn (dominio 15);
- receiveMessage di MessageTransmitterV2 su Monad;
- transfer USDC su Monad.

**Aggiornamento:** le regole di PlanExecutor (PlanExecute, PasskeyRegister, approve verso PlanExecutor) sono state aggiunte dopo il deploy su Monad. Vedi la sezione successiva.

## Monad testnet: deploy e demo end-to-end reale (3/10/2026)

Solo testnet, nessun soldo reale. Tutti gli hash sono in `deployments/monad-testnet.json`; gli explorer usati sono https://testnet.monadexplorer.com e https://testnet.nearblocks.io.

| Cosa | Valore |
|---|---|
| MiniSwap | `0x3D06B01a6B164322013547BEB4Fe0AfF985870f8` |
| DemoVault | `0x66C210D79d24a09FCa1F8Aae8c3a98A58F578914` |
| PlanExecutor | `0x3f1391EC12002E10E18Efa82Af5E491f8159faC1` |
| Verifica sorgenti | Sourcify (`--verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org`): exact match su tutti e 3, senza account |
| Deployer | `0xD22418AF35295B515F00eBfcFE8a42bBeF446300`: EOA di solo test, creato sul box. La chiave sta in `~/.intentguard/`, mai nel repo. Il deploy è costato circa 0,47 MON |

**Prima tx firmata via MPC e trasmessa:** [0x9beb0227…](https://testnet.monadexplorer.com/tx/0x9beb0227b8d8578a47ca5853ee4831cc907c5714533bf47fcc76f1809b785d4a)
- Sposta 1,2 MON dall'indirizzo derivato al deployer.
- La firma è stata chiesta tramite il contratto policy, usando una regola temporanea `NativeTransfer { max_value: 1,2 MON }`.
- La regola è stata rimossa subito dopo l'uso.
- L'hash della transazione NEAR di firma non è stato catturato: near-cli-rs lo stampa su stderr e la prima versione dello script lo perdeva. Il bug è corretto.

**Aggiornamento del contratto policy (stato invariato):**
- nuovo `RuleKind::NativeTransfer`, accodato all'enum, quindi senza migrazione;
- fix: con calldata vuota il log dell'evento andava in panic;
- 26 unit test passano.

**USDC su Monad:**
- Il faucet Circle ha reCAPTCHA, quindi non si può usare senza browser.
- Il deployer ha comprato 1,35 USDC con 0,3 MON sul DEX di testnet PuddleSwap (router UniswapV2 `0x430c…6660`).
- Ha seminato MiniSwap con 0,6 USDC e 0,133 WMON.
- Ha mandato 0,749 USDC all'indirizzo derivato.

**Demo end-to-end.** Ogni tx è firmata dal contratto policy insieme all'MPC `v1.signer-prod.testnet` e poi trasmessa. Ogni firma recupera l'indirizzo derivato.
- Piano: 0,6 USDC, di cui 0,2 scambiati in MON nativo (unwrap) e 0,4 depositati nel vault.
- Il piano è registrato su NEAR con `plan_hash = PlanExecutor.planHash(plan)`.

| Passo | NEAR | Monad | Gas Monad | Tempo firma / totale |
|---|---|---|---|---|
| registerPasskey (passkey P-256 di solo test, creata da script) | [2sLUbCeD…](https://testnet.nearblocks.io/txns/2sLUbCeDq3zCW6UNSdQZvhVdUWX2ceXs7eaAje7NivbL) | [0xd0664407…](https://testnet.monadexplorer.com/tx/0xd0664407272683196866a2b455ca42cca374082853b10cbdd92d23b0ce8db3c8) | 145.942 | 8,8 s / 12,9 s |
| USDC.approve(PlanExecutor, 0,6) | [814tT7gA…](https://testnet.nearblocks.io/txns/814tT7gAmvyETUfKdWN3A8owvWLRgYz9JF7g7agFykKU) | [0x226b2845…](https://testnet.monadexplorer.com/tx/0x226b2845d196f9c7cc0e34b19a59f5617799bc115935a55ea253b542f10071c1) | 109.538 | 8,1 s / 12,1 s |
| PlanExecutor.execute (swap + deposito nel vault) | [Hj2Tgs9U…](https://testnet.nearblocks.io/txns/Hj2Tgs9UPZ5TUt8EpTtfLuzSxMqtRx9eUZB5zs1eE8YP) | [0x970c7022…](https://testnet.monadexplorer.com/tx/0x970c7022d4a7846cac0f515bf3a8dda2e2a209f5fb988d760f08e301aa47628f) | 689.311 | 9,2 s / 13,1 s |

Esito:
- 0,4 USDC depositati nel vault;
- circa 0,033 MON ricevuti dallo swap;
- nonce del PlanExecutor passato a 1;
- gas NEAR circa 13,4–13,8 Tgas per firma, con 100 Tgas allegati.

Il gas Monad riportato è il `gasUsed` della ricevuta, che coincide con il limite impostato a stima × 1,25. Su Monad si paga il limite.

**Negativi:**
- `commit_plan` da 50 USDC → rifiutato su NEAR: «weekly cap exceeded (… remaining 2400000)».
- Piano da 6 USDC con firma passkey valida → `PlanExecutor` fa revert `OverWeeklyCap(6000000, 4400000)` (verificato con eth_call, senza gas).

**Script:**
- `scripts/live-checks/mpc_sign_and_send.mjs`: verifica la policy, chiede la firma MPC, controlla l'indirizzo recuperato e trasmette;
- `test_passkey.py`: passkey di test;
- `encode_execute.mjs`: codifica la chiamata `execute`.

**Saldi dopo la demo:** il derivato ha circa 3,73 MON e 0,149 USDC; il deployer circa 0,21 MON.

**Tratta CCTP da Base: saltata.** Per farla servono, sull'indirizzo derivato:
- ETH di Base Sepolia per il gas;
- USDC di Base Sepolia, dal faucet Circle, che ha captcha.

## Cosa devi inserire tu (Max)

1. **Account NEAR testnet** con near-cli-rs (gratis, `--useFaucet`): uno tuo (es. `maxz.testnet`) e uno per il contratto (es. `intentguard-policy.testnet`). Poi:
   ```bash
   near contract deploy intentguard-policy.testnet use-file contracts/near-policy/target/near/intentguard_policy.wasm \
     with-init-call new json-args '{"owner":"maxz.testnet","mpc_contract":"v1.signer-prod.testnet","max_user_weekly_cap":"1000000000"}' \
     prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
   ```
   Lo storage costa circa 2,3 NEAR testnet per 226 KB di wasm (dal faucet).
2. **Regole (`add_rule`)** con gli indirizzi reali, firmate dall'owner:
   - USDC Base → approve verso TokenMessengerV2;
   - TokenMessengerV2 → `CctpDepositForBurn {destination_domain:15, burn_token: USDC Base}`;
   - MessageTransmitterV2 su Monad → `CctpReceiveMessage`;
   - USDC Monad → approve verso **il tuo** PlanExecutor;
   - PlanExecutor → `PlanExecute` e `PasskeyRegister`.
3. **Il tuo utente**: `set_weekly_cap` e `add_recipient(<il tuo indirizzo derivato>)`, entrambi con `--deposit 1yocto` dalla chiave full-access. L'indirizzo derivato si ottiene con `PREDECESSOR=intentguard-policy.testnet DERIVATION_PATH=maxz.testnet,evm,1 node scripts/live-checks/near_derivation.mjs`.
4. **EOA di deploy, solo testnet**: `cast wallet new`, poi `cast wallet import intentguard-dev --interactive` (keystore Foundry, **mai** chiavi in file o in git). Servono **≈ 1 MON** di saldo per il deploy (vedi "Risultati").
   ```bash
   cd contracts/evm && DEPLOYMENTS_FILE=../../deployments/monad-testnet.json \
     forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast --account intentguard-dev
   ```
5. **MON per l'indirizzo derivato**, che deve pagare il gas: circa 0,06 MON per ogni `execute`, più approve/receiveMessage. **USDC di test** dal faucet Circle (Base Sepolia).
6. **Liquidità MiniSwap**: `wrap` di un po' di MON in WMON più USDC, poi `addLiquidity` dal tuo EOA. Anche 2–5 unità per lato bastano per la demo.
7. **Vettore browser reale**: apri `contracts/evm/tools/make-vector.html` su `localhost`, salva il JSON in `contracts/evm/test/fixtures/browser_vector.json` e lancia `forge test`. Il test oggi saltato diventa attivo.
8. Quando crei il repo vero: `forge install foundry-rs/forge-std vectorized/solady` (qui le librerie sono copiate senza git, come chiesto: nessun push).

## Limiti noti e cose da verificare

- **MPC reale chiamato su NEAR testnet (3/10/2026).** Due firme riuscite; la firma recupera l'indirizzo derivato. Gas reale bruciato: 13,48 Tgas in totale, con 100 Tgas allegati dal client che bastano (usare 100 invece di 150–300). Il parser della risposta funziona con il formato reale (`big_r.affine_point`, `s.scalar`, `recovery_id`). Dettagli nella sezione «Deploy NEAR testnet».
- Il contratto NEAR **non può verificare on-chain** che l'indirizzo in `add_recipient` sia davvero quello derivato: lo aggiungi tu con la chiave full-access, dopo averlo calcolato con lo script.
- Solady WebAuthn non controlla `rpIdHash` né `origin`: il vincolo all'origine lo garantisce il browser. Per questa demo è accettabile.
- La rotazione e il cambio del tetto in PlanExecutor richiedono la passkey attuale. Se la si perde, i fondi restano nell'EOA, controllabile via NEAR policy, ma non si possono più eseguire piani. Il recovery è fuori scope.
- `MiniSwap` e `DemoVault` sono **nostri e mock**: va scritto chiaramente nel README pubblico. CCTP, Chain Signatures e il precompile P256 sono **reali**.
- Nessun audit. Solo testnet.

## CCTP V2 reale Base Sepolia → Monad testnet (3/10/2026)

Script riutilizzabile: `node scripts/cctp-base-to-monad.mjs --amount 2 [--standard] [--execute]`.
- Ogni tx parte dall'indirizzo derivato `0xd2FE…a24B` (lo stesso path su entrambe le chain) ed è firmata dalla policy NEAR insieme all'MPC. Gli helper comuni sono in `scripts/lib/mpc.mjs`.
- `mintRecipient` è l'indirizzo derivato stesso, perché è da lì che `PlanExecutor` preleva gli USDC (`plan.account`).
- Sequenza:
  1. approve, solo se l'allowance non basta;
  2. `depositForBurn` con fast transfer: `minFinalityThreshold` 1000 e `maxFee` pari al doppio del minimo indicato da Circle (oggi 1,3 bps, quindi 521 unità base su 2 USDC);
  3. attestazione dall'API Iris sandbox;
  4. `receiveMessage` su Monad.
- Con `--execute` lo script fa tutta la demo in un colpo solo. Usa un solo piano NEAR, il cui `plan_hash` è `PlanExecutor.planHash(plan)`, approvato con la passkey di test. Il piano scambia metà in MON nativo e deposita il resto nel vault.
- Ogni esecuzione viene registrata in `deployments/cctp-runs.json`.

| Run | Base burn | Monad mint | Tempo |
|---|---|---|---|
| Solo CCTP, 2 USDC | [0x5c9a6435…](https://sepolia.basescan.org/tx/0x5c9a64352d4b2ebed79d91f860c57b74db773860cae637d10b78156ee6fe22eb) (approve [0x7b097f76…](https://sepolia.basescan.org/tx/0x7b097f7668c929b90e8815db3116b55f14393765e557d98076668b9341f7ca71)) | [0x749fe450…](https://testnet.monadexplorer.com/tx/0x749fe4500c991156573080bd89ad4db06358489a1d7ee4fac6e023abf6e179a6): mintati 1,99974 USDC (fee 0,00026) | 67 s, di cui 9,4 s per l'attestazione |
| Demo completa (`--execute`), 2 USDC | [0x8b1c6040…](https://sepolia.basescan.org/tx/0x8b1c6040af0300d49d5cc854ac5adc1c54e9877d6768c9aabd06fd7b48e68eda) | [0x57986db9…](https://testnet.monadexplorer.com/tx/0x57986db9ce312e0d50b418d84d3add2fd4903911299e1a57adc9b9928679feaa), poi [execute 0x4c0501ea…](https://testnet.monadexplorer.com/tx/0x4c0501ea37f917411543aab82536235a5a7fb6c2ecbba4339499a5919852585d) | 135 s in totale (CCTP 102 s, attestazione 28 s) |

**Costo in ETH su Base:** circa 0,33–0,5 µETH per tx; in tutto circa 2 µETH per 4 tx.

**Prezzo dello swap:** MiniSwap ha poca liquidità, quindi lo swap di circa 1 USDC ha reso solo circa 0,055 MON (impatto sul prezzo forte). Prima di una demo pubblica conviene aggiungere liquidità al pool.

## AI tools disclosure

Questo progetto è stato costruito con l'aiuto di assistenti AI: **Claude Code** (Anthropic) e **Grok Bot**. Li abbiamo usati per scrivere il codice, i test, gli script e la documentazione, e per eseguire deploy e verifiche su testnet. Le decisioni di progetto e l'approvazione di ogni passo sono del team (Dominiumchain). Tutto il codice è stato eseguito e testato: i risultati sono riportati sopra.

## Pre-existing code

Non c'è codice preesistente del team: tutto il codice di questo repo è stato scritto per l'hackathon, a partire dal 3/10/2026. Usiamo solo queste librerie open source, con le loro licenze:

| Libreria | Uso | Licenza | Come è inclusa |
|---|---|---|---|
| [forge-std](https://github.com/foundry-rs/forge-std) v1.17.0 (Foundry contributors) | test e script Solidity | MIT / Apache-2.0 | submodule git `contracts/evm/lib/forge-std` |
| [Solady](https://github.com/Vectorized/solady) v0.1.26 (Vectorized) | WebAuthn/P256, SafeTransferLib, ReentrancyGuard, ERC4626, FixedPointMathLib | MIT | submodule git `contracts/evm/lib/solady` |
| [near-sdk-rs](https://github.com/near/near-sdk-rs) 5.x (NEAR) | contratto policy e mock MPC | MIT / Apache-2.0 | dipendenza Cargo |
| near-workspaces, tokio, serde_json, hex e altri crate | test sandbox, encoding | vedi i rispettivi crate | dipendenze Cargo (`Cargo.lock`) |
| [viem](https://github.com/wevm/viem), [chainsig.js](https://github.com/NearDeFi/chainsig.js) | script di verifica, firma e invio | MIT | dipendenze npm (`scripts/package-lock.json`) |
| [cryptography](https://github.com/pyca/cryptography) (Python) | vettori P-256 e passkey di test | Apache-2.0 / BSD | pip |

Contratti esterni usati su testnet, ma non inclusi nel repo:
- l'MPC di NEAR `v1.signer-prod.testnet`;
- USDC di Circle e CCTP V2;
- WMON;
- il router UniswapV2 di PuddleSwap, usato una sola volta dal deployer per ottenere USDC di test.

## Licenza

MIT: vedi [LICENSE](LICENSE). © 2026 Dominiumchain.
