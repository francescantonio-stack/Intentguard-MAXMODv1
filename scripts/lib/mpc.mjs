// Shared helpers: NEAR policy contract calls (near-cli-rs + box-local legacy keychain ~/.near-credentials) and
// MPC-signed EIP-1559 txs from the user's derived EVM address on Monad testnet / Base Sepolia. TESTNET ONLY.
import { createPublicClient, http, serializeTransaction, keccak256, recoverAddress } from 'viem';
import { spawnSync } from 'child_process';

export const POLICY = process.env.POLICY || 'intentguard-973f6c.testnet';
export const USER = process.env.NEAR_USER || 'intentguard-user-973f6c.testnet';
export const DERIVED = process.env.DERIVED || '0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B';
export const CHAINS = {
  monad: { id: 10143, rpc: process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz', explorer: 'https://testnet.monadexplorer.com/tx/', prio: 2_000_000_000n },
  base: { id: 84532, rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org/tx/', prio: 1_000_000n },
};
export const client = (c) => createPublicClient({ transport: http(CHAINS[c].rpc) });
const NEAR_RPC = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';
export const nearExplorer = (h) => `https://testnet.nearblocks.io/txns/${h}`;

export async function nearRpc(method, params) {
  const r = await (await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result;
}
export async function nearView(method, args) {
  const r = await nearRpc('query', { request_type: 'call_function', finality: 'final', account_id: POLICY, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(r.result).toString());
}
/** Function call on the policy contract signed by `signer` (default: the demo user). near-cli-rs prints the tx id on stderr. */
export function nearCall(method, args, { signer = USER, gas = '30 Tgas', deposit = '0 NEAR' } = {}) {
  const cp = spawnSync('near', ['contract', 'call-function', 'as-transaction', POLICY, method, 'json-args', JSON.stringify(args), 'prepaid-gas', gas,
    'attached-deposit', deposit, 'sign-as', signer, 'network-config', 'testnet', 'sign-with-legacy-keychain', 'send'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (cp.stdout || '') + (cp.stderr || '');
  const txId = (out.match(/Transaction ID: ([A-Za-z0-9]+)/) || [])[1];
  const error = (out.match(/policy: [^"\n\\]*/) || out.match(/Smart contract panicked: [^"\n\\]*/) || [null])[0];
  return { txId, error: txId ? null : error || out.slice(-600), out };
}
export async function commitPlan(planHash, usdcBudget, ttlSeconds, maxSignatures) {
  const p = await nearView('get_plan', { user: USER });
  if (p && p.signatures_used < p.max_signatures && p.expires_at_ns > Date.now() * 1e6) nearCall('cancel_plan', {}); // one active plan per user
  const r = nearCall('commit_plan', { plan_hash: planHash, usdc_budget: String(usdcBudget), ttl_seconds: ttlSeconds, max_signatures: maxSignatures });
  if (!r.txId) throw new Error(`commit_plan rejected: ${r.error}`);
  return r.txId;
}

/** Policy check -> request_signature (MPC) -> verify recovered signer -> broadcast -> receipt. */
export async function signAndSend({ chain, plan, to, value = 0n, data = '0x', gas = 'auto', broadcast = true, force = false, log = console.error }) {
  const C = CHAINS[chain], pc = client(chain);
  const nonce = await pc.getTransactionCount({ address: DERIVED, blockTag: 'pending' });
  const base = (await pc.getBlock()).baseFeePerGas;
  const prio = C.prio, maxFee = base * 2n + prio;
  let g = gas === 'auto' ? null : BigInt(gas);
  for (let i = 0; g === null; i++) { // public RPCs are load-balanced: right after a tx a node can still serve the old state
    try { g = (await pc.estimateGas({ account: DERIVED, to, value, data })) * 5n / 4n; }
    catch (e) { if (i >= 5) throw e; await new Promise(s => setTimeout(s, 3000)); }
  }
  const tx = { chain_id: C.id, nonce, max_priority_fee_per_gas: prio.toString(), max_fee_per_gas: maxFee.toString(), gas_limit: Number(g), to, value: value.toString(), data };
  const check = await nearView('check', { user: USER, plan_hash: plan, tx });
  log(`[${chain}] policy check: ${check.ok ? 'ok' : 'REJECT ' + check.reason}`);
  if (!check.ok && !force) throw Object.assign(new Error('policy: ' + check.reason), { rejected: true });
  const t0 = Date.now();
  const r = nearCall('request_signature', { plan_hash: plan, tx }, { gas: '100 Tgas' });
  const res = { chain, tx, nearTx: r.txId, nearSignMs: Date.now() - t0 };
  if (!r.txId) throw Object.assign(new Error(r.error), { rejected: true, res });
  const st = await nearRpc('EXPERIMENTAL_tx_status', { tx_hash: r.txId, sender_account_id: USER, wait_until: 'FINAL' });
  res.nearGasTgas = +((st.transaction_outcome.outcome.gas_burnt + st.receipts_outcome.reduce((s, o) => s + o.outcome.gas_burnt, 0)) / 1e12).toFixed(2);
  const sv = st.status.SuccessValue;
  const sig = sv ? JSON.parse(Buffer.from(sv, 'base64').toString()) : null;
  if (!sig) throw Object.assign(new Error('MPC returned no signature: ' + JSON.stringify(st.status).slice(0, 300)), { res });
  const unsigned = { type: 'eip1559', chainId: C.id, nonce, maxPriorityFeePerGas: prio, maxFeePerGas: maxFee, gas: g, to, value, data };
  const hash = keccak256(serializeTransaction(unsigned));
  const rr = '0x' + sig.big_r.affine_point.slice(2), ss = '0x' + sig.s.scalar;
  const recovered = await recoverAddress({ hash, signature: { r: rr, s: ss, yParity: sig.recovery_id } });
  Object.assign(res, { payload: hash, payloadMatchesCheck: hash === check.payload, recovered, match: recovered.toLowerCase() === DERIVED.toLowerCase() });
  if (!res.match) throw Object.assign(new Error('recovered signer mismatch'), { res });
  if (broadcast) {
    res.txHash = await pc.request({ method: 'eth_sendRawTransaction', params: [serializeTransaction(unsigned, { r: rr, s: ss, yParity: sig.recovery_id })] });
    const rc = await pc.waitForTransactionReceipt({ hash: res.txHash, timeout: 120_000 });
    Object.assign(res, { status: rc.status, gasUsed: Number(rc.gasUsed), block: Number(rc.blockNumber), totalMs: Date.now() - t0, explorer: C.explorer + res.txHash, receipt: rc });
    if (rc.l1Fee) res.l1FeeWei = rc.l1Fee.toString();
    res.feeWei = (rc.gasUsed * rc.effectiveGasPrice + (rc.l1Fee ? BigInt(rc.l1Fee) : 0n)).toString();
    log(`[${chain}] ${res.status} ${res.explorer} (near ${r.txId}, ${res.totalMs} ms)`);
    if (rc.status !== 'success') throw Object.assign(new Error('tx reverted'), { res });
  }
  return res;
}
