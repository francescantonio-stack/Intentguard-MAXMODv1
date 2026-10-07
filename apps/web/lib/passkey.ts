import { buildWebAuthnAuth, p256FromAuthData, p256FromSpki, planChallenge, type WebAuthnAuth } from "@intentguard/core";
import type { Hex } from "viem";

const b64u = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** Creates a device passkey (P-256, user verification required) and returns its public key for PlanExecutor. */
export async function createPasskey(label: string): Promise<{ credentialId: string; x: Hex; y: Hex }> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "IntentGuard" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey creation cancelled");
  const res = cred.response as AuthenticatorAttestationResponse;
  const spki = res.getPublicKey?.();
  const key = spki
    ? p256FromSpki(new Uint8Array(spki))
    : p256FromAuthData(new Uint8Array(res.getAuthenticatorData?.() ?? res.attestationObject));
  return { credentialId: b64u(cred.rawId), ...key };
}

/** Signs the plan hash with the passkey: one biometric/PIN prompt approves the whole plan. */
export async function approvePlan(credentialId: string, planId: Hex): Promise<WebAuthnAuth> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: new Uint8Array(planChallenge(planId)),
      allowCredentials: [{ type: "public-key", id: fromB64u(credentialId) }],
      userVerification: "required",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("approval cancelled");
  const r = cred.response as AuthenticatorAssertionResponse;
  return buildWebAuthnAuth({
    authenticatorData: new Uint8Array(r.authenticatorData),
    clientDataJSON: new Uint8Array(r.clientDataJSON),
    signature: new Uint8Array(r.signature),
  });
}
