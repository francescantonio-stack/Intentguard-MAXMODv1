// REAL testnet flow: asks the IntentGuard policy contract (NEAR testnet) to get an MPC signature for an
// EIP-1559 tx from the user's derived EVM address, verifies the recovered signer, then (unless --no-broadcast)
// broadcasts it to Monad testnet. Uses near-cli-rs + the box-local legacy keychain (~/.near-credentials).
// Usage: node mpc_sign_and_send.mjs --plan 0x.. --to 0x.. [--value wei] [--data 0x..] [--gas N|auto] [--force] [--no-broadcast]
import { createPublicClient, http, serializeTransaction, keccak256, recoverAddress } from 'viem';
import { spawnSync } from 'child_process';
import fs from 'fs';
const a = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => { const [k, ...v] = s.trim().split(' '); return [k, v.join(' ') || true]; }));
const POLICY = process.env.POLICY || 'intentguard-973f6c.testnet', USER = process.env.NEAR_USER || 'intentguard-user-973f6c.testnet';
const FROM = process.env.DERIVED || '0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B';
const NEAR_RPC = 'https://rpc.testnet.near.org';
const pc = createPublicClient({ transport: http('https://testnet-rpc.monad.xyz') });
const nearRpc = async (method, params) => (await (await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
const data = a.data || '0x', value = BigInt(a.value || 0);
const nonce = await pc.getTransactionCount({ address: FROM, blockTag: 'pending' });
const base = (await pc.getBlock()).baseFeePerGas;
const prio = 2_000_000_000n, maxFee = base * 3n / 2n + prio;
let gas = a.gas && a.gas !== 'auto' ? BigInt(a.gas) : (await pc.estimateGas({ account: FROM, to: a.to, value, data })) * 5n / 4n;
const tx = { chain_id: 10143, nonce, max_priority_fee_per_gas: prio.toString(), max_fee_per_gas: maxFee.toString(), gas_limit: Number(gas), to: a.to, value: value.toString(), data };
const args = { plan_hash: a.plan, tx };
const chk = await nearRpc('query', { request_type: 'call_function', finality: 'final', account_id: POLICY, method_name: 'check', args_base64: Buffer.from(JSON.stringify({ user: USER, ...args })).toString('base64') });
const check = JSON.parse(Buffer.from(chk.result.result).toString());
console.error('policy check:', JSON.stringify(check));
if (!check.ok && !a.force) process.exit(2);
const t0 = Date.now();
const cp = spawnSync('near', ['contract', 'call-function', 'as-transaction', POLICY, 'request_signature', 'json-args', JSON.stringify(args),
  'prepaid-gas', '100 Tgas', 'attached-deposit', '0 NEAR', 'sign-as', USER, 'network-config', 'testnet', 'sign-with-legacy-keychain', 'send'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const out = (cp.stdout || '') + (cp.stderr || ''); // near-cli-rs prints the Transaction ID on stderr
const nearTx = (out.match(/Transaction ID: ([A-Za-z0-9]+)/) || [])[1];
const t1 = Date.now();
const res = { tx, nearTx, nearCliMs: t1 - t0 };
if (!nearTx) { res.rejected = (out.match(/policy: [^"\n\\]*/) || [out.slice(-800)])[0]; console.log(JSON.stringify(res, null, 1)); fs.appendFileSync('/tmp/ig_runs.jsonl', JSON.stringify(res) + '\n'); process.exit(3); }
const st = (await nearRpc('EXPERIMENTAL_tx_status', { tx_hash: nearTx, sender_account_id: USER, wait_until: 'FINAL' })).result;
const sv = st.status.SuccessValue;
const sig = sv ? JSON.parse(Buffer.from(sv, 'base64').toString()) : null;
res.nearGasTgas = +((st.transaction_outcome.outcome.gas_burnt + st.receipts_outcome.reduce((s, o) => s + o.outcome.gas_burnt, 0)) / 1e12).toFixed(2);
if (!sig) { res.rejected = JSON.stringify(st.status).slice(0, 300); console.log(JSON.stringify(res, null, 1)); process.exit(3); }
const unsigned = { type: 'eip1559', chainId: 10143, nonce, maxPriorityFeePerGas: prio, maxFeePerGas: maxFee, gas, to: a.to, value, data };
const hash = keccak256(serializeTransaction(unsigned));
const r = '0x' + sig.big_r.affine_point.slice(2), s = '0x' + sig.s.scalar;
const recovered = await recoverAddress({ hash, signature: { r, s, yParity: sig.recovery_id } });
Object.assign(res, { payload: hash, payloadMatchesCheck: hash === check.payload, recovered, match: recovered.toLowerCase() === FROM.toLowerCase() });
const raw = serializeTransaction(unsigned, { r, s, yParity: sig.recovery_id });
if (res.match && !a['no-broadcast']) {
  res.monadTx = await pc.request({ method: 'eth_sendRawTransaction', params: [raw] });
  const rc = await pc.waitForTransactionReceipt({ hash: res.monadTx, timeout: 60_000 });
  Object.assign(res, { monadStatus: rc.status, monadGasUsed: Number(rc.gasUsed), monadBlock: Number(rc.blockNumber), totalMs: Date.now() - t0, explorer: `https://testnet.monadexplorer.com/tx/${res.monadTx}` });
}
fs.appendFileSync('/tmp/ig_runs.jsonl', JSON.stringify(res) + '\n');
console.log(JSON.stringify(res, null, 1));
if (!res.match || (res.monadStatus && res.monadStatus !== 'success')) process.exit(1);
