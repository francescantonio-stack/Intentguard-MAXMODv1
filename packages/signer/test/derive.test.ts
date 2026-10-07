import { describe, expect, it } from "vitest";
import { userEvmAddress } from "../src/derive";

describe("Chain Signatures derivation", () => {
  it("matches the derived address recorded on testnet (deployments/near-testnet.json)", () => {
    expect(userEvmAddress("intentguard-973f6c.testnet", "intentguard-user-973f6c.testnet")).toBe("0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B");
  });
  it("matches the README example verified against v1.signer-prod.testnet derived_public_key", () => {
    expect(userEvmAddress("intentguard-policy.testnet", "maxz-demo.testnet")).toBe("0x99C0a0818d8aDBED43ae2EC6ea1F2B539B249E5B");
  });
});
