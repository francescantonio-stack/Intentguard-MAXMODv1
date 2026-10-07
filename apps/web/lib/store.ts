import type { Hex } from "viem";

/**
 * Device-local setup. The NEAR key stored here is a function-call key that can only call
 * commit_plan / cancel_plan / request_signature on the policy contract, with a small NEAR allowance:
 * it cannot move funds, raise caps or add recipients (those need the user's full-access key).
 */
export type Setup = {
  nearUser?: string;
  fcKey?: string;
  fcPublicKey?: string;
  credentialId?: string;
  passkey?: { x: Hex; y: Hex };
};

const KEY = "intentguard:setup:v1";

export function loadSetup(): Setup {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Setup;
  } catch {
    return {};
  }
}

export function saveSetup(patch: Partial<Setup>): Setup {
  const next = { ...loadSetup(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export const isReady = (s: Setup) => Boolean(s.nearUser && s.fcKey && s.credentialId && s.passkey);
