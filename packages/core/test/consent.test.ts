import { describe, expect, it } from "vitest";
import { maxUint256, parseAbi, type Hex } from "viem";
import { encodeFunctionData } from "viem";
import { erc20Abi } from "../src/abi";
import { MONAD_TESTNET } from "../src/chains";
import {
  CONSENT_TTL_MS,
  ConsentStore,
  approvalView,
  canonicalJson,
  exactText,
  formatUnitsIt,
  issueConsent,
  payloadAmount,
  payloadFromStep,
  plainExplanation,
  asAmount,
  asFiniteNumber,
  consentPassed,
  consumeConsent,
  ConsentError,
  CONSENT_WINDOW_MS,
  normNonce,
  rejectConsent,
  redactSecrets,
  renderApproval,
  toJsonLine,
  verifyConsent,
  type TxPayload,
} from "../src/consent";

const NOW = Date.parse("2026-11-24T05:35:00.000Z");
const BOB = "bob.near";
const USDT = "usdt.tether-token.near";
const NFT = "nft.example.near";
const STORE = "storage.example.near";
const USDC = MONAD_TESTNET.usdc;
const SPENDER = "0x3D06B01a6B164322013547BEB4Fe0AfF985870f8" as Hex;
const ALICE = "0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B" as Hex;

const near = (actions: TxPayload["kind"] extends never ? never : Extract<TxPayload, { kind: "near" }>["actions"], extra: Partial<Extract<TxPayload, { kind: "near" }>> = {}): Extract<TxPayload, { kind: "near" }> => ({
  kind: "near", network: "mainnet", signer: "alice.near", receiver: BOB, actions, ...extra,
});

const evm = (data: Hex | undefined, extra: Partial<Extract<TxPayload, { kind: "evm" }>> = {}): Extract<TxPayload, { kind: "evm" }> => ({
  kind: "evm", network: "monad-testnet", chainId: 10143, to: USDC, value: 0n, ...(data ? { data } : {}), ...extra,
});

