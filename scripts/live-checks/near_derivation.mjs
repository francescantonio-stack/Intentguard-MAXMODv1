// Read-only: derives the EVM address controlled via NEAR Chain Signatures for a sample
// (predecessor, path) in two independent ways and checks they match:
//  (a) offline: chainsig.js epsilon derivation from the hard-coded testnet root key
//  (b) online:  view call `derived_public_key` on v1.signer-prod.testnet (NEAR testnet RPC)
// Also checks the hard-coded root key equals the contract's live `public_key`.
import { utils, constants } from 'chainsig.js';
import { keccak256, getAddress } from 'viem';

const MPC = 'v1.signer-prod.testnet';
const PREDECESSOR = process.env.PREDECESSOR ?? 'intentguard-policy.testnet'; // our future policy contract account (example)
const PATH = process.env.DERIVATION_PATH ?? 'maxz-demo.testnet,evm,1';         // "<user_account_id>,evm,1"
const RPCS = ['https://rpc.testnet.near.org', 'https://test.rpc.fastnear.com', 'https://rpc.testnet.fastnear.com'];

const { cryptography } = utils;
const toAddr = (unc) => getAddress('0x' + keccak256(('0x' + unc.slice(2))).slice(-40));

async function view(method, args) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'query', params: {
          request_type: 'call_function', finality: 'final', account_id: MPC, method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
      const j = await res.json();
      if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error).slice(0, 300));
      return { url, value: JSON.parse(Buffer.from(j.result.result).toString()) };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const out = { mpcContract: MPC, predecessor: PREDECESSOR, path: PATH };
const rootNaj = constants.ROOT_PUBLIC_KEYS.TESTNET.secp256k1;
const rootUnc = cryptography.najToUncompressedPubKeySEC1(rootNaj);
const offline = cryptography.deriveChildPublicKey(rootUnc, PREDECESSOR, PATH);
out.offline = { publicKey: offline, evmAddress: toAddr(offline) };

try {
  const live = await view('public_key', { domain_id: 0 }).catch(() => view('public_key', {}));
  out.liveRootKey = { rpc: live.url, value: live.value, matchesChainsigConstant: live.value === rootNaj };
} catch (e) { out.liveRootKey = { error: String(e.message ?? e) }; }

try {
  const d = await view('derived_public_key', { path: PATH, predecessor: PREDECESSOR, domain_id: 0 });
  const unc = cryptography.najToUncompressedPubKeySEC1(d.value);
  out.online = { rpc: d.url, naj: d.value, evmAddress: toAddr(unc) };
  out.match = out.online.evmAddress === out.offline.evmAddress;
} catch (e) { out.online = { error: String(e.message ?? e) }; }

console.log(JSON.stringify(out, null, 1));
if (out.match === false) process.exit(1);
