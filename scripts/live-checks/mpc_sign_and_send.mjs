// CLI wrapper around lib/mpc.mjs signAndSend (REAL testnet txs from the derived address via NEAR policy + MPC).
// Usage: node mpc_sign_and_send.mjs --plan 0x.. --to 0x.. [--chain monad|base] [--value wei] [--data 0x..] [--gas N|auto] [--force] [--no-broadcast]
import { signAndSend } from '../lib/mpc.mjs';
const a = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => { const [k, ...v] = s.trim().split(' '); return [k, v.join(' ') || true]; }));
try {
  const res = await signAndSend({ chain: a.chain || 'monad', plan: a.plan, to: a.to, value: BigInt(a.value || 0), data: a.data || '0x', gas: a.gas || 'auto', force: !!a.force, broadcast: !a['no-broadcast'] });
  delete res.receipt;
  console.log(JSON.stringify(res, null, 1));
} catch (e) { console.log(JSON.stringify({ error: e.message, ...(e.res || {}) }, null, 1)); process.exit(e.rejected ? 3 : 1); }
