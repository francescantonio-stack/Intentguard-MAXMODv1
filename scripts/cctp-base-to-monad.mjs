// REAL Circle CCTP V2 leg Base Sepolia (domain 6) -> Monad testnet (domain 15), every tx from the user's derived
// EVM address signed via the NEAR policy contract + MPC Chain Signatures (scripts/lib/mpc.mjs). TESTNET ONLY.
//   node cctp-base-to-monad.mjs --amount 2 [--standard] [--execute]
// --execute = full demo in one go: one NEAR plan (plan_hash = PlanExecutor.planHash(plan), approved with the TEST
// passkey) covering approve+burn (Base) -> receiveMessage (Monad) -> approve+PlanExecutor.execute (swap half to MON,
// deposit the rest in DemoVault). mintRecipient = the derived address itself (PlanExecutor pulls from plan.account).
import { encodeFunctionData, parseAbi, keccak256, toHex, pad } from 'viem';
import { spawnSync } from 'child_process';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { signAndSend, commitPlan, nearView, client, CHAINS, DERIVED, USER, nearExplorer } from './lib/mpc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const a = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => { const [k, ...v] = s.trim().split(' '); return [k, v.join(' ') || true]; }));
const deployments = JSON.parse(fs.readFileSync(path.join(HERE, '../deployments/monad-testnet.json'), 'utf8'));
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e', MONAD_USDC = deployments.usdc;
const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', MESSAGE_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275';
const EX = deployments.contracts.PlanExecutor.address, POOL = deployments.contracts.MiniSwap.address;
const IRIS = process.env.IRIS_API || 'https://iris-api-sandbox.circle.com';
const SRC = 6, DST = 15;
const amount = BigInt(Math.round(Number(a.amount || 2) * 1e6));
const fast = !a.standard, execute = !!a.execute;
const abi = parseAbi([
  'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
  'function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold)',
  'function receiveMessage(bytes message,bytes attestation) returns (bool)',
  'function nonces(address) view returns (uint256)', 'function getAmountOut(address,uint256) view returns (uint256)',
  'function planHash((address account,uint256 amountIn,uint256 swapAmount,uint256 minAmountOut,bool unwrap,uint256 nonce,uint256 deadline) plan) view returns (bytes32)',
  'function execute((address account,uint256 amountIn,uint256 swapAmount,uint256 minAmountOut,bool unwrap,uint256 nonce,uint256 deadline) plan,(bytes authenticatorData,string clientDataJSON,uint256 challengeIndex,uint256 typeIndex,bytes32 r,bytes32 s) auth)',
]);
const base = client('base'), monad = client('monad');
const rd = (pc, address, functionName, args) => pc.readContract({ address, abi, functionName, args });
const enc = (functionName, args) => encodeFunctionData({ abi, functionName, args });
const log = (...m) => console.error(new Date().toISOString().slice(11, 19), ...m);
const T0 = Date.now(), out = { date: new Date().toISOString(), amount: amount.toString(), mode: fast ? 'fast' : 'standard', mintRecipient: DERIVED, steps: [] };
const step = (name, r) => { const { receipt, ...rest } = r; out.steps.push({ step: name, txHash: rest.txHash, explorer: rest.explorer, nearTx: rest.nearTx, nearExplorer: rest.nearTx && nearExplorer(rest.nearTx), gasUsed: rest.gasUsed, feeWei: rest.feeWei, totalMs: rest.totalMs }); return receipt; };

// ---- fees (fast transfer: minFinalityThreshold 1000 + maxFee >= Circle's minimum fee) ----
const fees = await (await fetch(`${IRIS}/v2/burn/USDC/fees/${SRC}/${DST}`)).json();
const threshold = fast ? 1000 : 2000;
const bps = fees.find(f => f.finalityThreshold === threshold)?.minimumFee ?? 0;
const maxFee = fast ? BigInt(Math.ceil(Number(amount) * bps / 10000)) * 2n + 1n : 0n;
Object.assign(out, { minFinalityThreshold: threshold, circleMinFeeBps: bps, maxFee: maxFee.toString() });
log(`amount ${amount} | ${out.mode} | Circle min fee ${bps} bps -> maxFee ${maxFee}`);

const [ethBefore, baseUsdcBefore, monUsdcBefore, user] = await Promise.all([base.getBalance({ address: DERIVED }), rd(base, BASE_USDC, 'balanceOf', [DERIVED]), rd(monad, MONAD_USDC, 'balanceOf', [DERIVED]), nearView('get_user', { user: USER })]);
if (baseUsdcBefore < amount) throw new Error(`not enough Base Sepolia USDC: ${baseUsdcBefore}`);
if (BigInt(user.remaining) < amount) throw new Error(`NEAR policy weekly cap: remaining ${user.remaining} < ${amount} (raise it with set_weekly_cap, 1 yocto)`);

