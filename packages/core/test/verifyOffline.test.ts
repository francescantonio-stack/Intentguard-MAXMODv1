import { describe, expect, it } from "vitest";
import { MONAD_TESTNET } from "../src/chains";
import { planHash } from "../src/planHash";
import { verifyOffline, formatReport, parseJsonAmount, VERIFY_DEFAULTS, VERIFY_MAX } from "../src/verifyOffline";
import { VECTOR } from "./fixtures";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HASH = VECTOR.expected;
const exec = MONAD_TESTNET.planExecutor;
const chainId = MONAD_TESTNET.id;
const amount = VECTOR.plan.amountIn;

const planJson = {
  plan: {
    account: VECTOR.plan.account,
    amountIn: "1000000",
    swapAmount: "500000",
    minAmountOut: "123456789",
    unwrap: true,
    nonce: "7",
    deadline: "1800000000",
  },
  chainId,
  executor: exec,
  planHash: HASH,
};

const ev = (over: Record<string, unknown> = {}) => ({
  kind: "queued",
  planId: HASH,
  reason: "",
  amount: "1000000",
  ts: "2026-11-24T06:00:00.000Z",
  id: "q1",
  ...over,
});

const happyEvents = [
  ev(),
  ev({ kind: "approved", ts: "2026-11-24T06:00:01.000Z", id: "q1" }),
  ev({ kind: "consumed", ts: "2026-11-24T06:00:02.000Z", id: "q1" }),
];

describe("parseJsonAmount", () => {
  it("accepts bigint, decimal strings and integers; rejects negatives and junk", () => {
    expect(parseJsonAmount(0n)).toBe(0n);
    expect(parseJsonAmount("1000000")).toBe(1_000_000n);
    expect(parseJsonAmount(7)).toBe(7n);
    expect(parseJsonAmount(-1n)).toBeNull();
    expect(parseJsonAmount("-1")).toBeNull();
    expect(parseJsonAmount("1.5")).toBeNull();
    expect(parseJsonAmount("foo")).toBeNull();
  });
});

describe("verifyOffline planHash", () => {
  it("reuses planHash() and PASSes the official vector", () => {
    expect(planHash(VECTOR.plan, chainId, exec)).toBe(HASH);
    const r = verifyOffline(planJson);
    expect(r.ok).toBe(true);
    expect(r.computedPlanHash).toBe(HASH);
    expect(formatReport(r)).toMatch(/PASS planHash/);
    expect(formatReport(r)).toMatch(/RESULT PASS/);
  });

  it("fails when the claimed hash does not match, or the plan is malformed", () => {
    const wrong = verifyOffline({ ...planJson, planHash: "0x" + "11".repeat(32) });
    expect(wrong.ok).toBe(false);
    expect(wrong.checks.find((c) => c.name === "planHash")?.reason).toMatch(/≠/);
    const bad = verifyOffline({ plan: { ...planJson.plan, account: "nope" }, chainId, executor: exec });
    expect(bad.ok).toBe(false);
    expect(bad.checks.some((c) => c.reason?.includes("account"))).toBe(true);
    const noChain = verifyOffline({ plan: planJson.plan, executor: exec });
    expect(noChain.ok).toBe(false);
    expect(noChain.checks.some((c) => c.name === "chainId")).toBe(true);
    const junk = verifyOffline(null);
    expect(junk.ok).toBe(false);
  });
});

