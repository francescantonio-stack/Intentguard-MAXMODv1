import { describe, expect, it } from "vitest";
import { looksLikeSecretValue, redactSecrets } from "../src/redact";

const PK = "0x" + "ab".repeat(32);
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("redactSecrets", () => {
  it("redacts secret field names (word boundaries) and secret-like values", () => {
    const out = redactSecrets({
      authorization: "secret",
      bearer: "x",
      jwt: "x",
      auth: "x",
      recovery_phrase: MNEMONIC,
      sig: "x",
      sk: PK,
      pk: PK,
      note: "hello",
      hexKey: PK,
      token: "Bearer abc.def",
      jwtValue: "eyJhbGciOiJub25lIn0.e30.",
      words: MNEMONIC,
    });
    for (const k of ["authorization", "bearer", "jwt", "auth", "recovery_phrase", "sig", "sk", "pk", "hexKey", "token", "jwtValue", "words"]) {
      expect(out[k as keyof typeof out], k).toBe("[redacted]");
    }
    expect(out.note).toBe("hello");
  });

  it("does not redact legitimate token*/signatureCount/seededAt/passed fields", () => {
    const keep = {
      tokenIn: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      tokenOut: "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541",
      tokenAddress: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      tokenSymbol: "USDC",
      signatureCount: 2,
      seededAt: 123,
      passed: true,
      planId: PK,
      planHash: PK,
    };
    expect(redactSecrets(keep)).toEqual(keep);
  });

  it("looksLikeSecretValue recognises 0x+64, JWT, Bearer and a 12-word phrase", () => {
    expect(looksLikeSecretValue(PK)).toBe(true);
    expect(looksLikeSecretValue("eyJhbGciOiJub25lIn0.e30.")).toBe(true);
    expect(looksLikeSecretValue("Bearer abc")).toBe(true);
    expect(looksLikeSecretValue(MNEMONIC)).toBe(true);
    expect(looksLikeSecretValue("0x534b2f3A21130d7a60830c2Df862319e593943A3")).toBe(false);
  });
});
