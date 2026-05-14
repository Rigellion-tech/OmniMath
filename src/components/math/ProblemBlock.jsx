import React, { useEffect, useState } from "react";
import { MousePointer2 } from "lucide-react";
import InlineMath from "./InlineMath";
import MathStep from "./MathStep";

export default function ProblemBlock({ problem }) {
  const [selectedStepId, setSelectedStepId] = useState(problem.steps?.[0]?.id ?? null);
  const steps = problem.steps ?? [];

  useEffect(() => {
    setSelectedStepId(problem.steps?.[0]?.id ?? null);
  }, [problem]);

  return (
    <section className="solution-board min-w-0">
      <div className="mb-5 flex flex-col gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)] md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-teal-200/70">
              Current problem
            </span>
            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-slate-300/60">
              {steps.length} steps
            </span>
          </div>
          <h2 className="text-2xl font-semibold tracking-normal text-cyan-50 md:text-3xl">
            {problem.title}
          </h2>
          <div className="mt-3 max-w-full overflow-x-auto rounded-xl border border-teal-300/[0.12] bg-teal-300/[0.045] px-4 py-3 font-serif text-xl italic text-cyan-50/90 omni-scrollbar">
            <InlineMath math={problem.expression} />
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-full border border-teal-300/[0.14] bg-teal-300/[0.055] px-3 py-1.5 text-xs text-slate-300/60">
          <MousePointer2 className="h-3.5 w-3.5 text-teal-200/70" />
          Select a step or inspect any token.
        </div>
      </div>

      {steps.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-8 text-center text-sm text-slate-300/60">
          No solution steps are available yet.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {steps.map((step, index) => (
            <MathStep
              key={step.id}
              step={step}
              index={index}
              selected={selectedStepId === step.id}
              onSelect={setSelectedStepId}
            />
          ))}
        </div>
      )}
    </section>
  );
}
