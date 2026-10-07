import { bytesToHex, hexToBytes, type Hex } from "viem";

/** Mirrors Solady WebAuthn.WebAuthnAuth, the struct PlanExecutor.execute expects. */
export type WebAuthnAuth = {
  authenticatorData: Hex;
  clientDataJSON: string;
  challengeIndex: bigint;
  typeIndex: bigint;
  r: Hex;
  s: Hex;
};

export type P256PublicKey = { x: Hex; y: Hex };

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** The passkey signs the 32 raw bytes of the plan hash (Solady base64url-encodes them in clientDataJSON). */
export const planChallenge = (planHash: Hex): Uint8Array => hexToBytes(planHash);

/** ASN.1 DER ECDSA signature -> (r, s). */
export function derToRS(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  const expect = (tag: number) => {
    if (der[i++] !== tag) throw new Error("bad DER signature");
  };
  const readLen = () => {
    let len = der[i++]!;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | der[i++]!;
    }
    return len;
  };
  const readInt = () => {
    expect(0x02);
    const len = readLen();
    const v = der.subarray(i, i + len);
    i += len;
    return BigInt(bytesToHex(v));
  };
  expect(0x30);
  readLen();
  return { r: readInt(), s: readInt() };
}

/** Solady's P256 rejects high-S signatures: fold s into the lower half of the curve order. */
export const lowS = (s: bigint): bigint => (s > P256_N / 2n ? P256_N - s : s);

const to32 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`;

/** Browser assertion (navigator.credentials.get) -> the struct verified on-chain. */
export function buildWebAuthnAuth(a: {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}): WebAuthnAuth {
  const clientDataJSON = new TextDecoder().decode(a.clientDataJSON);
  const challengeIndex = clientDataJSON.indexOf('"challenge":"');
  const typeIndex = clientDataJSON.indexOf('"type":"webauthn.get"');
  if (challengeIndex < 0 || typeIndex < 0) throw new Error("unexpected clientDataJSON");
  const { r, s } = derToRS(a.signature);
  return {
    authenticatorData: bytesToHex(a.authenticatorData),
    clientDataJSON,
    challengeIndex: BigInt(challengeIndex),
    typeIndex: BigInt(typeIndex),
    r: to32(r),
    s: to32(lowS(s)),
  };
}

const xy = (point65: Uint8Array): P256PublicKey => {
  if (point65.length !== 65 || point65[0] !== 0x04) throw new Error("expected an uncompressed P-256 point");
  return { x: bytesToHex(point65.subarray(1, 33)), y: bytesToHex(point65.subarray(33, 65)) };
};

/** SubjectPublicKeyInfo (AuthenticatorAttestationResponse.getPublicKey()) -> (x, y). */
export const p256FromSpki = (spki: Uint8Array): P256PublicKey => xy(spki.subarray(spki.length - 65));

/**
 * Fallback for browsers without getPublicKey(): read x (-2) and y (-3) from the COSE key inside the
 * attested credential data of authenticatorData.
 */
export function p256FromAuthData(authData: Uint8Array): P256PublicKey {
  const find = (label: number) => {
    for (let i = 37; i < authData.length - 34; i++) {
      if (authData[i] === label && authData[i + 1] === 0x58 && authData[i + 2] === 0x20) return authData.subarray(i + 3, i + 35);
    }
    throw new Error("COSE key not found in authenticatorData");
  };
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(find(0x21), 1); // -2: x
  out.set(find(0x22), 33); // -3: y
  return xy(out);
}
