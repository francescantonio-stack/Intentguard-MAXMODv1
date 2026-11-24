import { BASE_SEPOLIA, MONAD_TESTNET } from "./chains";
import type { Sourced } from "./simulate";
import { blockedEvent, type QueueEvent } from "./events";
import { keccak256, stringToHex } from "viem";
import { tightenNumber } from "./limits";

/** Public testnet endpoints used by the probe page (idea: Railguard). Never mainnet, never user-supplied URLs. */
export const PROBE_NETWORKS = [
  { id: "monad-testnet", kind: "evm" as const, chainId: MONAD_TESTNET.id, name: MONAD_TESTNET.name, rpc: MONAD_TESTNET.rpc, explorer: MONAD_TESTNET.explorer, native: "MON" },
  { id: "base-sepolia", kind: "evm" as const, chainId: BASE_SEPOLIA.id, name: BASE_SEPOLIA.name, rpc: BASE_SEPOLIA.rpc, explorer: BASE_SEPOLIA.explorer, native: "ETH" },
  { id: "near-testnet", kind: "near" as const, chainId: null, name: "near-testnet", rpc: "https://rpc.testnet.near.org", explorer: "https://testnet.nearblocks.io", native: "NEAR" },
] as const;

export type ProbeNetwork = (typeof PROBE_NETWORKS)[number];

/** Default RPC timeout. Input may only lower it. */
export const PROBE_DEFAULTS: { timeoutMs: number } = { timeoutMs: 15_000 };

export type JsonRpc = (method: string, params?: unknown[]) => Promise<unknown>;

export type NetworkProbe = {
  id: string;
  ok: boolean;
  error?: string;
  chainId?: Sourced<number>;
  blockNumber?: Sourced<bigint>;
  blockAgeSec?: Sourced<number>;
  latencyMs?: Sourced<number>;
  gasPrice?: Sourced<bigint>;
  native: string;
  rpc: string;
  explorer: string;
  checkedAt: number;
  event?: QueueEvent;
};

const probePlanId = (id: string) => keccak256(stringToHex(`probe:${id}`));

const failEvent = (net: ProbeNetwork, reason = "SimUnavailable"): QueueEvent =>
  blockedEvent({ planId: probePlanId(net.id), reason, amount: 0n });

const hexToBig = (x: unknown): bigint => BigInt(typeof x === "string" ? x : "0x0");

async function evmProbe(net: ProbeNetwork, rpc: JsonRpc, now: number): Promise<NetworkProbe> {
  const t0 = now;
  const [chainIdHex, blockHex, gasHex] = await Promise.all([
    rpc("eth_chainId", []),
    rpc("eth_blockNumber", []),
    rpc("eth_gasPrice", []).catch(() => undefined),
  ]);
  const latencyMs: Sourced<number> = { value: Math.max(0, Date.now() - t0), source: `round-trip ${net.rpc}` };
  const chainId = Number(hexToBig(chainIdHex));
  const blockNumber = hexToBig(blockHex);
  const header = (await rpc("eth_getBlockByNumber", [typeof blockHex === "string" ? blockHex : "latest", false])) as { timestamp?: string } | null;
  const ts = header?.timestamp ? Number(hexToBig(header.timestamp)) * 1000 : undefined;
  const blockAgeSec = ts !== undefined
    ? { value: Math.max(0, Math.round((Date.now() - ts) / 1000)), source: `eth_getBlockByNumber(${blockNumber}) @ ${net.rpc}` }
    : undefined;
  const okChain = net.chainId == null || chainId === net.chainId;
  return {
    id: net.id, ok: okChain, error: okChain ? undefined : `chainId ${chainId} ≠ atteso ${net.chainId}`,
    event: okChain ? undefined : failEvent(net),
    chainId: { value: chainId, source: `eth_chainId @ ${net.rpc}` },
    blockNumber: { value: blockNumber, source: `eth_blockNumber @ ${net.rpc}` },
    blockAgeSec, latencyMs,
    gasPrice: gasHex !== undefined ? { value: hexToBig(gasHex), source: `eth_gasPrice @ ${net.rpc}` } : undefined,
    native: net.native, rpc: net.rpc, explorer: net.explorer, checkedAt: Date.now(),
  };
}

async function nearProbe(net: ProbeNetwork, rpc: JsonRpc, now: number): Promise<NetworkProbe> {
  const t0 = now;
  const st = (await rpc("status", [])) as { chain_id?: string; sync_info?: { latest_block_height?: number; latest_block_time?: string } };
  const latencyMs: Sourced<number> = { value: Math.max(0, Date.now() - t0), source: `round-trip ${net.rpc}` };
  const height = st.sync_info?.latest_block_height;
  const t = st.sync_info?.latest_block_time ? Date.parse(st.sync_info.latest_block_time) : undefined;
  return {
    id: net.id, ok: true,
    chainId: st.chain_id ? { value: 0, source: `status.chain_id=${st.chain_id} @ ${net.rpc}` } : undefined,
    blockNumber: height !== undefined ? { value: BigInt(height), source: `status.sync_info.latest_block_height @ ${net.rpc}` } : undefined,
    blockAgeSec: t ? { value: Math.max(0, Math.round((Date.now() - t) / 1000)), source: `status.sync_info.latest_block_time @ ${net.rpc}` } : undefined,
    latencyMs, native: net.native, rpc: net.rpc, explorer: net.explorer, checkedAt: Date.now(),
  };
}

/** Probe one or all known testnets. `rpcFor` is injected in tests; default uses public RPC (read-only). */
export async function probeNetworks(o: { rpcFor?: (net: ProbeNetwork) => JsonRpc; ids?: string[]; now?: number; config?: { timeoutMs?: unknown } } = {}): Promise<NetworkProbe[]> {
  const now = o.now ?? Date.now();
  const list = PROBE_NETWORKS.filter((n) => !o.ids || o.ids.includes(n.id));
  const cap = tightenNumber(o.config?.timeoutMs, PROBE_DEFAULTS.timeoutMs, true);
  if (!cap.ok || (o.config !== undefined && (o.config == null || typeof o.config !== "object" || Array.isArray(o.config)))) {
    return list.map((net) => ({
      id: net.id, ok: false, error: cap.ok ? "BadConfig: config non valida" : `BadConfig: ${cap.detail}`,
      native: net.native, rpc: net.rpc, explorer: net.explorer, checkedAt: Date.now(),
      event: failEvent(net, "BadConfig"),
    }));
  }
  const timeoutMs = cap.value;
  const out: NetworkProbe[] = [];
  for (const net of list) {
    const rpc = o.rpcFor?.(net) ?? defaultRpc(net, timeoutMs);
    try {
      out.push(net.kind === "near" ? await nearProbe(net, rpc, now) : await evmProbe(net, rpc, now));
    } catch (e) {
      out.push({ id: net.id, ok: false, error: e instanceof Error ? e.message : String(e), native: net.native, rpc: net.rpc, explorer: net.explorer, checkedAt: Date.now(), event: failEvent(net) });
    }
  }
  return out;
}

function defaultRpc(net: ProbeNetwork, timeoutMs = PROBE_DEFAULTS.timeoutMs): JsonRpc {
  return async (method, params = []) => {
    const res = await fetch(net.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
    return body.result;
  };
}
