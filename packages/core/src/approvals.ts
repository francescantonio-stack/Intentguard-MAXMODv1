import { decodeFunctionData, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { erc20Abi } from "./abi";

/**
 * Shared decoder for unlimited / malformed approvals.
 * Selectors and names match Moon's consent.ts so that branch can later import this
 * instead of keeping a second copy. Do not encode PlainSign text here.
 */

export type ApprovalKind = "approve" | "increaseAllowance" | "permit" | "setApprovalForAll";

/** 4-byte selectors of approve / increaseAllowance / permit / setApprovalForAll. Same map as Moon consent.ts. */
export const SENSITIVE_SELECTORS: Record<string, ApprovalKind> = {
  "0x095ea7b3": "approve",
  "0x39509351": "increaseAllowance",
  "0xd505accf": "permit",
  "0x8fcbaf0c": "permit",
  "0xa22cb465": "setApprovalForAll",
};

export const APPROVAL_SELECTORS: ReadonlySet<string> = new Set(Object.keys(SENSITIVE_SELECTORS));

/** Even-length 0x hex (same rule as Moon HEX_DATA_RE). */
export const HEX_DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

export function isValidHexData(data: unknown): data is Hex {
  return typeof data === "string" && HEX_DATA_RE.test(data);
}

export function evmSelector(data: string): string | undefined {
  if (typeof data === "string" && /^0x[0-9a-fA-F]{8}/.test(data)) return data.slice(0, 10).toLowerCase();
  return undefined;
}

const increaseAllowanceAbi = parseAbi([
  "function increaseAllowance(address spender,uint256 addedValue) returns (bool)",
]);
const eip2612PermitAbi = parseAbi([
  "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
]);
const daiPermitAbi = parseAbi([
  "function permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed,uint8 v,bytes32 r,bytes32 s)",
]);
const setApprovalForAllAbi = parseAbi([
  "function setApprovalForAll(address operator,bool approved)",
]);

const APPROVAL_ABIS = [
  { abi: erc20Abi, style: undefined as "dai-permit" | "eip2612-permit" | undefined },
  { abi: increaseAllowanceAbi, style: undefined },
  { abi: eip2612PermitAbi, style: "eip2612-permit" as const },
  { abi: daiPermitAbi, style: "dai-permit" as const },
  { abi: setApprovalForAllAbi, style: undefined },
];

const asAddr = (v: unknown): Address | undefined =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v.toLowerCase() as Address) : undefined;

export type DecodedApproval = {
  kind?: ApprovalKind;
  /** Alias of `kind`, kept for a drop-in switch from Moon's decode. */
  method?: ApprovalKind;
  style?: "dai-permit" | "eip2612-permit";
  spender?: Address;
  operator?: Address;
  owner?: Address;
  amount?: bigint;
  addedValue?: bigint;
  value?: bigint;
  allowed?: boolean;
  approved?: boolean;
  unlimited: boolean;
  malformed: boolean;
  /** Set when the calldata must block: MalformedApproval (truncated selector) or UnlimitedApprove. */
  reason?: "MalformedApproval" | "UnlimitedApprove";
  args?: Record<string, unknown>;
};

const empty = (): DecodedApproval => ({ unlimited: false, malformed: false });

function namedArgs(abi: readonly unknown[], functionName: string, args: readonly unknown[] | undefined): Record<string, unknown> {
  const item = (abi as { type?: string; name?: string; inputs?: { name?: string }[] }[]).find((x) => x.type === "function" && x.name === functionName);
  const out: Record<string, unknown> = {};
  (args ?? []).forEach((a, i) => (out[item?.inputs?.[i]?.name || `arg${i}`] = a));
  return out;
}

function isUnlimited(kind: ApprovalKind, style: DecodedApproval["style"], args: Record<string, unknown>, unlimitedMin: bigint): boolean {
  if (kind === "approve") return typeof args.amount === "bigint" && args.amount >= unlimitedMin;
  if (kind === "increaseAllowance") return typeof args.addedValue === "bigint" && args.addedValue >= unlimitedMin;
  if (kind === "permit" && (style === "dai-permit" || "allowed" in args)) return args.allowed === true;
  if (kind === "permit") return typeof args.value === "bigint" && args.value >= unlimitedMin;
  if (kind === "setApprovalForAll") return args.approved === true;
  return false;
}

/**
 * Pure decoder. Default `unlimitedMin` is maxUint256 (Moon: only exact max / allowed=true / approved=true).
 * Callers like simulateTx may pass a tighter threshold.
 */
export function decodeApproval(data: unknown, unlimitedMin: bigint = maxUint256): DecodedApproval {
  if (data === undefined || data === null || data === "" || data === "0x") return empty();
  if (typeof data !== "string") return empty();
  const sel = evmSelector(data);
  const hinted = sel ? SENSITIVE_SELECTORS[sel] : undefined;
  // Odd-length (or non-hex) payload after a known approval selector is malformed, not ignored.
  if (hinted && !/^(?:[0-9a-fA-F]{2})*$/.test(data.slice(10))) {
    return { kind: hinted, method: hinted, unlimited: false, malformed: true, reason: "MalformedApproval" };
  }
  if (!isValidHexData(data)) return empty();

  for (const { abi, style } of APPROVAL_ABIS) {
    try {
      const d = decodeFunctionData({ abi, data });
      const kind = d.functionName as string;
      if (kind !== "approve" && kind !== "increaseAllowance" && kind !== "permit" && kind !== "setApprovalForAll") continue;
      const args = namedArgs(abi, d.functionName, d.args as readonly unknown[] | undefined);
      const resolvedStyle = kind === "permit" ? (style ?? (typeof args.allowed === "boolean" ? "dai-permit" : "eip2612-permit")) : undefined;
      const amount = kind === "approve" ? (args.amount as bigint | undefined)
        : kind === "increaseAllowance" ? (args.addedValue as bigint | undefined)
        : kind === "permit" && resolvedStyle === "dai-permit" ? (args.allowed === true ? maxUint256 : 0n)
        : kind === "permit" ? (args.value as bigint | undefined)
        : args.approved === true ? maxUint256 : 0n;
      return {
        kind,
        method: kind,
        style: resolvedStyle,
        spender: asAddr(args.spender),
        operator: asAddr(args.operator),
        owner: asAddr(args.owner) ?? asAddr(args.holder),
        amount,
        addedValue: typeof args.addedValue === "bigint" ? args.addedValue : undefined,
        value: typeof args.value === "bigint" ? args.value : undefined,
        allowed: typeof args.allowed === "boolean" ? args.allowed : undefined,
        approved: typeof args.approved === "boolean" ? args.approved : undefined,
        unlimited: isUnlimited(kind, resolvedStyle, args, unlimitedMin),
        malformed: false,
        reason: isUnlimited(kind, resolvedStyle, args, unlimitedMin) ? "UnlimitedApprove" : undefined,
        args,
      };
    } catch { /* try next ABI */ }
  }

  if (hinted) return { kind: hinted, method: hinted, unlimited: false, malformed: true, reason: "MalformedApproval" };
  return empty();
}

/** Calldata looks like approve/permit/setApprovalForAll but cannot be fully decoded (truncated or malformed). Same contract as Moon. */
export function isTruncatedSensitive(data: unknown): { method: string } | undefined {
  if (typeof data !== "string" || data === "0x") return undefined;
  const d = decodeApproval(data);
  if (d.malformed && d.kind) return { method: d.kind };
  return undefined;
}
