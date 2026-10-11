"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { InfoTip } from "@/components/InfoTip";
import { useI18n } from "@/components/I18nProvider";

export default function LandingPage() {
  return (
    <Suspense fallback={null}>
      <Landing />
    </Suspense>
  );
}

function Landing() {
  const { t } = useI18n();
  const params = useSearchParams();
  const router = useRouter();
  const intent = params.get("intent");

  useEffect(() => {
    if (intent) router.replace(`/app?intent=${encodeURIComponent(intent)}`);
  }, [intent, router]);

  if (intent) {
    return <p className="text-sm text-gray-400">{t("landing.redirectApprove")}</p>;
  }

  return (
    <div className="landing-hero -mx-4 space-y-10 px-4 sm:space-y-12">
      <section className="space-y-4 pt-2 sm:pt-6">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-emerald-400">{t("landing.kicker")}</p>
        <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-6xl">
          {t("landing.titleBefore")}
          <span className="text-emerald-400">{t("landing.titleAccent")}</span>
        </h1>
        <p className="max-w-2xl text-lg text-gray-100 sm:text-xl">{t("landing.tagline")}</p>
        <p className="max-w-2xl text-sm leading-relaxed text-gray-400 sm:text-base">{t("landing.lead")}</p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link
            href="/app"
            className="inline-flex rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-medium text-black hover:bg-emerald-400"
          >
            {t("landing.cta")}
          </Link>
          <Link
            href="/setup"
            className="inline-flex rounded-lg border border-white/20 px-5 py-2.5 text-sm font-medium text-gray-100 hover:bg-white/10"
          >
            {t("landing.ctaSetup")}
          </Link>
          <a
            href="#how"
            className="inline-flex rounded-lg px-3 py-2.5 text-sm text-emerald-300 underline-offset-4 hover:underline"
          >
            {t("landing.ctaHow")}
          </a>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold text-white">{t("landing.problemTitle")}</h2>
        <p className="max-w-2xl text-sm leading-relaxed text-gray-400">{t("landing.problemLead")}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <ProblemCard title={t("landing.problem1Title")} body={t("landing.problem1Body")} />
          <ProblemCard title={t("landing.problem2Title")} body={t("landing.problem2Body")} />
          <ProblemCard title={t("landing.problem3Title")} body={t("landing.problem3Body")} />
        </div>
      </section>

      <section id="how" className="scroll-mt-6 space-y-4">
        <h2 className="text-2xl font-semibold text-white">{t("landing.howTitle")}</h2>
        <p className="max-w-2xl text-sm leading-relaxed text-gray-400">{t("landing.howLead")}</p>
        <div className="grid gap-3 lg:grid-cols-3">
          <LayerCard
            featured
            kicker={t("landing.monadKicker")}
            title={t("landing.monadTitle")}
            body={t("landing.monadBody")}
          />
          <LayerCard kicker={t("landing.nearKicker")} title={t("landing.nearTitle")} body={t("landing.nearBody")} />
          <LayerCard kicker={t("landing.cctpKicker")} title={t("landing.cctpTitle")} body={t("landing.cctpBody")} />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold text-white">{t("landing.stepsTitle")}</h2>
        <p className="max-w-2xl text-sm leading-relaxed text-gray-400">{t("landing.stepsLead")}</p>
        <ol className="grid gap-3 sm:grid-cols-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <li key={n} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <div className="mb-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/15 text-sm font-semibold text-emerald-400">
                {n}
              </div>
              <h3 className="font-medium text-white">{t(`landing.step${n}Title`)}</h3>
              <p className="mt-1 text-sm text-gray-400">{t(`landing.step${n}Body`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="roadmap" className="scroll-mt-6 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-semibold text-white">{t("landing.roadmapTitle")}</h2>
          <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-emerald-300">
            {t("landing.roadmapBadge")}
          </span>
          <InfoTip k="roadmap" />
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-gray-400">{t("landing.roadmapLead")}</p>
        <div className="grid gap-3 lg:grid-cols-2">
          <article className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-4 shadow-[0_0_32px_rgba(16,185,129,0.08)]">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-300">
                {t("landing.roadmapMultichainKicker")}
              </p>
              <InfoTip k="roadmapMultichain" />
            </div>
            <h3 className="mt-2 font-semibold text-white">{t("landing.roadmapMultichainTitle")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-300">{t("landing.roadmapMultichainBody")}</p>
          </article>
          <article className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{t("landing.roadmapSwapKicker")}</p>
              <InfoTip k="roadmapSwap" />
            </div>
            <h3 className="mt-2 font-semibold text-white">{t("landing.roadmapSwapTitle")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-300">{t("landing.roadmapSwapBody")}</p>
          </article>
        </div>
      </section>

      <section className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <h2 className="text-lg font-semibold text-amber-200">{t("landing.disclaimerTitle")}</h2>
          <InfoTip k="testnet" />
        </div>
        <p className="mt-2 text-sm leading-relaxed text-amber-100/80">{t("landing.disclaimerBody")}</p>
      </section>

      <section className="rounded-xl border border-emerald-500/50 bg-emerald-500/10 p-5 sm:p-6">
        <h2 className="text-xl font-semibold text-white">{t("landing.finalCtaTitle")}</h2>
        <p className="mt-2 max-w-2xl text-sm text-gray-300">{t("landing.finalCtaBody")}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/app"
            className="inline-flex rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-medium text-black hover:bg-emerald-400"
          >
            {t("landing.finalCtaApp")}
          </Link>
          <Link
            href="/attack"
            className="inline-flex rounded-lg border border-white/20 px-5 py-2.5 text-sm font-medium text-gray-100 hover:bg-white/10"
          >
            {t("landing.finalCtaAttack")}
          </Link>
        </div>
      </section>
    </div>
  );
}

function ProblemCard({ title, body }: { title: string; body: string }) {
  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <h3 className="font-medium text-white">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-gray-400">{body}</p>
    </article>
  );
}

function LayerCard({
  kicker,
  title,
  body,
  featured,
}: {
  kicker: string;
  title: string;
  body: string;
  featured?: boolean;
}) {
  return (
    <article
      className={`rounded-xl border p-4 ${
        featured
          ? "border-emerald-400 bg-emerald-500/10 shadow-[0_0_32px_rgba(16,185,129,0.12)]"
          : "border-white/10 bg-white/[0.03]"
      }`}
    >
      <p className={`text-xs font-medium uppercase tracking-wide ${featured ? "text-emerald-300" : "text-gray-500"}`}>
        {kicker}
      </p>
      <h3 className="mt-2 font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-gray-300">{body}</p>
    </article>
  );
}
