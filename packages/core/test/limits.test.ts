import { describe, expect, it } from "vitest";
import { cappedNumber, isConfigObject, tightenNumber, tightenBigint } from "../src/limits";

describe("cappedNumber", () => {
  const def = 15_000;
  const max = 30_000;
  it("uses the default when the value is omitted or null, and rejects anything above the fixed max", () => {
    expect(cappedNumber(undefined, def, max)).toEqual({ ok: true, value: def });
    expect(cappedNumber(null, def, max)).toEqual({ ok: true, value: def });
    expect(cappedNumber(1_000, def, max)).toEqual({ ok: true, value: 1_000 });
    expect(cappedNumber(20_000, def, max)).toEqual({ ok: true, value: 20_000 });
    expect(cappedNumber(max, def, max)).toEqual({ ok: true, value: max });
    const over = cappedNumber(max + 1, def, max);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("BadConfig");
    expect(cappedNumber(0, def, max).ok).toBe(false);
    expect(cappedNumber(NaN, def, max).ok).toBe(false);
    expect(cappedNumber("1000", def, max).ok).toBe(false);
  });
});

describe("tighten* null uses default", () => {
  it("treats a null offered value as the default, and still rejects a loosened limit", () => {
    expect(tightenNumber(null, 4, true)).toEqual({ ok: true, value: 4 });
    expect(tightenNumber(5, 4, true).ok).toBe(false);
    expect(tightenBigint(null, 10n, true)).toEqual({ ok: true, value: 10n });
  });
});

describe("isConfigObject", () => {
  it("accepts a plain object and rejects null, arrays and primitives", () => {
    expect(isConfigObject({})).toBe(true);
    expect(isConfigObject({ timeoutMs: 1 })).toBe(true);
    expect(isConfigObject(null)).toBe(false);
    expect(isConfigObject([])).toBe(false);
    expect(isConfigObject("x")).toBe(false);
    expect(isConfigObject(1)).toBe(false);
  });
});
