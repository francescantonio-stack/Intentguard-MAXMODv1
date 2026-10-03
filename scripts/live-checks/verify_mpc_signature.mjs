// Verifies a real MPC signature returned by the policy contract: rebuilds the EIP-1559 tx with viem,
// checks the hash equals the signed payload, and recovers the signer address. Read-only (no broadcast).
// Usage: node verify_mpc_signature.mjs <near_tx_hash> <signer_account_id> <tx.json> <expected_evm_address>
import { serializeTransaction, keccak256, recoverAddress, getAddress } from 'viem';
import fs from 'fs';
const [txHash, signer, txFile, expected] = process.argv.slice(2);
const r = await (await fetch('https://rpc.testnet.near.org', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'EXPERIMENTAL_tx_status', params: { tx_hash: txHash, sender_account_id: signer, wait_until: 'FINAL' } }) })).json();
const res = r.result;
const sig = JSON.parse(Buffer.from(res.status.SuccessValue, 'base64').toString());
const gasBurnt = res.transaction_outcome.outcome.gas_burnt + res.receipts_outcome.reduce((a, o) => a + o.outcome.gas_burnt, 0);
const t = JSON.parse(fs.readFileSync(txFile, 'utf8'));
const unsigned = { type: 'eip1559', chainId: t.chain_id, nonce: t.nonce, maxPriorityFeePerGas: BigInt(t.max_priority_fee_per_gas),
  maxFeePerGas: BigInt(t.max_fee_per_gas), gas: BigInt(t.gas_limit), to: t.to, value: BigInt(t.value), data: t.data };
const hash = keccak256(serializeTransaction(unsigned));
const rHex = '0x' + sig.big_r.affine_point.slice(2), sHex = '0x' + sig.s.scalar;
const recovered = await recoverAddress({ hash, signature: { r: rHex, s: sHex, yParity: sig.recovery_id } });
const signedTx = serializeTransaction(unsigned, { r: rHex, s: sHex, yParity: sig.recovery_id });
const out = { nearTx: txHash, signedHash: hash, signature: sig, recovered, expected: getAddress(expected),
  match: recovered === getAddress(expected), totalGasBurntTgas: +(gasBurnt / 1e12).toFixed(2),
  receipts: res.receipts_outcome.map(o => ({ executor: o.outcome.executor_id, gasTgas: +(o.outcome.gas_burnt / 1e12).toFixed(2), block: o.block_hash })),
  signedRawTxNotBroadcast: signedTx };
console.log(JSON.stringify(out, null, 1));
if (!out.match) process.exit(1);
