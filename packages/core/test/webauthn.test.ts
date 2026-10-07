import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { buildWebAuthnAuth, derToRS, lowS, p256FromAuthData, p256FromSpki } from "../src/webauthn";

// Same vector the Foundry suite verifies on-chain (contracts/evm/test/WebAuthnVectors.t.sol).
const v = JSON.parse(readFileSync(new URL("../../../contracts/evm/test/fixtures/webauthn_vector.json", import.meta.url), "utf8"));
const N = p256.CURVE.n;

const der = (r: bigint, s: bigint) => new p256.Signature(r, s).toDERRawBytes();

describe("buildWebAuthnAuth", () => {
  it("reproduces the on-chain fixture from raw assertion bytes", () => {
    const auth = buildWebAuthnAuth({
      authenticatorData: hexToBytes(v.authenticatorData),
      clientDataJSON: new TextEncoder().encode(v.clientDataJSON),
      signature: der(BigInt(v.r), BigInt(v.s)),
    });
    expect(auth).toEqual({
      authenticatorData: v.authenticatorData,
      clientDataJSON: v.clientDataJSON,
      challengeIndex: BigInt(v.challengeIndex),
      typeIndex: BigInt(v.typeIndex),
      r: v.r,
      s: v.s,
    });
    // Same message Solady verifies: sha256(authenticatorData || sha256(clientDataJSON)).
    const msg = sha256(new Uint8Array([...hexToBytes(v.authenticatorData), ...sha256(new TextEncoder().encode(v.clientDataJSON))]));
    const pub = new Uint8Array([4, ...hexToBytes(v.x), ...hexToBytes(v.y)]);
    expect(p256.verify(new p256.Signature(BigInt(auth.r), BigInt(auth.s)).toCompactRawBytes(), msg, pub, { prehash: false })).toBe(true);
  });

  it("normalizes a high-S signature (Solady rejects high S)", () => {
    const s = BigInt(v.s);
    const auth = buildWebAuthnAuth({
      authenticatorData: hexToBytes(v.authenticatorData),
      clientDataJSON: new TextEncoder().encode(v.clientDataJSON),
      signature: der(BigInt(v.r), N - s),
    });
    expect(auth.s).toBe(v.s);
    expect(lowS(N - 1n)).toBe(1n);
  });

  it("parses DER with leading zero bytes", () => {
    expect(derToRS(der(1n, N - 2n))).toEqual({ r: 1n, s: N - 2n });
  });
});

describe("passkey public key extraction", () => {
  const priv = p256.utils.randomPrivateKey();
  const point = p256.getPublicKey(priv, false);
  const expected = { x: bytesToHex(point.subarray(1, 33)), y: bytesToHex(point.subarray(33)) };

  it("from SPKI (getPublicKey())", () => {
    const spkiHeader = hexToBytes("0x3059301306072a8648ce3d020106082a8648ce3d030107034200" as Hex);
    expect(p256FromSpki(new Uint8Array([...spkiHeader, ...point]))).toEqual(expected);
  });

  it("from the COSE key in authenticatorData", () => {
    const cose = new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...point.subarray(1, 33), 0x22, 0x58, 0x20, ...point.subarray(33)]);
    const authData = new Uint8Array([...new Uint8Array(32), 0x45, 0, 0, 0, 1, ...new Uint8Array(16), 0x00, 0x10, ...new Uint8Array(16), ...cose]);
    expect(p256FromAuthData(authData)).toEqual(expected);
  });
});
