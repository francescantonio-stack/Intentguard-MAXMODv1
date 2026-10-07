import { fromUnits } from "@intentguard/core";
import type { ChainState } from "@intentguard/signer";
import { Mono } from "./ui";

const mon = (wei: bigint) => fromUnits(wei, "MON").replace(/(\.\d{4})\d+$/, "$1");

export function StatusBar({ s }: { s: ChainState }) {
  const nearLeft = s.near ? fromUnits(BigInt(s.near.remaining), "USDC") : "not registered";
  return (
    <div className="grid gap-1 rounded-xl border border-white/10 p-3 text-xs text-gray-300 sm:grid-cols-2">
      <div>
        Your EVM address (same on Base and Monad): <Mono>{s.account}</Mono>
      </div>
      <div>
        Weekly allowance left: NEAR policy <b>{nearLeft}</b> · Monad <b>{fromUnits(s.executor.remaining, "USDC")}</b> USDC
      </div>
      <div>
        Base Sepolia: {fromUnits(s.balances.baseUsdc, "USDC")} USDC · {mon(s.balances.baseEth)} ETH
      </div>
      <div>
        Monad: {fromUnits(s.balances.monadUsdc, "USDC")} USDC · {mon(s.balances.monadMon)} MON · passkey{" "}
        {s.executor.registered ? "registered ✓" : "not registered"}
      </div>
    </div>
  );
}
