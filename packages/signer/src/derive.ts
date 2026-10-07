import { secp256k1 } from "@noble/curves/secp256k1";
import { sha3_256 } from "@noble/hashes/sha3";
import { bytesToHex, getAddress, keccak256, type Address } from "viem";

/**
 * MPC root key of v1.signer-prod.testnet (secp256k1, uncompressed SEC1 hex) = chainsig.js
 * constants.ROOT_PUBLIC_KEYS.TESTNET "secp256k1:4NfTiv3U…Fwx3", decoded from base58.
 */
export const TESTNET_MPC_ROOT_KEY =
  "04a8bb8176747682aab5c681d4ef375ca537023b2b287d8b5f9d89505277a5a291538ef3680882d8fb793a62a5fdb4c6974c7cd8f9eb0b9cbbf659314c30347000";

/** Chain Signatures derivation (same as chainsig.js deriveChildPublicKey): child = root + sha3("…epsilon derivation:" + predecessor + "," + path)·G. */
export function deriveEvmAddress(predecessor: string, path: string, rootUncompressed = TESTNET_MPC_ROOT_KEY): Address {
  const eps = BigInt(bytesToHex(sha3_256(`near-mpc-recovery v0.1.0 epsilon derivation:${predecessor},${path}`))) % secp256k1.CURVE.n;
  const child = secp256k1.ProjectivePoint.fromHex(rootUncompressed).add(secp256k1.ProjectivePoint.BASE.multiply(eps));
  const raw = child.toRawBytes(false).subarray(1);
  return getAddress(`0x${keccak256(raw).slice(-40)}`);
}

/** The policy contract derives one EVM address per user, identical on every EVM chain. */
export const userEvmAddress = (policy: string, user: string, root?: string) => deriveEvmAddress(policy, `${user},evm,1`, root);
