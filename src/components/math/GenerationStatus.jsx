import React from "react";
import { AlertTriangle, CheckCircle2, Clock3, Loader2 } from "lucide-react";
import { cleanLatexSnippet } from "@/lib/problemLabels";
import { cn } from "@/lib/utils";

const statusConfig = {
  empty: {
    icon: Clock3,
    label: "Ready",
    className: "border-transparent bg-transparent text-neutral-600",
    iconClassName: "text-neutral-500",
  },
  loading: {
    icon: Loader2,
    label: "Generating explanation",
    className: "border-transparent bg-neutral-50 text-neutral-700",
    iconClassName: "text-neutral-600",
    spin: true,
  },
  error: {
    icon: AlertTriangle,
    label: "Generation failed",
    className: "border-rose-200 bg-rose-50 text-rose-800",
    iconClassName: "text-rose-600",
  },
  limit: {
    icon: Clock3,
    label: "Daily limit reached",
    className: "border-amber-200 bg-amber-50 text-amber-800",
    iconClassName: "text-amber-600",
  },
  warning: {
    icon: AlertTriangle,
    label: "Solved with warning",
    className: "border-amber-200 bg-amber-50 text-amber-800",
    iconClassName: "text-amber-600",
  },
  success: {
    icon: CheckCircle2,
    label: "Explanation ready",
    className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    iconClassName: "text-emerald-600",
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
        "flex min-h-9 items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-sm",
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
              <span className="truncate text-xs text-neutral-500">
                {status.type === "success" ? `· ${detail}` : detail}
              </span>
            )}
          </div>
        </div>
      </div>
      {status.meta && (
        <span className="shrink-0 rounded-full border border-neutral-200 bg-white px-2 py-1 font-mono text-[10px] text-neutral-500">
          {status.meta}
        </span>
      )}
    </div>
  );
}