const transferData = (to: Hex, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
const approveData = (spender: Hex, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
const increaseAbi = parseAbi(["function increaseAllowance(address spender,uint256 addedValue) returns (bool)"]);
const eip2612Abi = parseAbi(["function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)"]);
const daiPermitAbi = parseAbi(["function permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed,uint8 v,bytes32 r,bytes32 s)"]);
const setApprovalAbi = parseAbi(["function setApprovalForAll(address operator,bool approved)"]);
const increaseData = (spender: Hex, added: bigint) => encodeFunctionData({ abi: increaseAbi, functionName: "increaseAllowance", args: [spender, added] });
const permitData = (value: bigint) => encodeFunctionData({ abi: eip2612Abi, functionName: "permit", args: [ALICE, SPENDER, value, 1n, 27, ("0x" + "11".repeat(32)) as Hex, ("0x" + "22".repeat(32)) as Hex] });
const daiPermitData = (allowed: boolean) => encodeFunctionData({ abi: daiPermitAbi, functionName: "permit", args: [ALICE, SPENDER, 1n, 1n, allowed, 27, ("0x" + "11".repeat(32)) as Hex, ("0x" + "22".repeat(32)) as Hex] });
const setApprovalData = (approved: boolean) => encodeFunctionData({ abi: setApprovalAbi, functionName: "setApprovalForAll", args: [SPENDER, approved] });

const logged: unknown[] = [];
const log = (r: unknown) => void logged.push(r);
const storeOf = () => new ConsentStore();
const fresh = (p: TxPayload, store = storeOf(), now = NOW) => {
  const view = approvalView(p);
  const consent = issueConsent(view, { now, nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  return { view, consent, store, now };
};

describe("formatUnitsIt", () => {
  it("formats with Italian comma and no float", () => {
    expect(formatUnitsIt(1_500_000_000_000_000_000_000_000n, 24)).toBe("1,5");
    expect(formatUnitsIt(6_000_000n, 6)).toBe("6");
    expect(formatUnitsIt(0n, 18)).toBe("0");
  });
});

describe("testo esatto: ogni campo", () => {
  it("mostra rete, destinatario, metodo, argomenti decodificati, importi con decimali, deposito, gas", () => {
    const p = near(
      [{ type: "FunctionCall", method: "ft_transfer", args: { receiver_id: BOB, amount: "1500000", memo: "prova" }, deposit: 1n, gas: 30_000_000_000_000n }],
      { receiver: USDT },
    );
    const lines = exactText(p).join("\n");
    expect(lines).toContain("Rete: NEAR mainnet");
    expect(lines).toContain(`Destinatario: ${USDT}`);
    expect(lines).toContain("metodo: ft_transfer");
    expect(lines).toContain("receiver_id");
    expect(lines).toContain(BOB);
    expect(lines).toContain("memo");
    expect(lines).toContain("prova");
    expect(lines).toContain("0,000000000000000000000001 NEAR");
    expect(lines).toContain("1 yocto");
    expect(lines).toContain("30 TGas");
    expect(lines).toContain("30000000000000");
    const view = approvalView(p);
    expect(view.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(renderApproval(view)).toContain(view.payloadHash);
  });

  it("mostra ogni campo anche su una transfer ERC-20 Monad", () => {
    const p = evm(transferData(ALICE, 1_500_000n), { gas: 65_000n });
    const lines = exactText(p).join("\n");
    expect(lines).toContain("Rete: monad-testnet (chainId 10143)");
    expect(lines).toContain(`Destinatario (contratto): ${USDC}`);
    expect(lines).toContain("Metodo: transfer");
    expect(lines).toContain(ALICE);
    expect(lines).toContain("1,5 USDC");
    expect(lines).toContain("1500000");
    expect(lines).toContain("0 MON (0 wei)");
    expect(lines).toContain("Gas: 65000");
    expect(lines).toContain("Dati grezzi: 0x");
  });
});

describe("PlainSign: frase in italiano SOPRA il testo esatto", () => {
  const cases: [string, TxPayload, string | RegExp, "normal" | "high" | "unknown"][] = [
    ["transfer NEAR", near([{ type: "Transfer", deposit: 1_500_000_000_000_000_000_000_000n }]), "Stai inviando 1,5 NEAR a bob.near su mainnet.", "normal"],
    ["ft_transfer", near([{ type: "FunctionCall", method: "ft_transfer", args: { receiver_id: BOB, amount: "1500000" }, deposit: 1n, gas: 1n }], { receiver: USDT }), "Stai inviando 1,5 USDT a bob.near tramite il metodo ft_transfer su mainnet.", "normal"],
    ["nft_transfer", near([{ type: "FunctionCall", method: "nft_transfer", args: { receiver_id: BOB, token_id: "42" }, deposit: 1n, gas: 1n }], { receiver: NFT }), /Stai trasferendo l'NFT "42" della collezione nft\.example\.near a bob\.near su mainnet\./, "normal"],
    ["storage_deposit", near([{ type: "FunctionCall", method: "storage_deposit", args: { account_id: BOB }, deposit: 1_250_000_000_000_000_000_000n, gas: 1n }], { receiver: STORE }), "Stai pagando 0,00125 NEAR di deposito di storage su storage.example.near per bob.near su mainnet.", "normal"],
    ["function call generica", near([{ type: "FunctionCall", method: "set_greeting", args: { text: "ciao" }, deposit: 0n, gas: 1n }], { receiver: "greeter.near" }), "Stai chiamando il metodo set_greeting del contratto greeter.near su mainnet.", "normal"],
    ["add_key FullAccess", near([{ type: "AddKey", publicKey: "ed25519:ABC", permission: "FullAccess" }], { receiver: "alice.near" }), /RISCHIO ALTO: stai aggiungendo una chiave con ACCESSO COMPLETO/, "high"],
    ["delete_key", near([{ type: "DeleteKey", publicKey: "ed25519:ABC" }], { receiver: "alice.near" }), /RISCHIO ALTO: stai eliminando la chiave/, "high"],
    ["azione sconosciuta NEAR", { kind: "near", network: "mainnet", signer: "alice.near", receiver: BOB, actions: [{ type: "DeployContract" } as never] }, "Azione non riconosciuta: controlla il testo esatto.", "unknown"],
    ["invio nativo MON", evm(undefined, { to: ALICE, value: 500_000_000_000_000_000n }), "Stai inviando 0,5 MON a 0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B su monad-testnet.", "normal"],
    ["approve limitato", evm(approveData(SPENDER, 2_000_000n)), /Stai autorizzando .* a spendere fino a 2 USDC su monad-testnet\./, "normal"],
    ["approve illimitato", evm(approveData(SPENDER, maxUint256)), /RISCHIO ALTO: stai autorizzando .* quantità ILLIMITATA di USDC/, "high"],
    ["call EVM non riconosciuta", evm("0xdeadbeef"), "Azione non riconosciuta: controlla il testo esatto.", "unknown"],
  ];

  for (const [name, payload, expected, risk] of cases) {
    it(name, () => {
      const p = plainExplanation(payload);
      expect(p).toHaveLength(1);
      expect(p[0]!.risk).toBe(risk);
      if (typeof expected === "string") expect(p[0]!.text).toBe(expected);
      else expect(p[0]!.text).toMatch(expected);
      const rendered = renderApproval(approvalView(payload));
      const iPlain = rendered.indexOf(p[0]!.text);
      const iExact = rendered.indexOf("Testo esatto:");
      expect(iPlain).toBeGreaterThan(-1);
      expect(iExact).toBeGreaterThan(iPlain);
      expect(rendered.indexOf("In parole semplici:")).toBeLessThan(iPlain);
    });
  }
});

describe("consenso fresco, legato al payload", () => {
  it("un consenso valido e fresco passa, e l'hash copre anche la frase in italiano", () => {
    logged.length = 0;
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { view, consent, store, now } = fresh(p);
    expect(view.payloadHash).toBe(consent.payloadHash);
    expect(consent.expiresAt - consent.issuedAt).toBe(CONSENT_TTL_MS);
    const r = verifyConsent(consent, p, { store, now: now + 1_000, log });
    expect(consentPassed(r)).toBe(true);
    if (!r.ok) return;
    expect(r.event.kind).toBe("approved");
    expect(r.event.planId).toBe(view.payloadHash.toLowerCase());
    expect(r.event.amount).toBe(10n);
    expect(logged).toEqual([r.event]);
    // changing only the explanation (via a field that is hashed into the view) must change the hash
    const other = approvalView(near([{ type: "Transfer", deposit: 11n }]));
    expect(other.payloadHash).not.toBe(view.payloadHash);
  });

  it("un consenso scaduto fallisce e viene registrato", () => {
    logged.length = 0;
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now } = fresh(p);
    const r = verifyConsent(consent, p, { store, now: now + CONSENT_TTL_MS + 1, log });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ConsentExpired");
    expect(r.record.kind).toBe("expired");
    expect(r.record.reason).toBe("ConsentExpired");
    expect(r.record.planId).toBe(approvalView(p).payloadHash.toLowerCase());
    expect(r.record.amount).toBe(10n);
    expect(r.record.id).toBe(consent.nonce);
    expect(r.record.ts).toBeTruthy();
    expect(logged).toEqual([r.record]);
    expect(toJsonLine(r.record).startsWith("{")).toBe(true);
    expect(JSON.parse(toJsonLine(r.record)).kind).toBe("expired");
  });

  it("se il payload cambia dopo il consenso, fallisce", () => {
    logged.length = 0;
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now } = fresh(p);
    const changed = near([{ type: "Transfer", deposit: 11n }]);
    const r = verifyConsent(consent, changed, { store, now: now + 1, log });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ConsentPayloadMismatch");
    expect(r.record.kind).toBe("blocked");
    expect(r.record.reason).toBe("ConsentPayloadMismatch");
    expect(r.record.amount).toBe(11n);
    expect(logged).toHaveLength(1);
  });

  it("un consenso già usato (replay) fallisce", () => {
    logged.length = 0;
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now } = fresh(p);
    expect(verifyConsent(consent, p, { store, now: now + 1, log }).ok).toBe(true);
    logged.length = 0;
    const r = verifyConsent(consent, p, { store, now: now + 2, log });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ConsentReplay");
    expect(r.record.kind).toBe("blocked");
    expect(r.record.reason).toBe("ConsentReplay");
    expect(logged).toHaveLength(1);
  });

  it("un rifiuto viene registrato e il consenso non è più spendibile", () => {
    logged.length = 0;
    const p = near([{ type: "Transfer", deposit: 42n }]);
    const { consent, store, now } = fresh(p);
    const rec = rejectConsent(consent, p, { store, now, log });
    expect(rec.kind).toBe("rejected");
    expect(rec.reason).toBe("ConsentRejected");
    expect(rec.amount).toBe(42n);
    expect(rec.planId).toBe(approvalView(p).payloadHash.toLowerCase());
    expect(logged).toEqual([rec]);
    const r = verifyConsent(consent, p, { store, now: now + 1, log });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ConsentReplay");
  });
});

describe("hash canonico e payloadFromStep", () => {
  it("è stabile rispetto all'ordine delle chiavi", () => {
    expect(canonicalJson({ b: 2n, a: 1 })).toBe(canonicalJson({ a: 1, b: 2n }));
    expect(payloadAmount(near([{ type: "Transfer", deposit: 7n }]))).toBe(7n);
  });

  it("un passo del piano diventa un payload EVM", () => {
    const p = payloadFromStep({
      chain: "monad-testnet", chainId: 10143, kind: "transfer", to: USDC,
      data: transferData(ALICE, 1_000_000n), label: "Send 1 USDC",
    });
    expect(plainExplanation(p)[0]!.text).toContain("1 USDC");
    expect(exactText(p).join("\n")).toContain("Metodo: transfer");
  });
});

describe("fail-closed (edge cases)", () => {
  it("now = NaN blocca con BAD_NOW e non passa", () => {
    logged.length = 0;
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store } = fresh(p);
    const r = verifyConsent(consent, p, { store, now: NaN, log });
    expect(consentPassed(r)).toBe(false);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("BAD_NOW");
    expect(r.record.kind).toBe("blocked");
    expect(r.record.reason).toBe("BAD_NOW");
    expect(logged).toHaveLength(1);
  });

  it("expiresAt come stringa (tipo sbagliato) blocca, non passa", () => {
    logged.length = 0;
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now } = fresh(p);
    const bad = { ...consent, expiresAt: String(consent.expiresAt) };
    const r = verifyConsent(bad, p, { store, now: now + 1, log });
    expect(consentPassed(r)).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ConsentMalformed");
  });

  it("payload null non va in crash e blocca", () => {
    logged.length = 0;
    const store = storeOf();
    const r = verifyConsent({ payloadHash: "0x" + "ab".repeat(32), nonce: "0xaa", issuedAt: NOW, expiresAt: NOW + 1000 }, null, { store, now: NOW, log });
    expect(consentPassed(r)).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ConsentMalformed");
    expect(r.record.planId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("importo bigint 0n è accettato come 0", () => {
    expect(asAmount(0n)).toBe(0n);
    expect(asAmount(0)).toBe(0n);
    expect(asAmount("0")).toBeUndefined();
    expect(payloadAmount(near([{ type: "Transfer", deposit: 0n }]))).toBe(0n);
    expect(payloadAmount(near([{ type: "Transfer", deposit: 0 as unknown as bigint }]))).toBe(0n);
    const p = near([{ type: "Transfer", deposit: 0n }]);
    const { consent, store, now } = fresh(p);
    expect(consentPassed(verifyConsent(consent, p, { store, now: now + 1 }))).toBe(true);
  });

  it("{ok:0} non conta come consenso valido", () => {
    expect(consentPassed({ ok: 0 })).toBe(false);
    expect(consentPassed({ ok: 1 })).toBe(false);
    expect(consentPassed({ ok: "true" })).toBe(false);
    expect(consentPassed({ ok: true })).toBe(true);
    expect(consentPassed(null)).toBe(false);
  });

  it("dopo un uso, anche con payload modificato, il replay blocca", () => {
    logged.length = 0;
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now } = fresh(p);
    expect(consentPassed(verifyConsent(consent, p, { store, now: now + 1, log }))).toBe(true);
    const tweaked = near([{ type: "Transfer", deposit: 99n }]);
    const r = verifyConsent(consent, tweaked, { store, now: now + 2, log });
    expect(consentPassed(r)).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ConsentReplay");
    expect(r.record.kind).toBe("blocked");
    expect(r.record.reason).toBe("ConsentReplay");
  });

  it("now Infinity, now '0.1', consenso assente e store assente bloccano senza crash", () => {
    const p = near([{ type: "Transfer", deposit: 1n }]);
    const { consent, store, now } = fresh(p);
    expect(verifyConsent(consent, p, { store, now: Infinity }).ok).toBe(false);
    expect(verifyConsent(consent, p, { store, now: "0.1" }).ok).toBe(false);
    expect(asFiniteNumber("0.1")).toBeUndefined();
    expect(asFiniteNumber(now)).toBe(now);
    expect(verifyConsent(undefined, p, { store, now }).ok).toBe(false);
    expect(verifyConsent(consent, p, { now }).ok).toBe(false);
    expect(() => verifyConsent(null, undefined, undefined)).not.toThrow();
    expect(consentPassed(verifyConsent(null, undefined, undefined))).toBe(false);
  });

  it("nonce stringa e numero sono lo stesso nonce", () => {
    const store = storeOf();
    store.spend(3);
    expect(store.has("3")).toBe(true);
    expect(store.has(3)).toBe(true);
    expect(normNonce("3")).toBe(normNonce(3));
    expect(normNonce(3n)).toBe("3");
  });
});

describe("redazione nei log, non nel testo di approvazione", () => {
  it("non oscura campi onesti (tokenIn, tokenAddress, signatureCount) e non altera il testo esatto", () => {
    const clean = { tokenIn: "USDC", tokenOut: "MON", tokenAddress: MONAD_TESTNET.usdc, tokenSymbol: "USDC", signatureCount: 2, seededAt: NOW, passed: true };
    expect(redactSecrets(clean)).toEqual(clean);
    const p = near([{ type: "FunctionCall", method: "ft_transfer", args: { receiver_id: BOB, amount: "1500000", tokenIn: "USDT" }, deposit: 1n, gas: 1n }], { receiver: USDT });
    const text = exactText(p).join("\n");
    expect(text).toContain("tokenIn");
    expect(text).toContain("USDT");
    expect(text).not.toContain("[redacted]");
  });

  it("oscura valori segreti (0x+64, jwt eyJ, Bearer) e chiavi con bordo di parola (sk, jwt, auth)", () => {
    const fakeKey = "0x" + "ab".repeat(32);
    const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.x";
    const out = redactSecrets({
      sk: "whatever",
      jwt,
      auth: "n",
      authorization: "Bearer abc.def",
      note: "ok",
      raw: fakeKey,
      header: "Bearer abc.def",
    }) as Record<string, unknown>;
    expect(out.sk).toBe("[redacted]");
    expect(out.jwt).toBe("[redacted]");
    expect(out.auth).toBe("[redacted]");
    expect(out.authorization).toBe("[redacted]");
    expect(out.raw).toBe("[redacted]");
    expect(out.header).toBe("[redacted]");
    expect(out.note).toBe("ok");
  });
});

describe("consume e scadenza dello stato consented", () => {
  it("consume dopo il consenso fresco emette consumed con amount bigint", () => {
    logged.length = 0;
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now } = fresh(p);
    expect(consentPassed(verifyConsent(consent, p, { store, now: now + 1, log }))).toBe(true);
    const ev = consumeConsent(consent, p, { store, now: now + 2, log, amount: 10n });
    expect(ev.kind).toBe("consumed");
    expect(ev.reason).toBe("Consumed");
    expect(ev.amount).toBe(10n);
    expect(ev.planId).toBe(approvalView(p).payloadHash.toLowerCase());
    expect(ev.id).toBe(consent.nonce);
  });

  it("approva, vai oltre il TTL, e consume lancia expired", () => {
    logged.length = 0;
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now } = fresh(p);
    expect(consentPassed(verifyConsent(consent, p, { store, now: now + 1, log }))).toBe(true);
    logged.length = 0;
    expect(() => consumeConsent(consent, p, { store, now: now + CONSENT_TTL_MS + 1, log, amount: 10n })).toThrow(ConsentError);
    try {
      consumeConsent(consent, p, { store, now: now + CONSENT_TTL_MS + 1, log, amount: 10n });
    } catch (e) {
      expect(e).toBeInstanceOf(ConsentError);
      const err = e as ConsentError;
      expect(err.code).toBe("Expired");
      expect(err.event.kind).toBe("expired");
      expect(err.event.reason).toBe("Expired");
      expect(err.event.amount).toBe(10n);
    }
    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(logged[0]).toMatchObject({ kind: "expired", reason: "Expired", amount: 10n });
  });

  it("consume senza amount si blocca con MissingAmount e non cambia lo stato", () => {
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now } = fresh(p);
    verifyConsent(consent, p, { store, now: now + 1 });
    try {
      consumeConsent(consent, p, { store, now: now + 2 });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConsentError);
      const err = e as ConsentError;
      expect(err.code).toBe("MissingAmount");
      expect(err.event.kind).toBe("blocked");
      expect(err.event.amount).toBe(10n);
    }
    // still consumable with the matching amount
    const ev = consumeConsent(consent, p, { store, now: now + 3, amount: 10n });
    expect(ev.kind).toBe("consumed");
    expect(ev.amount).toBe(10n);
  });

  it("consume con amount diverso da quello approvato si blocca con AmountMismatch", () => {
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now } = fresh(p);
    verifyConsent(consent, p, { store, now: now + 1 });
    try {
      consumeConsent(consent, p, { store, now: now + 2, amount: 99n });
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ConsentError;
      expect(err.code).toBe("AmountMismatch");
      expect(err.event.kind).toBe("blocked");
      expect(err.event.amount).toBe(99n);
    }
  });

  it("prune toglie i record vecchi ma il replay sullo stesso planId resta bloccato", () => {
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now } = fresh(p);
    verifyConsent(consent, p, { store, now: now + 1 });
    consumeConsent(consent, p, { store, now: now + 2, amount: 10n });
    expect(store.size).toBe(1);
    store.prune(now + 2 + CONSENT_WINDOW_MS + 1);
    expect(store.size).toBe(0);
    expect(store.seen(approvalView(p).payloadHash)).toBe(true);
    const again = issueConsent(approvalView(p), { now: now + CONSENT_WINDOW_MS + 10, nonce: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    const r = verifyConsent(again, p, { store, now: now + CONSENT_WINDOW_MS + 11, log });
    expect(consentPassed(r)).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ConsentReplay");
  });

  it("planId negli eventi è minuscolo", () => {
    const p = near([{ type: "Transfer", deposit: 1n }]);
    const { consent, store, now, view } = fresh(p);
    const r = verifyConsent(consent, p, { store, now: now + 1 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.event.planId).toBe(r.event.planId.toLowerCase());
    expect(r.event.planId).toBe(view.payloadHash.toLowerCase());
  });
});

