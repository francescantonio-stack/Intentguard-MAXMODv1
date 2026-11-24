import { BASE_SEPOLIA, MONAD_TESTNET } from "./chains";
import type { Sourced } from "./simulate";
import type { QueueEvent } from "./events";
import { blockedEvent } from "./guards";
import { keccak256, stringToHex } from "viem";
import { cappedNumber, isConfigObject } from "./limits";

/** Public testnet endpoints used by the probe page (idea: Railguard). Never mainnet, never user-supplied URLs. */
export const PROBE_NETWORKS = [
  { id: "monad-testnet", kind: "evm" as const, chainId: MONAD_TESTNET.id, name: MONAD_TESTNET.name, rpc: MONAD_TESTNET.rpc, explorer: MONAD_TESTNET.explorer, native: "MON" },
  { id: "base-sepolia", kind: "evm" as const, chainId: BASE_SEPOLIA.id, name: BASE_SEPOLIA.name, rpc: BASE_SEPOLIA.rpc, explorer: BASE_SEPOLIA.explorer, native: "ETH" },
  { id: "near-testnet", kind: "near" as const, chainId: null, name: "near-testnet", rpc: "https://rpc.testnet.near.org", explorer: "https://testnet.nearblocks.io", native: "NEAR" },
] as const;

export type ProbeNetwork = (typeof PROBE_NETWORKS)[number];

/** Default RPC timeout (15s). Hard max is PROBE_MAX.timeoutMs (30s); above that -> BadConfig. */
export const PROBE_DEFAULTS: { timeoutMs: number } = { timeoutMs: 15_000 };
export const PROBE_MAX = { timeoutMs: 30_000 } as const;

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

const failed = (net: ProbeNetwork, error: string, now: number): NetworkProbe => ({
  id: net.id, ok: false, error, native: net.native, rpc: net.rpc, explorer: net.explorer,
  checkedAt: now, event: failEvent(net),
});

async function evmProbe(net: ProbeNetwork, rpc: JsonRpc, now: number, clock: () => number): Promise<NetworkProbe> {
  const t0 = clock();
  const [chainIdHex, blockHex, gasHex] = await Promise.all([
    rpc("eth_chainId", []),
    rpc("eth_blockNumber", []),
    rpc("eth_gasPrice", []).catch(() => undefined),
  ]);
  const latencyMs: Sourced<number> = { value: Math.max(0, clock() - t0), source: `round-trip ${net.rpc}` };
  const chainId = Number(hexToBig(chainIdHex));
  const blockNumber = hexToBig(blockHex);
  const header = (await rpc("eth_getBlockByNumber", [typeof blockHex === "string" ? blockHex : "latest", false])) as { timestamp?: string } | null;
  const ts = header?.timestamp ? Number(hexToBig(header.timestamp)) * 1000 : undefined;
  const blockAgeSec = ts !== undefined
    ? { value: Math.max(0, Math.round((now - ts) / 1000)), source: `eth_getBlockByNumber(${blockNumber}) @ ${net.rpc}` }
    : undefined;
  const okChain = net.chainId == null || chainId === net.chainId;
  return {
    id: net.id, ok: okChain, error: okChain ? undefined : `chainId ${chainId} ≠ atteso ${net.chainId}`,
    event: okChain ? undefined : failEvent(net),
    chainId: { value: chainId, source: `eth_chainId @ ${net.rpc}` },
    blockNumber: { value: blockNumber, source: `eth_blockNumber @ ${net.rpc}` },
    blockAgeSec, latencyMs,
    gasPrice: gasHex !== undefined ? { value: hexToBig(gasHex), source: `eth_gasPrice @ ${net.rpc}` } : undefined,
    native: net.native, rpc: net.rpc, explorer: net.explorer, checkedAt: now,
  };
}

