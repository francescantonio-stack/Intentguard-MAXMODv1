import type { ReactNode } from "react";

export function Card({ title, children, tone }: { title?: ReactNode; children: ReactNode; tone?: "danger" | "ok" }) {
  const border = tone === "danger" ? "border-red-500/60" : tone === "ok" ? "border-emerald-500/60" : "border-white/10";
  return (
    <section className={`rounded-xl border ${border} bg-white/[0.03] p-4 space-y-3`}>
      {title && <h2 className="font-semibold text-white">{title}</h2>}
      {children}
    </section>
  );
}

export function Button({ children, onClick, disabled, kind = "primary" }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-emerald-500 text-black hover:bg-emerald-400",
    ghost: "border border-white/20 hover:bg-white/10",
    danger: "bg-red-500 text-white hover:bg-red-400",
  }[kind];
  return (
    <button onClick={onClick} disabled={disabled} className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40 ${styles}`}>
      {children}
    </button>
  );
}

export const Mono = ({ children }: { children: ReactNode }) => <code className="break-all font-mono text-xs text-emerald-300">{children}</code>;

export const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="text-sky-400 underline underline-offset-2 hover:text-sky-300">
    {children}
  </a>
);

export const Err = ({ children }: { children: ReactNode }) =>
  children ? <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{children}</p> : null;
