import { describe, expect, it } from "vitest";
import { maxUint256, type Hex } from "viem";
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
    expect(r.event.kind).toBe("consented");
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
  it("now = NaN blocca con ConsentBadNow e non passa", () => {
    logged.length = 0;
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store } = fresh(p);
    const r = verifyConsent(consent, p, { store, now: NaN, log });
    expect(consentPassed(r)).toBe(false);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ConsentBadNow");
    expect(r.record.kind).toBe("blocked");
    expect(r.record.reason).toBe("ConsentBadNow");
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
    const ev = consumeConsent(consent, p, { store, now: now + 2, log });
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
    expect(() => consumeConsent(consent, p, { store, now: now + CONSENT_TTL_MS + 1, log })).toThrow(ConsentError);
    try {
      consumeConsent(consent, p, { store, now: now + CONSENT_TTL_MS + 1, log });
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

  it("consume accetta amount esplicito e non lo azzera", () => {
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now } = fresh(p);
    verifyConsent(consent, p, { store, now: now + 1 });
    const ev = consumeConsent(consent, p, { store, now: now + 2, amount: 99n });
    expect(ev.amount).toBe(99n);
  });

  it("prune toglie i record vecchi ma il replay sullo stesso planId resta bloccato", () => {
    const p = near([{ type: "Transfer", deposit: 10n }]);
    const { consent, store, now } = fresh(p);
    verifyConsent(consent, p, { store, now: now + 1 });
    consumeConsent(consent, p, { store, now: now + 2 });
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
