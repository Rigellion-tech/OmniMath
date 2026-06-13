import React from "react";
import { AlertTriangle, CheckCircle2, Clock3, Loader2 } from "lucide-react";
import { cleanLatexSnippet } from "@/lib/problemLabels";
import { cn } from "@/lib/utils";

const statusConfig = {
  empty: {
    icon: Clock3,
    label: "Ready",
    className: "border-white/[0.08] bg-white/[0.035] text-slate-300/70",
    iconClassName: "text-slate-300/60",
  },
  loading: {
    icon: Loader2,
    label: "Generating explanation",
    className: "border-teal-300/20 bg-teal-300/[0.07] text-teal-50/80",
    iconClassName: "text-teal-200",
    spin: true,
  },
  error: {
    icon: AlertTriangle,
    label: "Generation failed",
    className: "border-rose-300/[0.22] bg-rose-400/[0.075] text-rose-100/90",
    iconClassName: "text-rose-200",
  },
  limit: {
    icon: Clock3,
    label: "Daily limit reached",
    className: "border-amber-300/[0.22] bg-amber-300/[0.075] text-amber-100/90",
    iconClassName: "text-amber-200",
  },
  success: {
    icon: CheckCircle2,
    label: "Explanation ready",
    className: "border-emerald-300/20 bg-emerald-300/[0.065] text-emerald-100/80",
    iconClassName: "text-emerald-200",
  },
};

export default function GenerationStatus({ status }) {
  const config = statusConfig[status.type] ?? statusConfig.empty;
  const Icon = config.icon;
  const detail = status.detail ? cleanLatexSnippet(status.detail, "", 80) : "";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-11 items-center justify-between gap-3 rounded-2xl border px-4 py-2.5 text-sm shadow-[0_12px_32px_rgba(0,0,0,0.16)]",
        config.className
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Icon
          className={cn("h-4 w-4 shrink-0", config.iconClassName, config.spin && "animate-spin")}
        />
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em]">
              {status.label || config.label}
            </span>
            {detail && (
              <span className="truncate text-xs text-slate-300/60">
                {status.type === "success" ? `· ${detail}` : detail}
              </span>
            )}
          </div>
        </div>
      </div>
      {status.meta && (
        <span className="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-1 font-mono text-[10px] text-slate-300/60">
          {status.meta}
        </span>
      )}
    </div>
  );
}
