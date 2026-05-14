import React from "react";
import { CheckCircle2 } from "lucide-react";
import MathChunk from "./MathChunk";
import { useHover } from "@/lib/HoverContext";
import { cn } from "@/lib/utils";

export default function MathStep({ step, index, selected, onSelect }) {
  const { activeStepId, pinnedChunkId, handleUnpin } = useHover();
  const isActiveStep = activeStepId === step.id;
  const isOtherStepActive = activeStepId && activeStepId !== step.id;
  const state = isActiveStep ? "active" : selected ? "selected" : "idle";

  const handleSelect = () => {
    onSelect?.(step.id);
    if (pinnedChunkId) handleUnpin();
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleSelect();
    }
  };

  return (
    <div className={cn("transition-all duration-300 ease-out", isOtherStepActive && !selected && "opacity-55")}>
      <div
        role="button"
        tabIndex={0}
        data-state={state}
        onClick={handleSelect}
        onKeyDown={handleKeyDown}
        className="step-card group relative overflow-hidden rounded-2xl p-4 transition-all duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071116]"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-teal-200/40 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-teal-300/[0.18] bg-teal-300/[0.075] font-mono text-xs font-semibold text-teal-100">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-teal-200/60">
                Step {index + 1}
              </p>
              <h3 className="truncate text-sm font-semibold tracking-normal text-cyan-50/92">
                {step.label}
              </h3>
            </div>
          </div>

          <div
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
              isActiveStep
                ? "border-teal-300/[0.35] bg-teal-300/[0.12] text-teal-100"
                : selected
                  ? "border-teal-300/[0.24] bg-teal-300/[0.08] text-teal-200/75"
                  : "border-white/[0.08] bg-white/[0.035] text-slate-400/70"
            )}
          >
            {(isActiveStep || selected) && <CheckCircle2 className="h-3 w-3" />}
            {isActiveStep ? "Inspecting" : selected ? "Selected" : "Select"}
          </div>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-1 gap-y-1.5 leading-relaxed text-[17px] md:text-[18px]">
          {step.chunks.map((chunk) => (
            <MathChunk key={chunk.id} chunk={chunk} stepId={step.id} />
          ))}
        </div>
      </div>
    </div>
  );
}