// ---- plan: approved once (passkey), committed once on NEAR, covers every signature of the flow ----
let plan, planHash, auth;
if (execute) {
  const amountIn = amount - maxFee, swapAmount = amountIn / 2n; // always <= minted amount
  const quote = await rd(monad, POOL, 'getAmountOut', [MONAD_USDC, swapAmount]);
  plan = { account: DERIVED, amountIn, swapAmount, minAmountOut: quote * 99n / 100n, unwrap: true, nonce: await rd(monad, EX, 'nonces', [DERIVED]), deadline: BigInt(Math.floor(Date.now() / 1000) + 1800) };
  planHash = await rd(monad, EX, 'planHash', [plan]);
  const pk = spawnSync('python3', [path.join(HERE, 'live-checks/test_passkey.py'), 'assert', planHash], { encoding: 'utf8' });
  if (pk.status !== 0) throw new Error(pk.stderr);
  const j = JSON.parse(pk.stdout); auth = { ...j, challengeIndex: BigInt(j.challengeIndex), typeIndex: BigInt(j.typeIndex) };
  out.plan = Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
} else {
  planHash = keccak256(toHex(JSON.stringify({ kind: 'cctp-v2', src: SRC, dst: DST, amount: amount.toString(), mintRecipient: DERIVED, ts: Date.now() })));
}
const allowance = await rd(base, BASE_USDC, 'allowance', [DERIVED, TOKEN_MESSENGER]);
const needApprove = allowance < amount;
out.planHash = planHash;
out.nearCommitPlan = await commitPlan(planHash, amount, 1800, (needApprove ? 3 : 2) + (execute ? 2 : 0));
log(`plan ${planHash} committed on NEAR: ${out.nearCommitPlan}`);

// ---- Base Sepolia: approve (only if needed) + depositForBurn ----
if (needApprove) step('base: USDC.approve(TokenMessengerV2)', await signAndSend({ chain: 'base', plan: planHash, to: BASE_USDC, data: enc('approve', [TOKEN_MESSENGER, amount]), log }));
const burnRc = step('base: TokenMessengerV2.depositForBurn', await signAndSend({ chain: 'base', plan: planHash, to: TOKEN_MESSENGER, log,
  data: enc('depositForBurn', [amount, DST, pad(DERIVED, { size: 32 }), BASE_USDC, pad('0x', { size: 32 }), maxFee, threshold]) }));
const tBurn = Date.now();

// ---- Circle Iris (sandbox): wait for the attestation ----
let msg;
for (let i = 0; i < 400; i++) {
  const r = await fetch(`${IRIS}/v2/messages/${SRC}?transactionHash=${burnRc.transactionHash}`);
  if (r.ok) { const m = (await r.json()).messages?.[0]; if (m?.status === 'complete' && m.attestation?.startsWith('0x')) { msg = m; break; } }
  await new Promise(s => setTimeout(s, 3000));
}
if (!msg) throw new Error('attestation timeout');
out.attestationMs = Date.now() - tBurn;
out.cctpFeeExecuted = msg.decodedMessage?.decodedMessageBody?.feeExecuted;
log(`attestation after ${out.attestationMs} ms`);

// ---- Monad: receiveMessage (mints USDC to the derived address) ----
step('monad: MessageTransmitterV2.receiveMessage', await signAndSend({ chain: 'monad', plan: planHash, to: MESSAGE_TRANSMITTER, data: enc('receiveMessage', [msg.message, msg.attestation]), log }));
const monUsdcAfterMint = await rd(monad, MONAD_USDC, 'balanceOf', [DERIVED]);
out.mintedOnMonad = (monUsdcAfterMint - monUsdcBefore).toString();
out.cctpEndToEndMs = Date.now() - T0;

// ---- optional: PlanExecutor (swap half to MON, deposit the rest) ----
if (execute) {
  step('monad: USDC.approve(PlanExecutor)', await signAndSend({ chain: 'monad', plan: planHash, to: MONAD_USDC, data: enc('approve', [EX, plan.amountIn]), log }));
  step('monad: PlanExecutor.execute', await signAndSend({ chain: 'monad', plan: planHash, to: EX, data: enc('execute', [plan, auth]), log }));
}
const [ethAfter, monUsdcEnd, monMon] = await Promise.all([base.getBalance({ address: DERIVED }), rd(monad, MONAD_USDC, 'balanceOf', [DERIVED]), monad.getBalance({ address: DERIVED })]);
Object.assign(out, { totalMs: Date.now() - T0, baseEthSpentWei: (ethBefore - ethAfter).toString(), baseEthLeftWei: ethAfter.toString(), monadUsdcEnd: monUsdcEnd.toString(), monadMonEndWei: monMon.toString() });
const f = path.join(HERE, '../deployments/cctp-runs.json');
const runs = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
runs.push(out); fs.writeFileSync(f, JSON.stringify(runs, null, 2) + '\n');
console.log(JSON.stringify(out, null, 1));
