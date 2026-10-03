// Produces EIP-1559 signing-hash vectors with viem, used by the Rust policy contract tests (cross-implementation check).
import { serializeTransaction, keccak256, encodeFunctionData, parseAbi, pad } from 'viem';
const usdcMonad = '0x534b2f3A21130d7a60830c2Df862319e593943A3';
const usdcBase = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const tm = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
const derived = '0x99C0a0818d8aDBED43ae2EC6ea1F2B539B249E5B';
const abi = parseAbi([
  'function approve(address,uint256)',
  'function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold)',
]);
const cases = [
  { name: 'monad_approve', tx: { chainId: 10143, nonce: 0, maxPriorityFeePerGas: 2_000_000_000n, maxFeePerGas: 204_000_000_000n, gas: 60_000n, to: usdcMonad, value: 0n,
      data: encodeFunctionData({ abi, functionName: 'approve', args: [tm, 2_000_000n] }) } },
  { name: 'base_deposit_for_burn', tx: { chainId: 84532, nonce: 17, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 12_000_000n, gas: 180_000n, to: tm, value: 0n,
      data: encodeFunctionData({ abi, functionName: 'depositForBurn', args: [2_000_000n, 15, pad(derived), usdcBase, pad('0x00'), 500n, 1000] }) } },
  { name: 'tiny', tx: { chainId: 10143, nonce: 1, maxPriorityFeePerGas: 0n, maxFeePerGas: 1n, gas: 21_000n, to: derived, value: 0n, data: '0x' } },
];
const out = cases.map(({ name, tx }) => {
  const ser = serializeTransaction({ type: 'eip1559', ...tx });
  return { name, ...Object.fromEntries(Object.entries(tx).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])), payload: ser, hash: keccak256(ser) };
});
console.log(JSON.stringify(out, null, 1));
