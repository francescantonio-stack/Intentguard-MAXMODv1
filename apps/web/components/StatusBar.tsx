"use client";

import { fromUnits } from "@intentguard/core";
import type { ChainState } from "@intentguard/signer";
import { InfoTip } from "./InfoTip";
import { useI18n } from "./I18nProvider";
import { Mono } from "./ui";

const mon = (wei: bigint) => fromUnits(wei, "MON").replace(/(\.\d{4})\d+$/, "$1");

export function StatusBar({ s }: { s: ChainState }) {
  const { t } = useI18n();
  const nearLeft = s.near ? fromUnits(BigInt(s.near.remaining), "USDC") : t("status.nearUnregistered");
  return (
    <div className="grid gap-1 rounded-xl border border-white/10 p-3 text-xs text-gray-300 sm:grid-cols-2">
      <div className="flex flex-wrap items-start gap-1">
        <span>
          {t("status.address")} <Mono>{s.account}</Mono>
        </span>
        <InfoTip k="evmAddress" />
      </div>
      <div className="flex flex-wrap items-start gap-1">
        <span>{t("status.weekly", { near: nearLeft, monad: fromUnits(s.executor.remaining, "USDC") })}</span>
        <InfoTip k="weeklyAllowance" />
      </div>
      <div className="flex flex-wrap items-start gap-1">
        <span>{t("status.base", { usdc: fromUnits(s.balances.baseUsdc, "USDC"), eth: mon(s.balances.baseEth) })}</span>
        <InfoTip k="balances" />
      </div>
      <div>
        {t("status.monad", {
          usdc: fromUnits(s.balances.monadUsdc, "USDC"),
          mon: mon(s.balances.monadMon),
          passkey: s.executor.registered ? t("status.passkeyYes") : t("status.passkeyNo"),
        })}
      </div>
    </div>
  );
}
