import { describe, expect, it } from "vitest";
import { checkCounterparty, isLookalike, type CodeClient } from "../src/counterparty";

const A = "0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B";
const B = "0x1111111111111111111111111111111111111111";
const ZERO = "0x" + "00".repeat(20);
const PLAN = "0xBB".padEnd(66, "B");
const eoa: CodeClient = { getCode: async () => "0x" };
const contract: CodeClient = { getCode: async () => "0x60806040" };
const boom: CodeClient = { getCode: async () => { throw new Error("rpc down"); } };

const codes = (r: Awaited<ReturnType<typeof checkCounterparty>>) => r.findings.map((f) => f.code);

describe("checkCounterparty", () => {
  it("an allowlisted EOA already paid is ok", async () => {
    const r = await checkCounterparty({ address: A, allowlist: [A.toUpperCase()], paidBefore: [A], planId: PLAN, amount: 5n, token: "usdc", now: 1_800_000_000_000 }, eoa);
    expect(r.verdict).toBe("ok");
    expect(r.address).toBe(A.toLowerCase());
    expect(r.token).toBe("USDC");
    expect(r.kind).toBe("eoa");
    expect(r.event).toBeNull();
    expect(r.successOddsInput.dryRun[0]!.ok).toBe(true);
    expect(codes(r)).toContain("Allowlisted");
    expect(codes(r)).toContain("CounterpartyEoa");
  });

  it("blocks the zero address", async () => {
    const r = await checkCounterparty({ address: ZERO, planId: PLAN, amount: 9n, now: 1 }, eoa);
    expect(r.verdict).toBe("blocked");
    expect(r.kind).toBe("zero");
    expect(r.event).toMatchObject({ kind: "blocked", reason: "ZeroAddress", planId: PLAN.toLowerCase(), amount: 9n, id: null });
    expect(typeof r.event!.amount).toBe("bigint");
    expect(r.event!.amount).not.toBe(0n);
    expect(r.successOddsInput.dryRun[0]).toEqual({ ok: false, reason: "ZeroAddress" });
    expect(r.safeHoldInput.observations[0]!.confidence).toBe(0);
  });

  it("blocks a denylisted address (deny wins over allow)", async () => {
    const r = await checkCounterparty({ address: B, denylist: [B], allowlist: [B], paidBefore: [B], planId: PLAN, amount: 1n, now: 1 }, eoa);
    expect(r.verdict).toBe("blocked");
    expect(r.event?.reason).toBe("CounterpartyDenylisted");
    expect(r.event?.planId).toBe(PLAN.toLowerCase());
  });

  it("blocks a lookalike of a known address (address poisoning)", async () => {
    const known = "0x1111111111111111111111111111111111111111";
    const fake = "0x1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111";
    expect(isLookalike(known, fake, 4)).toBe(true);
    expect(isLookalike(known, known, 4)).toBe(false);
    const r = await checkCounterparty({ address: fake, paidBefore: [known], planId: PLAN, amount: 2n, now: 1 }, eoa);
    expect(r.verdict).toBe("blocked");
    expect(r.event?.reason).toBe("LookalikeAddress");
    expect(r.event?.amount).toBe(2n);
  });

  it("warns on a new payee and on a contract, without blocking by default", async () => {
    const r = await checkCounterparty({ address: B, paidBefore: [A], planId: PLAN, amount: 3n, now: 1 }, contract);
    expect(r.verdict).toBe("warning");
    expect(r.kind).toBe("contract");
    expect(codes(r)).toEqual(expect.arrayContaining(["NewCounterparty", "CounterpartyContract"]));
    expect(r.event).toBeNull();
    expect(r.successOddsInput.dryRun[0]!.ok).toBe(true);
    expect(r.safeHoldInput.observations[0]!.confidence).toBe(0.7);
  });

  it("blocks a new payee when blockNew is set, and a stranger when strictAllowlist is set", async () => {
    const n = await checkCounterparty({ address: B, paidBefore: [A], blockNew: true, planId: PLAN, amount: 4n, now: 1 }, eoa);
    expect(n.verdict).toBe("blocked");
    expect(n.event?.reason).toBe("NewCounterparty");
    const s = await checkCounterparty({ address: B, allowlist: [A], strictAllowlist: true, paidBefore: [A], planId: PLAN, amount: 4n, now: 1 }, eoa);
    expect(s.verdict).toBe("blocked");
    expect(s.event?.reason).toBe("NotAllowlisted");
  });

  it("is fail-closed: null, bad address, bad now, missing client or RPC error never yield ok", async () => {
    const unavailable = await Promise.all([
      checkCounterparty(null, eoa),
      checkCounterparty({ address: "nope", now: 1 }, eoa),
      checkCounterparty({ address: A, now: NaN }, eoa),
      checkCounterparty({ address: A, now: Infinity }, eoa),
    ]);
    for (const r of unavailable) {
      expect(r.verdict).toBe("blocked");
      expect(r.event?.kind).toBe("blocked");
      expect(r.event?.reason).toBe("SimUnavailable");
      expect(r.successOddsInput.dryRun[0]!.ok).toBe(false);
    }
    const noCode = await Promise.all([
      checkCounterparty({ address: A, now: 1, paidBefore: [A] }, null),
      checkCounterparty({ address: A, now: 1, paidBefore: [A] }, boom),
    ]);
    for (const r of noCode) {
      expect(r.verdict).toBe("blocked");
      expect(r.event?.reason).toBe("CodeUnavailable");
    }
  });
});

