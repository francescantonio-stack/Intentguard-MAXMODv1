import { describe, expect, it } from "vitest";
import { probeNetworks, createProbeRpc, PROBE_DEFAULTS, PROBE_NETWORKS, type JsonRpc, type ProbeNetwork } from "../src/probe";

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


describe("nearProbe, clock and fetch", () => {
  it("reports ok:false when NEAR status is missing or the RPC throws", async () => {
    const empty = await probeNetworks({ ids: ["near-testnet"], rpcFor: () => async () => ({}), now: 1_700_000_000_000 });
    expect(empty[0]?.ok).toBe(false);
    expect(empty[0]?.error).toMatch(/incompleto|height/);
    expect(empty[0]?.event?.reason).toBe("SimUnavailable");
    const boom = await probeNetworks({ ids: ["near-testnet"], rpcFor: () => async () => { throw new Error("near down"); } });
    expect(boom[0]?.ok).toBe(false);
    expect(boom[0]?.error).toBe("near down");
  });

  it("measures latency with the injected clock, not Date.now()", async () => {
    let t = 1_000;
    const clock = () => { t += 25; return t; };
    const rpcFor = (): JsonRpc => async (method) => {
      if (method === "eth_chainId") return "0x279f";
      if (method === "eth_blockNumber") return "0x10";
      if (method === "eth_gasPrice") return "0x1";
      if (method === "eth_getBlockByNumber") return { timestamp: "0x1" };
      throw new Error(method);
    };
    const rows = await probeNetworks({ ids: ["monad-testnet"], rpcFor, now: 1_700_000_000_000, clock });
    expect(rows[0]?.ok).toBe(true);
    expect(rows[0]?.latencyMs?.value).toBeGreaterThan(0);
    expect(rows[0]?.checkedAt).toBe(1_700_000_000_000);
  });

  it("reports ok:false when NEAR chain_id is not testnet", async () => {
    const main = await probeNetworks({
      ids: ["near-testnet"],
      now: 1_700_000_000_000,
      rpcFor: () => async () => ({ chain_id: "mainnet", sync_info: { latest_block_height: 99, latest_block_time: new Date(1_700_000_000_000).toISOString() } }),
    });
    expect(main[0]?.ok).toBe(false);
    expect(main[0]?.error).toMatch(/chain_id/);
    expect(main[0]?.event?.reason).toBe("SimUnavailable");
    const missing = await probeNetworks({
      ids: ["near-testnet"],
      now: 1_700_000_000_000,
      rpcFor: () => async () => ({ sync_info: { latest_block_height: 99, latest_block_time: new Date(1_700_000_000_000).toISOString() } }),
    });
    expect(missing[0]?.ok).toBe(false);
    expect(missing[0]?.error).toMatch(/chain_id/);
  });

  it("createProbeRpc rejects a non-OK HTTP status and honors AbortController timeout", async () => {
    const net = PROBE_NETWORKS[0]!;
    const http = createProbeRpc(net, 5_000, async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(http("eth_chainId")).rejects.toThrow(/HTTP 503/);
    const ok = createProbeRpc(net, 5_000, async () => ({ ok: true, status: 200, json: async () => ({ result: "0x1" }) }));
    expect(await ok("eth_chainId")).toBe("0x1");
  });
});

describe("probeNetworks input", () => {
  it("treats a missing argument as {} and does not return BAD_TX on every network", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: string, init: { body?: string }) => {
      const method = JSON.parse(String(init.body)).method;
      const url = String(input);
      let result: unknown = "0x0";
      if (method === "eth_chainId") result = url.includes("base") ? "0x14a34" : "0x279f";
      else if (method === "eth_blockNumber") result = "0x10";
      else if (method === "eth_gasPrice") result = "0x1";
      else if (method === "eth_getBlockByNumber") result = { timestamp: "0x1" };
      else if (method === "status") result = { chain_id: "testnet", sync_info: { latest_block_height: 1, latest_block_time: new Date().toISOString() } };
      return { ok: true, status: 200, json: async () => ({ result }) };
    }) as typeof fetch;
    try {
      const rows = await probeNetworks();
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => (r.error ?? "").startsWith("BAD_TX"))).toBe(false);
      expect(rows.every((r) => r.ok === true), rows.map((r) => `${r.id}:${r.error}`).join(",")).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("returns every network blocked, without RPC, when the input is null or not an object", async () => {
    for (const input of [null, 0, "x"] as const) {
      const rows = await probeNetworks(input as never);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.ok === false), String(input)).toBe(true);
      expect(rows[0]?.error, String(input)).toMatch(/BAD_TX/);
      expect(rows[0]?.event?.reason).toBe("SimUnavailable");
    }
  });
});
