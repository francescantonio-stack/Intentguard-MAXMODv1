import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Reusable fail-closed harness. Mutates a valid input and asserts the module
 * always BLOCKS and never throws (NaN, Infinity, -0, null, missing fields,
 * numeric strings, bigint 0n/neg/huge, invalid config, a limit widened by the
 * source, and optional replay).
 */

export type FailClosedSpec<I, R> = {
  name: string;
  available?: boolean;
  skipReason?: string;
  valid: () => I;
  run: (input: I) => R | Promise<R>;
  isBlocked: (result: R) => boolean;
  required?: string[];
  numeric?: string[];
  /** Quantity fields: 0n may be legitimate, so it is not mutated. */
  amounts?: string[];
  limits?: Array<{ path: string; widen: unknown }>;
  configs?: string[];
  replay?: (first: R, input: I) => I | Promise<I | null> | null;
  extra?: Array<{ name: string; input: () => unknown }>;
  /** If false, skip the "null/undefined/0/'x' input" cases (e.g. redact). Default true. */
  rejectBare?: boolean;
  /** Fields that may accept a numeric string (JSON). The "1" mutation is skipped for these. */
  allowNumericString?: string[];
};


const NUMERIC_MUTATIONS: Array<{ name: string; value: unknown; skipAmount?: boolean }> = [
  { name: "NaN", value: NaN },
  { name: "Infinity", value: Infinity },
  { name: "-Infinity", value: -Infinity },
  { name: "-0", value: -0, skipAmount: true },
  { name: "null", value: null },
  { name: 'stringa "1"', value: "1" },
  { name: "0n", value: 0n, skipAmount: true },
  { name: "-1n", value: -1n },
  { name: "bigint enorme (2n**256n)", value: 2n ** 256n, skipAmount: true },
];

/** Deep-clone data (incl. bigint) while preserving functions. */
export function cloneData<T>(x: T): T {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map((v) => cloneData(v)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    out[k] = typeof v === "function" ? v : cloneData(v);
  }
  return out as T;
}

export function setPath<T extends object>(obj: T, path: string, value: unknown): T {
  const parts = path.split(".");
  const last = parts.pop()!;
  let cur: Record<string, unknown> = obj as Record<string, unknown>;
  for (const p of parts) {
    const next = cur[p];
    if (next == null || typeof next !== "object") cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return obj;
}

export function deletePath<T extends object>(obj: T, path: string): T {
  return setPath(obj, path, undefined);
}

export function describeFailClosed<I extends object, R>(spec: FailClosedSpec<I, R>): void {
  describe(`${spec.name} fail-closed`, () => {
    if (spec.available === false) {
      it.skip(spec.skipReason ?? "modulo assente su questo branch", () => {});
      return;
    }

    const assertBlocked = async (input: unknown, label: string) => {
      let result: R | undefined;
      try {
        result = await spec.run(input as I);
      } catch (e) {
        expect.fail(`${label}: crash (${e instanceof Error ? e.message : String(e)})`);
        return;
      }
      expect(spec.isBlocked(result), `${label}: atteso un blocco`).toBe(true);
    };

    it("l'input valido non va in crash (controllo di sanità)", async () => {
      await spec.run(spec.valid());
    });

    if (spec.rejectBare !== false) {
      it("input null o non oggetto blocca, senza crash", async () => {
        await assertBlocked(null, "null");
        await assertBlocked(undefined, "undefined");
        await assertBlocked(0, "0");
        await assertBlocked("x", '"x"');
      });
    }

    for (const field of spec.required ?? []) {
      it(`manca ${field} → blocco`, async () => {
        await assertBlocked(deletePath(cloneData(spec.valid()), field), `manca ${field}`);
      });
      it(`${field} = null → blocco`, async () => {
        await assertBlocked(setPath(cloneData(spec.valid()), field, null), `${field}=null`);
      });
      it(`${field} = undefined → blocco`, async () => {
        await assertBlocked(setPath(cloneData(spec.valid()), field, undefined), `${field}=undefined`);
      });
    }

    const numericFields = [
      ...(spec.numeric ?? []).map((path) => ({ path, amount: false })),
      ...(spec.amounts ?? []).map((path) => ({ path, amount: true })),
    ];
    for (const { path, amount } of numericFields) {
      for (const m of NUMERIC_MUTATIONS) {
        if (amount && m.skipAmount) continue;
        if ((spec.allowNumericString ?? []).includes(path) && m.name.startsWith("stringa")) continue;
        it(`${path} = ${m.name} → blocco`, async () => {
          await assertBlocked(setPath(cloneData(spec.valid()), path, m.value), `${path}=${m.name}`);
        });
      }
    }

    for (const path of spec.configs ?? []) {
      it(`${path} non valida → blocco`, async () => {
        for (const value of [null, "x", 1, []]) {
          await assertBlocked(setPath(cloneData(spec.valid()), path, value), `${path}=${String(value)}`);
        }
      });
    }

    for (const lim of spec.limits ?? []) {
      it(`limite allargato su ${lim.path} → blocco`, async () => {
        await assertBlocked(setPath(cloneData(spec.valid()), lim.path, lim.widen), `widen ${lim.path}`);
      });
    }

    if (spec.replay) {
      it("replay dello stesso piano → blocco, senza crash", async () => {
        const input = spec.valid();
        const first = await spec.run(input);
        const second = await spec.replay!(first, input);
        if (second !== null && second !== undefined) await assertBlocked(second, "replay");
      });
    }

    for (const ex of spec.extra ?? []) {
      it(`${ex.name} → blocco`, async () => {
        await assertBlocked(ex.input(), ex.name);
      });
    }
  });
}

/** True when `packages/core/src/<name>.ts` exists on this branch (hook tests skip otherwise). */
export const moduleExists = (name: string): boolean =>
  existsSync(new URL(`../src/${name}.ts`, import.meta.url));