describe("config limits", () => {
  it("blocks a widened lookalike window or invalid lookalikeChars (BadConfig)", async () => {
    const cases = [100, 5, 1e9, 0, -0, NaN, Infinity, "4", 0n] as const;
    for (const lookalikeChars of cases) {
      const r = await checkCounterparty({ address: A, paidBefore: [A], lookalikeChars, planId: PLAN, amount: 1n, now: 1 }, eoa);
      expect(r.verdict, String(lookalikeChars)).toBe("blocked");
      expect(r.event?.reason).toBe("BadConfig");
    }
  });

  it("accepts a tighter window and flags a 2-char lookalike that would pass at 4", async () => {
    const known = "0x1111111111111111111111111111111111111111";
    const fake = "0x11aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11";
    expect(isLookalike(known, fake, 4)).toBe(false);
    expect(isLookalike(known, fake, 2)).toBe(true);
    const loose = await checkCounterparty({ address: fake, paidBefore: [known], planId: PLAN, amount: 2n, now: 1 }, eoa);
    expect(loose.event?.reason).not.toBe("LookalikeAddress");
    const tight = await checkCounterparty({ address: fake, paidBefore: [known], lookalikeChars: 2, planId: PLAN, amount: 2n, now: 1 }, eoa);
    expect(tight.verdict).toBe("blocked");
    expect(tight.event?.reason).toBe("LookalikeAddress");
  });
});


describe("lists, amount, getCode and EIP-7702", () => {
  it("blocks BadConfig when allowlist or denylist is present but not an array, or has invalid entries", async () => {
    const cases: Array<Record<string, unknown>> = [
      { address: A, paidBefore: [A], allowlist: "not-an-array", now: 1, planId: PLAN, amount: 1n },
      { address: A, paidBefore: [A], denylist: { B }, now: 1, planId: PLAN, amount: 1n },
      { address: A, paidBefore: [A], allowlist: [A, "nope"], now: 1, planId: PLAN, amount: 1n },
      { address: A, paidBefore: [A], denylist: [null], now: 1, planId: PLAN, amount: 1n },
    ];
    for (const [i, input] of cases.entries()) {
      const r = await checkCounterparty(input as never, eoa);
      expect(r.verdict, `case ${i}`).toBe("blocked");
      expect(r.event?.reason, `case ${i}`).toBe("BadConfig");
    }
  });

  it("blocks BadAmount when amount is present but invalid, and does not proceed as 0n", async () => {
    for (const amount of ["foo", NaN, -1n, null, 1.5, {}] as const) {
      const r = await checkCounterparty({ address: A, paidBefore: [A], planId: PLAN, amount, now: 1 }, eoa);
      expect(r.verdict, String(amount)).toBe("blocked");
      expect(r.event?.reason, String(amount)).toBe("BadAmount");
    }
    const ok = await checkCounterparty({ address: A, paidBefore: [A], planId: PLAN, amount: 0n, now: 1 }, eoa);
    expect(ok.verdict).toBe("ok");
    expect(ok.event).toBeNull();
  });

  it("blocks CodeUnavailable when getCode returns undefined or an empty string (not an EOA)", async () => {
    const undef: CodeClient = { getCode: async () => undefined };
    const empty: CodeClient = { getCode: async () => "" };
    for (const client of [undef, empty]) {
      const r = await checkCounterparty({ address: A, paidBefore: [A], planId: PLAN, amount: 1n, now: 1 }, client);
      expect(r.verdict).toBe("blocked");
      expect(r.event?.reason).toBe("CodeUnavailable");
      expect(r.kind).not.toBe("eoa");
    }
  });

  it("treats EIP-7702 code 0xef0100 as a delegated EOA warning, not a plain contract", async () => {
    const delegated: CodeClient = { getCode: async () => ("0xef0100" + "11".repeat(20)) as `0x${string}` };
    const r = await checkCounterparty({ address: A, paidBefore: [A], allowlist: [A], planId: PLAN, amount: 1n, now: 1 }, delegated);
    expect(r.kind).toBe("delegated");
    expect(r.verdict).toBe("warning");
    expect(codes(r)).toContain("Delegated7702");
    expect(codes(r)).not.toContain("CounterpartyContract");
    expect(r.event).toBeNull();
  });
});

  it("blocks BadConfig when config is present but not a valid object", async () => {
    for (const config of [null, "x", 1, []] as const) {
      const r = await checkCounterparty({ address: A, paidBefore: [A], planId: PLAN, amount: 1n, now: 1, config: config as never }, eoa);
      expect(r.verdict, String(config)).toBe("blocked");
      expect(r.event?.reason, String(config)).toBe("BadConfig");
    }
  });
