import { keySender, PolicyClient, userEvmAddress } from "@intentguard/signer";
import { cfg } from "./config";
import type { Setup } from "./store";

export function policyClient(s: Setup): PolicyClient {
  const c = cfg();
  if (!s.nearUser) throw new Error("set up your NEAR account first");
  return new PolicyClient(c.nearRpc, c.policy, s.nearUser, s.fcKey ? keySender(c.nearRpc, s.nearUser, s.fcKey, c.policy) : undefined);
}

export const accountOf = (s: Setup) => userEvmAddress(cfg().policy, s.nearUser!);

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