describe("verifyOffline receipts", () => {
  it("accepts queued → approved → consumed with matching planId, amount and non-decreasing ISO ts", () => {
    const r = verifyOffline({ ...planJson, events: happyEvents });
    expect(r.ok, formatReport(r)).toBe(true);
    const auto = verifyOffline({
      ...planJson,
      events: [
        ev({ kind: "auto_approved" }),
        ev({ kind: "consumed", ts: "2026-11-24T06:00:01.000Z" }),
      ],
    });
    expect(auto.ok, formatReport(auto)).toBe(true);
  });

  it("fails on amount mismatch, duplicate consumed, bad order, decreasing ts, bad ISO", () => {
    const amt = verifyOffline({ ...planJson, events: [ev({ amount: "7" }), ev({ kind: "approved", amount: "7", ts: "2026-11-24T06:00:01.000Z" }), ev({ kind: "consumed", amount: "7", ts: "2026-11-24T06:00:02.000Z" })] });
    expect(amt.ok).toBe(false);
    expect(amt.checks.find((c) => c.name === "events.amount")?.ok).toBe(false);

    const dup = verifyOffline({
      ...planJson,
      events: [
        ev({ kind: "auto_approved" }),
        ev({ kind: "consumed", ts: "2026-11-24T06:00:01.000Z" }),
        ev({ kind: "consumed", ts: "2026-11-24T06:00:02.000Z" }),
      ],
    });
    expect(dup.ok).toBe(false);
    expect(dup.checks.find((c) => c.name === "events.consumed")?.ok).toBe(false);

    const order = verifyOffline({ ...planJson, events: [ev(), ev({ kind: "consumed", ts: "2026-11-24T06:00:01.000Z" })] });
    expect(order.ok).toBe(false);
    expect(order.checks.find((c) => c.name === "events.ordine")?.reason).toMatch(/queued → consumed/);

    const afterTerm = verifyOffline({
      ...planJson,
      events: [
        ev({ kind: "auto_approved" }),
        ev({ kind: "expired", ts: "2026-11-24T06:00:01.000Z" }),
        ev({ kind: "consumed", ts: "2026-11-24T06:00:02.000Z" }),
      ],
    });
    expect(afterTerm.ok).toBe(false);
    expect(afterTerm.checks.find((c) => c.name === "events.ordine")?.reason).toMatch(/terminale/);

    const ts = verifyOffline({
      ...planJson,
      events: [ev({ ts: "2026-11-24T06:00:02.000Z" }), ev({ kind: "approved", ts: "2026-11-24T06:00:01.000Z" })],
    });
    expect(ts.ok).toBe(false);
    expect(ts.checks.find((c) => c.name === "events.ts")?.ok).toBe(false);

    const iso = verifyOffline({ ...planJson, events: [ev({ ts: "not-iso" })] });
    expect(iso.ok).toBe(false);
    expect(iso.checks.some((c) => c.reason?.includes("ISO"))).toBe(true);
  });

  it("fails closed on a missing or invalid event field", () => {
    expect(verifyOffline({ ...planJson, events: "x" }).ok).toBe(false);
    expect(verifyOffline({ ...planJson, events: [null] }).ok).toBe(false);
    expect(verifyOffline({ ...planJson, events: [ev({ kind: "nope" })] }).ok).toBe(false);
    expect(verifyOffline({ ...planJson, events: [ev({ planId: "0x12" })] }).ok).toBe(false);
    expect(verifyOffline({ ...planJson, events: [ev({ amount: -1 })] }).ok).toBe(false);
  });

  it("does not touch the network: still PASSes if fetch throws", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network forbidden"); }) as typeof fetch;
    try {
      const r = verifyOffline({ ...planJson, events: happyEvents });
      expect(r.ok, formatReport(r)).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("verifyOffline config caps", () => {
  it("uses the default maxEvents when config or the field is null, and rejects a value above the fixed max", () => {
    const base = { ...planJson, events: happyEvents };
    expect(verifyOffline({ ...base, config: null }).ok).toBe(true);
    expect(verifyOffline({ ...base, config: { maxEvents: null } }).ok).toBe(true);
    expect(verifyOffline({ ...base, config: { maxEvents: 1 } }).ok).toBe(false); // 3 events > 1, but 1 is <= max so the cap itself is ok; fail is troppi eventi
    const over = verifyOffline({ ...base, config: { maxEvents: VERIFY_MAX.maxEvents + 1 } });
    expect(over.ok).toBe(false);
    expect(over.checks.some((c) => c.name === "config.maxEvents" && c.reason?.includes("massimo"))).toBe(true);
    for (const config of ["x", 1, []] as const) {
      expect(verifyOffline({ ...base, config: config as never }).ok, String(config)).toBe(false);
    }
  });

  it("fails when the event list exceeds the (default) max, without silently truncating", () => {
    const ev0 = ev();
    const tooMany = Array.from({ length: VERIFY_DEFAULTS.maxEvents + 1 }, (_, i) => ev0);
    const r = verifyOffline({ ...planJson, events: tooMany });
    expect(r.ok).toBe(false);
    expect(r.checks.some((c) => c.name === "events" && c.reason?.includes("troppi"))).toBe(true);
  });
});

describe("scripts/verify.mjs CLI", () => {
  const script = fileURLToPath(new URL("../../../scripts/verify.mjs", import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), "verify-offline-"));

  it("exits 0 on PASS and 1 on FAIL, printing one line per check", () => {
    const okPath = path.join(dir, "ok.json");
    const badPath = path.join(dir, "bad.json");
    writeFileSync(okPath, JSON.stringify({ ...planJson, events: happyEvents }));
    writeFileSync(badPath, JSON.stringify({ ...planJson, planHash: "0x" + "00".repeat(32) }));
    const ok = spawnSync(process.execPath, ["--experimental-strip-types", script, okPath], { encoding: "utf8" });
    expect(ok.status, ok.stderr + ok.stdout).toBe(0);
    expect(ok.stdout).toMatch(/PASS planHash/);
    expect(ok.stdout).toMatch(/RESULT PASS/);
    const bad = spawnSync(process.execPath, ["--experimental-strip-types", script, badPath], { encoding: "utf8" });
    expect(bad.status, bad.stderr + bad.stdout).toBe(1);
    expect(bad.stdout).toMatch(/FAIL planHash/);
    expect(bad.stdout).toMatch(/RESULT FAIL/);
  });

  it("exits 1 when the JSON file is larger than VERIFY_MAX.jsonBytes", () => {
    const bigPath = path.join(dir, "big.json");
    writeFileSync(bigPath, "{" + " ".repeat(VERIFY_MAX.jsonBytes) + "}");
    const big = spawnSync(process.execPath, ["--experimental-strip-types", script, bigPath], { encoding: "utf8" });
    expect(big.status, big.stderr + big.stdout).toBe(1);
    expect(big.stdout).toMatch(/oltre il massimo/);
    expect(big.stdout).toMatch(/RESULT FAIL/);
  });
});