async function nearProbe(net: ProbeNetwork, rpc: JsonRpc, now: number, clock: () => number): Promise<NetworkProbe> {
  const t0 = clock();
  let st: unknown;
  try {
    st = await rpc("status", []);
  } catch (e) {
    return failed(net, e instanceof Error ? e.message : String(e), now);
  }
  const latencyMs: Sourced<number> = { value: Math.max(0, clock() - t0), source: `round-trip ${net.rpc}` };
  if (!st || typeof st !== "object") return { ...failed(net, "status non valido", now), latencyMs };
  const info = (st as { chain_id?: unknown; sync_info?: { latest_block_height?: unknown; latest_block_time?: unknown } }).sync_info;
  const chainIdRaw = (st as { chain_id?: unknown }).chain_id;
  const height = info?.latest_block_height;
  if (typeof height !== "number" || !Number.isFinite(height) || height < 0) {
    return { ...failed(net, "status incompleto: manca latest_block_height", now), latencyMs };
  }
  const t = typeof info?.latest_block_time === "string" ? Date.parse(info.latest_block_time) : undefined;
  const chainSrc = typeof chainIdRaw === "string" ? { value: 0, source: `status.chain_id=${chainIdRaw} @ ${net.rpc}` } : undefined;
  if (chainIdRaw !== "testnet") {
    return {
      ...failed(net, `chain_id ${String(chainIdRaw)} ≠ atteso testnet`, now),
      latencyMs,
      chainId: chainSrc,
    };
  }
  return {
    id: net.id, ok: true,
    chainId: chainSrc,
    blockNumber: { value: BigInt(height), source: `status.sync_info.latest_block_height @ ${net.rpc}` },
    blockAgeSec: t && Number.isFinite(t) ? { value: Math.max(0, Math.round((now - t) / 1000)), source: `status.sync_info.latest_block_time @ ${net.rpc}` } : undefined,
    latencyMs, native: net.native, rpc: net.rpc, explorer: net.explorer, checkedAt: now,
  };
}

export type ProbeFetch = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Read-only JSON-RPC over fetch. Uses AbortController for the timeout and rejects a non-OK HTTP status.
 * `fetchImpl` is injectable for tests (no network).
 */
export function createProbeRpc(net: ProbeNetwork, timeoutMs = PROBE_DEFAULTS.timeoutMs, fetchImpl: ProbeFetch = fetch as unknown as ProbeFetch): JsonRpc {
  return async (method, params = []) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(net.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body && typeof body === "object" && body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
      return body?.result;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Probe one or all known testnets. `rpcFor` is injected in tests; default uses public RPC (read-only). */
export async function probeNetworks(o?: {
  rpcFor?: (net: ProbeNetwork) => JsonRpc;
  ids?: string[];
  now?: number;
  clock?: () => number;
  config?: { timeoutMs?: unknown };
  fetchImpl?: ProbeFetch;
}): Promise<NetworkProbe[]> {
  if (o === undefined) o = {};
  if (o == null || typeof o !== "object") {
    return PROBE_NETWORKS.map((net) => failed(net, "BAD_TX: input non valido", Date.now()));
  }
  const clock = o.clock ?? Date.now;
  const now = o.now !== undefined ? o.now : clock();
  const list = (o.ids === undefined ? PROBE_NETWORKS : PROBE_NETWORKS.filter((n) => o.ids!.includes(n.id))) as ProbeNetwork[];
  if (o.now !== undefined && !Number.isFinite(o.now)) {
    return list.map((net) => ({
      id: net.id, ok: false, error: "BAD_NOW: now non è un numero finito",
      native: net.native, rpc: net.rpc, explorer: net.explorer, checkedAt: Date.now(),
      event: failEvent(net, "BadConfig"),
    }));
  }
  if (o.config !== undefined && o.config !== null && !isConfigObject(o.config)) {
    return list.map((net) => ({
      id: net.id, ok: false, error: "BadConfig: config non valida",
      native: net.native, rpc: net.rpc, explorer: net.explorer, checkedAt: now,
      event: failEvent(net, "BadConfig"),
    }));
  }
  const cap = cappedNumber(o.config?.timeoutMs, PROBE_DEFAULTS.timeoutMs, PROBE_MAX.timeoutMs);
  if (!cap.ok) {
    return list.map((net) => ({
      id: net.id, ok: false, error: `BadConfig: ${cap.detail}`,
      native: net.native, rpc: net.rpc, explorer: net.explorer, checkedAt: now,
      event: failEvent(net, "BadConfig"),
    }));
  }
  const timeoutMs = cap.value;
  const out: NetworkProbe[] = [];
  for (const net of list) {
    const rpc = o.rpcFor?.(net) ?? createProbeRpc(net, timeoutMs, o.fetchImpl);
    try {
      out.push(net.kind === "near" ? await nearProbe(net, rpc, now, clock) : await evmProbe(net, rpc, now, clock));
    } catch (e) {
      out.push(failed(net, e instanceof Error ? e.message : String(e), now));
    }
  }
  return out;
}
