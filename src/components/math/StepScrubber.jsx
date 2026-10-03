import React from "react";
import { cn } from "@/lib/utils";

function getTimelineLabels(steps) {
  return steps.map((step, index) => step.label || `Step ${index + 1}`);
}

export default function StepScrubber({ steps, selectedStepId, onSelect }) {
  if (!steps?.length) return null;

  const labels = getTimelineLabels(steps);
  const selectedIndex = Math.max(0, steps.findIndex((step) => step.id === selectedStepId));
  const progress = steps.length <= 1 ? 0 : (selectedIndex / (steps.length - 1)) * 100;

  return (
    <section className="mb-5 px-1 opacity-70 transition-opacity duration-200 hover:opacity-100">
      <div className="mb-2 flex items-center justify-end">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
          {selectedIndex + 1}/{steps.length}
        </span>
      </div>
      <div className="relative">
        <div className="absolute left-3 right-3 top-4 h-px bg-neutral-200" />
        <div className="absolute left-3 top-4 h-px bg-neutral-500" style={{ width: selectedIndex === 0 ? "0%" : `calc(${progress}% - 1.5rem)` }} />
        <div className="relative grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((step, index) => {
            const active = index === selectedIndex;
            const complete = index < selectedIndex;
            return (
              <button
                key={step.id}
                type="button"
                onClick={() => onSelect(step.id)}
                className="group flex min-w-0 flex-col items-center gap-2 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                <span
                  className={cn(
                    "relative z-10 flex h-6 w-6 items-center justify-center rounded-full border font-mono text-[10px] font-semibold transition-all duration-200",
                    active
                      ? "border-neutral-900 bg-neutral-900 text-white"
                      : complete
                        ? "border-neutral-400 bg-white text-neutral-600"
                        : "border-neutral-200 bg-white text-neutral-400 group-hover:border-neutral-400 group-hover:text-neutral-700"
                  )}
                >
                  {index + 1}
                </span>
                <span className={cn(
                  "truncate text-[11px] leading-4 transition-colors",
                  active ? "text-neutral-900" : "text-neutral-500 group-hover:text-neutral-700"
                )}>
                  {labels[index] || step.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
