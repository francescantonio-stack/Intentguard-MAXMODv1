import { describe, expect, it } from "vitest";
import { encodeFunctionData, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { erc20Abi } from "../src/abi";
import {
  APPROVAL_SELECTORS, SENSITIVE_SELECTORS, decodeApproval, evmSelector, isTruncatedSensitive, isValidHexData,
} from "../src/approvals";

const TO = "0x1111111111111111111111111111111111111111" as Address;
const FROM = "0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B" as Address;
const Z32 = ("0x" + "11".repeat(32)) as Hex;

const incAbi = parseAbi(["function increaseAllowance(address spender,uint256 addedValue) returns (bool)"]);
const p2612 = parseAbi(["function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)"]);
const pDai = parseAbi(["function permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed,uint8 v,bytes32 r,bytes32 s)"]);
const setAll = parseAbi(["function setApprovalForAll(address operator,bool approved)"]);

describe("decodeApproval (shared, Moon-compatible selectors)", () => {
  it("exposes the same 5 selectors as Moon consent.ts", () => {
    expect(SENSITIVE_SELECTORS).toEqual({
      "0x095ea7b3": "approve",
      "0x39509351": "increaseAllowance",
      "0xd505accf": "permit",
      "0x8fcbaf0c": "permit",
      "0xa22cb465": "setApprovalForAll",
    });
    expect(APPROVAL_SELECTORS.size).toBe(5);
    expect(evmSelector("0x095ea7b3" + "00".repeat(64))).toBe("0x095ea7b3");
  });

  it("flags exact maxUint256 (default) and DAI allowed=true / setApprovalForAll(true) as unlimited", () => {
    const approveMax = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [TO, maxUint256] });
    const incMax = encodeFunctionData({ abi: incAbi, functionName: "increaseAllowance", args: [TO, maxUint256] });
    const permitMax = encodeFunctionData({ abi: p2612, functionName: "permit", args: [FROM, TO, maxUint256, 1n, 27, Z32, Z32] });
    const daiYes = encodeFunctionData({ abi: pDai, functionName: "permit", args: [FROM, TO, 0n, 1n, true, 27, Z32, Z32] });
    const setYes = encodeFunctionData({ abi: setAll, functionName: "setApprovalForAll", args: [TO, true] });
    expect(decodeApproval(approveMax)).toMatchObject({ kind: "approve", method: "approve", unlimited: true, malformed: false, reason: "UnlimitedApprove" });
    expect(decodeApproval(incMax)).toMatchObject({ kind: "increaseAllowance", unlimited: true, malformed: false });
    expect(decodeApproval(permitMax)).toMatchObject({ kind: "permit", style: "eip2612-permit", unlimited: true, malformed: false });
    expect(decodeApproval(daiYes)).toMatchObject({ kind: "permit", style: "dai-permit", allowed: true, unlimited: true, malformed: false });
    expect(decodeApproval(setYes)).toMatchObject({ kind: "setApprovalForAll", approved: true, unlimited: true, malformed: false });
  });

  it("does not flag a finite approve, increaseAllowance, permit, DAI allowed=false or setApprovalForAll(false)", () => {
    const cases = [
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [TO, 100n] }),
      encodeFunctionData({ abi: incAbi, functionName: "increaseAllowance", args: [TO, 10n] }),
      encodeFunctionData({ abi: p2612, functionName: "permit", args: [FROM, TO, 10n, 1n, 27, Z32, Z32] }),
      encodeFunctionData({ abi: pDai, functionName: "permit", args: [FROM, TO, 0n, 1n, false, 27, Z32, Z32] }),
      encodeFunctionData({ abi: setAll, functionName: "setApprovalForAll", args: [TO, false] }),
    ];
    for (const data of cases) {
      const d = decodeApproval(data);
      expect(d.unlimited, d.kind).toBe(false);
      expect(d.malformed).toBe(false);
      expect(d.kind).toBeTruthy();
    }
  });

  it("marks truncated/malformed sensitive calldata as malformed, and isTruncatedSensitive returns the method", () => {
    for (const [sel, method] of Object.entries(SENSITIVE_SELECTORS)) {
      const truncated = sel + "00";
      expect(isValidHexData(truncated)).toBe(true);
      const d = decodeApproval(truncated);
      expect(d.malformed, sel).toBe(true);
      expect(d.kind, sel).toBe(method);
      expect(d.unlimited, sel).toBe(false);
      expect(d.reason, sel).toBe("MalformedApproval");
      expect(isTruncatedSensitive(truncated)).toEqual({ method });
    }
    expect(decodeApproval("0xdeadbeef00000001")).toEqual({ unlimited: false, malformed: false }); // unknown selector: no block
    expect(isTruncatedSensitive("0xdeadbeef00000001")).toBeUndefined();
    expect(isTruncatedSensitive("ffff")).toBeUndefined();
    expect(decodeApproval("0x")).toEqual({ unlimited: false, malformed: false });
  });

  it("accepts a tighter unlimitedMin from the caller (simulate) without changing the default", () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [TO, 100n] });
    expect(decodeApproval(data).unlimited).toBe(false);
    expect(decodeApproval(data, 50n).unlimited).toBe(true);
  });
});