describe("lezioni review: config, orologio, storico, redazione", () => {
  it("ttlMs presente ma non valido (NaN, 0, Infinity) emette blocked BAD_CONFIG: ttlMs e non emette consenso", () => {
    const p = near([{ type: "Transfer", deposit: 1n }]);
    const view = approvalView(p);
    for (const ttlMs of [NaN, 0, Infinity, -1, "120000" as unknown as number]) {
      logged.length = 0;
      try {
        issueConsent(view, { now: NOW, ttlMs, log });
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ConsentError);
        const err = e as ConsentError;
        expect(err.code).toBe("BAD_CONFIG");
        expect(err.event.kind).toBe("blocked");
        expect(err.event.reason).toBe("BAD_CONFIG: ttlMs");
      }
    }
  });

  it("ttlMs richiesto più lungo del massimo viene stretto, uno più corto è rispettato", () => {
    const p = near([{ type: "Transfer", deposit: 1n }]);
    const view = approvalView(p);
    const long = issueConsent(view, { now: NOW, ttlMs: CONSENT_TTL_MS * 10 });
    expect(long.expiresAt - long.issuedAt).toBe(CONSENT_TTL_MS);
    const short = issueConsent(view, { now: NOW, ttlMs: 15_000 });
    expect(short.expiresAt - short.issuedAt).toBe(15_000);
    const missing = issueConsent(view, { now: NOW });
    expect(missing.expiresAt - missing.issuedAt).toBe(CONSENT_TTL_MS);
  });

  it("now non finito o all'indietro: blocked BAD_NOW, nessuno stato scritto, emit non crasha", () => {
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now } = fresh(p);
    expect(consentPassed(verifyConsent(consent, p, { store, now: now + 1, log }))).toBe(true);
    expect(store.size).toBe(1);
    const size = store.size;
    logged.length = 0;
    const rNaN = verifyConsent(consent, p, { store, now: NaN, log });
    expect(rNaN.ok).toBe(false);
    if (!rNaN.ok) {
      expect(rNaN.reason).toBe("BAD_NOW");
      expect(rNaN.record.kind).toBe("blocked");
      expect(Number.isFinite(Date.parse(rNaN.record.ts))).toBe(true);
    }
    const rBack = verifyConsent(consent, p, { store, now: now, log }); // now < lastNow (now+1)
    expect(rBack.ok).toBe(false);
    if (!rBack.ok) {
      expect(rBack.reason).toBe("BAD_NOW");
      expect(rBack.record.kind).toBe("blocked");
    }
    expect(store.size).toBe(size);
    expect(store.get(consent.nonce)?.status).toBe("consented");
    // still consumable going forward
    const ev = consumeConsent(consent, p, { store, now: now + 2, amount: 10n, log });
    expect(ev.kind).toBe("consumed");
    // consume with Infinity does not write NaN into the store
    const p2 = near([{ type: "Transfer", deposit: 3n }]);
    const f2 = fresh(p2);
    verifyConsent(f2.consent, p2, { store: f2.store, now: now + 1 });
    try {
      consumeConsent(f2.consent, p2, { store: f2.store, now: Infinity, amount: 3n, log });
    } catch (e) {
      const err = e as ConsentError;
      expect(err.code).toBe("BAD_NOW");
      expect(err.event.kind).toBe("blocked");
      expect(Number.isFinite(Date.parse(err.event.ts))).toBe(true);
    }
    expect(f2.store.get(f2.consent.nonce)?.status).toBe("consented");
    expect(f2.store.get(f2.consent.nonce)?.decidedAt).not.toBeNaN();
  });

  it("remove e ricrea con lo stesso planId non azzera lo storico: il replay resta bloccato", () => {
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now, view } = fresh(p);
    verifyConsent(consent, p, { store, now: now + 1 });
    consumeConsent(consent, p, { store, now: now + 2, amount: 10n });
    expect(store.historyOf(view.payloadHash)?.status).toBe("consumed");
    store.remove(consent.nonce);
    expect(store.size).toBe(0);
    expect(store.seen(view.payloadHash)).toBe(true);
    const again = issueConsent(view, { now: now + 3, nonce: "0xcccccccccccccccccccccccccccccccc", store });
    const r = verifyConsent(again, p, { store, now: now + 4, log });
    expect(consentPassed(r)).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ConsentReplay");
      expect(r.record.kind).toBe("blocked");
    }
    try {
      consumeConsent(again, p, { store, now: now + 5, amount: 10n });
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ConsentError;
      expect(err.code).toBe("Consumed");
      expect(err.event.kind).toBe("blocked");
    }
  });

  it("redazione: esenta solo i nomi esatti KEEP_HEX; 0x+40 visibile; mai salt né nomi con key/secret/priv/seed/mnemonic/password", () => {
    const h64 = "0x" + "ab".repeat(32);
    const addr40 = "0x" + "cd".repeat(20);
    const out = redactSecrets({
      planId: h64,
      planHash: h64,
      txHash: h64,
      transactionHash: h64,
      blockHash: h64,
      root: h64,
      merkleRoot: h64,
      raw: h64,
      walletAddress: h64,
      walletAddress40: addr40,
      to: addr40,
      salt: h64,
      privateKeyId: h64,
      keyId: h64,
      secretId: h64,
      seedHash: h64,
      mnemonicId: h64,
      passwordHash: h64,
      privKey: "x",
      tokenIn: "USDC",
    }) as Record<string, unknown>;
    expect(out.planId).toBe(h64);
    expect(out.planHash).toBe(h64);
    expect(out.txHash).toBe(h64);
    expect(out.transactionHash).toBe(h64);
    expect(out.blockHash).toBe(h64);
    expect(out.root).toBe(h64);
    expect(out.merkleRoot).toBe(h64);
    expect(out.raw).toBe("[redacted]");
    expect(out.walletAddress).toBe("[redacted]");
    expect(out.walletAddress40).toBe(addr40);
    expect(out.to).toBe(addr40);
    expect(out.salt).toBe("[redacted]");
    expect(out.privateKeyId).toBe("[redacted]");
    expect(out.keyId).toBe("[redacted]");
    expect(out.secretId).toBe("[redacted]");
    expect(out.seedHash).toBe("[redacted]");
    expect(out.mnemonicId).toBe("[redacted]");
    expect(out.passwordHash).toBe("[redacted]");
    expect(out.privKey).toBe("[redacted]");
    expect(out.tokenIn).toBe("USDC");
  });
});

