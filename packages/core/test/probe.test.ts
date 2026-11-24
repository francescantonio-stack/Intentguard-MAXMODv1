import { describe, expect, it } from "vitest";
import { probeNetworks, PROBE_DEFAULTS, type JsonRpc, type ProbeNetwork } from "../src/probe";

const evm: Record<string, unknown> = {
  eth_chainId: "0x279f", // 10143
  eth_blockNumber: "0x10",
  eth_gasPrice: "0x3b9aca00",
  eth_getBlockByNumber: { timestamp: "0x69" },
};

describe("probeNetworks", () => {
  it("returns every number with its RPC source (mocked, no network)", async () => {
    const rpcFor = (net: ProbeNetwork): JsonRpc => async (method) => {
      if (net.kind === "near") {
        if (method === "status") return { chain_id: "testnet", sync_info: { latest_block_height: 99, latest_block_time: new Date(1_700_000_000_000).toISOString() } };
        throw new Error(method);
      }
      if (method === "eth_chainId") return net.id === "base-sepolia" ? "0x14a34" : evm.eth_chainId;
      if (method in evm) return evm[method];
      throw new Error(method);
    };
    const rows = await probeNetworks({ rpcFor, now: Date.now() });
    expect(rows.map((r) => r.id)).toEqual(["monad-testnet", "base-sepolia", "near-testnet"]);
    expect(rows.every((r) => r.ok)).toBe(true);
    const m = rows[0]!;
    expect(m.chainId).toEqual({ value: 10143, source: "eth_chainId @ https://testnet-rpc.monad.xyz" });
    expect(m.blockNumber?.value).toBe(16n);
    expect(m.blockNumber?.source).toMatch(/^eth_blockNumber @ /);
    expect(m.gasPrice?.value).toBe(1_000_000_000n);
    expect(m.gasPrice?.source).toMatch(/^eth_gasPrice @ /);
    expect(m.latencyMs?.source).toMatch(/^round-trip /);
    expect(m.blockAgeSec?.source).toMatch(/^eth_getBlockByNumber/);
    const n = rows[2]!;
    expect(n.blockNumber?.value).toBe(99n);
    expect(n.blockNumber?.source).toMatch(/latest_block_height/);
  });

  it("marks the probe failed when the chain id does not match, and when the RPC throws", async () => {
    const bad: JsonRpc = async (method) => (method === "eth_chainId" ? "0x1" : evm[method]);
    const boom: JsonRpc = async () => { throw new Error("rpc down"); };
    const rows = await probeNetworks({
      ids: ["monad-testnet", "base-sepolia"],
      rpcFor: (net) => (net.id === "monad-testnet" ? bad : boom),
    });
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.error).toMatch(/chainId 1/);
    expect(rows[1]?.ok).toBe(false);
    expect(rows[1]?.error).toBe("rpc down");
    expect(rows[0]?.event).toMatchObject({ kind: "blocked", reason: "SimUnavailable", id: null });
    expect(rows[0]?.event?.planId.startsWith("0x")).toBe(true);
    expect(rows[0]?.event?.planId).toBe(rows[0]!.event!.planId.toLowerCase());
    expect(typeof rows[0]?.event?.amount).toBe("bigint");
    expect(rows[1]?.event?.reason).toBe("SimUnavailable");
  });
});

describe("config limits", () => {
  const rpcFor = (net: ProbeNetwork): JsonRpc => async (method) => {
    if (net.kind === "near") return { chain_id: "testnet", sync_info: { latest_block_height: 1, latest_block_time: new Date().toISOString() } };
    if (method === "eth_chainId") return net.id === "base-sepolia" ? "0x14a34" : "0x279f";
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_gasPrice") return "0x1";
    if (method === "eth_getBlockByNumber") return { timestamp: "0x1" };
    throw new Error(method);
  };

  it("blocks a loosened timeout or invalid config (BadConfig) without calling the RPC", async () => {
    const rows = await probeNetworks({ rpcFor, ids: ["monad-testnet"], config: { timeoutMs: PROBE_DEFAULTS.timeoutMs + 1 } });
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.event?.reason).toBe("BadConfig");
    expect(rows[0]?.error).toMatch(/BadConfig/);
    for (const config of [null, { timeoutMs: NaN }, { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: "1000" }, { timeoutMs: -0 }] as const) {
      const r = await probeNetworks({ rpcFor, ids: ["monad-testnet"], config: config as never });
      expect(r[0]?.ok, String(config)).toBe(false);
      expect(r[0]?.event?.reason).toBe("BadConfig");
    }
  });

  it("accepts a tighter timeout and still probes with a mock RPC", async () => {
    const rows = await probeNetworks({ rpcFor, ids: ["monad-testnet"], config: { timeoutMs: 1_000 } });
    expect(rows[0]?.ok).toBe(true);
  });
});