describe("PlainSign: increaseAllowance, permit, setApprovalForAll, calldata malformata", () => {
  it("increaseAllowance(max), permit(max), permit DAI allowed=true, setApprovalForAll(true) sono permessi totali", () => {
    const cases: [string, TxPayload, RegExp][] = [
      ["increaseAllowance max", evm(increaseData(SPENDER, maxUint256)), /RISCHIO ALTO: stai aumentando l'autorizzazione .* quantità ILLIMITATA .* È un permesso totale/],
      ["permit EIP-2612 max", evm(permitData(maxUint256)), /RISCHIO ALTO: stai firmando un permit che autorizza .* quantità ILLIMITATA .* È un permesso totale/],
      ["permit DAI allowed=true", evm(daiPermitData(true)), /RISCHIO ALTO: stai firmando un permit DAI che autorizza .* quantità ILLIMITATA .* È un permesso totale/],
      ["setApprovalForAll(true)", evm(setApprovalData(true)), /RISCHIO ALTO: stai dando a .* il permesso TOTALE di gestire tutti i tuoi NFT .*setApprovalForAll/],
    ];
    for (const [name, payload, re] of cases) {
      const p = plainExplanation(payload);
      expect(p, name).toHaveLength(1);
      expect(p[0]!.risk, name).toBe("high");
      expect(p[0]!.text, name).toMatch(re);
      const rendered = renderApproval(approvalView(payload));
      expect(rendered.indexOf("In parole semplici:")).toBeLessThan(rendered.indexOf("Testo esatto:"));
      expect(rendered).toContain(p[0]!.text);
    }
  });

  it("increaseAllowance, permit e setApprovalForAll limitati non sono flaggati come illimitati", () => {
    expect(plainExplanation(evm(increaseData(SPENDER, 2_000_000n)))[0]).toMatchObject({ risk: "normal" });
    expect(plainExplanation(evm(permitData(2_000_000n)))[0]!.text).toMatch(/fino a 2 USDC/);
    expect(plainExplanation(evm(daiPermitData(false)))[0]!.risk).toBe("normal");
    expect(plainExplanation(evm(setApprovalData(false)))[0]!.risk).toBe("normal");
  });

  it("calldata tronco o malformato con selettore approve/permit/setApprovalForAll: il consenso è bloccato (MalformedApproval), niente fallback unknown + avviso", () => {
    const sels = [
      "0x095ea7b3", // approve
      "0x39509351", // increaseAllowance
      "0xd505accf", // permit eip-2612
      "0x8fcbaf0c", // permit DAI
      "0xa22cb465", // setApprovalForAll
    ];
    for (const sel of sels) {
      const truncated = (sel + "00") as Hex; // too short to decode
      const payload = evm(truncated);
      const p = plainExplanation(payload);
      expect(p, sel).toHaveLength(1);
      expect(p[0]!.risk, sel).toBe("high");
      expect(p[0]!.text, sel).toMatch(/il piano è bloccato/i);
      expect(p[0]!.text, sel).not.toBe("Azione non riconosciuta: controlla il testo esatto.");
      const all = p.map((x) => x.text).join(" ");
      expect(all, sel).not.toMatch(/Stai autorizzando|Stai inviando|Stai chiamando|Stai firmando|Stai aumentando|Stai dando|Azione non riconosciuta/);
      expect(() => exactText(payload)).not.toThrow();
      expect(() => approvalView(payload)).not.toThrow();
      const store = storeOf();
      const r = verifyConsent(null, payload, { store, now: NOW, log });
      expect(r.ok, sel).toBe(false);
      if (!r.ok) {
        expect(r.reason, sel).toBe("MalformedApproval");
        expect(r.record.kind, sel).toBe("blocked");
        expect(r.record.reason, sel).toBe("MalformedApproval");
      }
    }
    // a truly unknown selector still uses the generic fallback and is not MalformedApproval
    const unknown = evm("0xdeadbeef");
    const u = plainExplanation(unknown);
    expect(u).toHaveLength(1);
    expect(u[0]!.text).toBe("Azione non riconosciuta: controlla il testo esatto.");
    expect(u[0]!.risk).toBe("unknown");
    const ur = verifyConsent(null, unknown, { store: storeOf(), now: NOW });
    expect(ur.ok).toBe(false);
    if (!ur.ok) expect(ur.reason).not.toBe("MalformedApproval");
  });

  it("consume di un piano con approve/permit tronco si blocca con MalformedApproval e non cambia lo stato", () => {
    const pOk = evm(approveData(SPENDER, 2_000_000n));
    const { consent, store, now, view } = fresh(pOk);
    expect(consentPassed(verifyConsent(consent, pOk, { store, now: now + 1 }))).toBe(true);
    const truncated = evm(("0x095ea7b3" + "00") as Hex);
    logged.length = 0;
    try {
      consumeConsent(consent, truncated, { store, now: now + 2, amount: 2_000_000n, log });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConsentError);
      const err = e as ConsentError;
      expect(err.code).toBe("MalformedApproval");
      expect(err.event.kind).toBe("blocked");
      expect(err.event.reason).toBe("MalformedApproval");
    }
    expect(store.get(consent.nonce)?.status).toBe("consented");
    // still consumable with the original, well-formed payload
    const ev = consumeConsent(consent, pOk, { store, now: now + 3, amount: 2_000_000n });
    expect(ev.kind).toBe("consumed");
    expect(view.payloadHash).toBe(consent.payloadHash);
  });

  it("calldata che non è hex 0x valido viene rifiutata, senza crash", () => {
    for (const data of ["0xzz", "deadbeef", "0xabc", "0xGHI", 123 as never]) {
      const payload = evm(data as never);
      expect(() => plainExplanation(payload)).not.toThrow();
      expect(() => exactText(payload)).not.toThrow();
      expect(() => approvalView(payload)).not.toThrow();
      const p = plainExplanation(payload);
      expect(p[0]!.text).toBe("Azione non riconosciuta: controlla il testo esatto.");
      expect(p[0]!.risk).toBe("unknown");
      expect(p.some((x) => /hex 0x valido/i.test(x.text))).toBe(true);
      expect(p.map((x) => x.text).join(" ")).not.toMatch(/Stai inviando|Stai autorizzando|Stai chiamando/);
      const { store, now } = { store: storeOf(), now: NOW };
      const r = verifyConsent(null, payload, { store, now });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.record.kind).toBe("blocked");
        expect(r.reason === "MALFORMED" || r.reason === "ConsentMalformed").toBe(true);
      }
    }
  });

  it("value non numerico viene rifiutato, senza crash", () => {
    for (const value of ["1e18", "foo", NaN, Infinity, null, undefined] as unknown[]) {
      const payload = { ...evm(undefined, { to: ALICE }), value } as TxPayload;
      expect(() => plainExplanation(payload)).not.toThrow();
      expect(() => exactText(payload)).not.toThrow();
      expect(() => approvalView(payload)).not.toThrow();
      const p = plainExplanation(payload);
      expect(p[0]!.text).toBe("Azione non riconosciuta: controlla il testo esatto.");
      expect(p.some((x) => /valore nativo.*non è un numero valido/i.test(x.text))).toBe(true);
      expect(p.map((x) => x.text).join(" ")).not.toMatch(/Stai inviando/);
      const r = verifyConsent(null, payload, { store: storeOf(), now: NOW });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.record.kind).toBe("blocked");
        expect(r.reason === "MALFORMED" || r.reason === "ConsentMalformed").toBe(true);
      }
    }
  });
});
