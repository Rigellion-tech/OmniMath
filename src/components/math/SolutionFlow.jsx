import React, { useMemo, useState } from "react";
import SolutionStep, { InteractiveMathLine } from "./MathStep";
import MathText from "./MathText";
import { assessSolutionFinalAnswerPresentations, presentSolutionSteps } from "@/lib/finalAnswerPresentation";

function CompleteResultDisclosure({ latex, ownerId }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="min-w-0 max-w-full px-3 pb-4 md:px-6" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm text-neutral-600">View complete supplied result</summary>
      {open && <div className="omni-step-lines mt-3 min-w-0 max-w-full">
        <InteractiveMathLine line={{ id: `${ownerId}-complete-result-line`, kind: "math", latex, tokens: [] }} stepId={`${ownerId}-complete-supplied-result`} />
      </div>}
    </details>
  );
}

export default function SolutionFlow({
  steps,
  problem = /** @type {any} */ ({}),
  requestId = "",
  progressive = false,
  selectedStepId,
  expandedStepIds,
  onSelect,
  onToggleExpanded,
}) {
  // Recompute from the actual displayed prefix, including restored sessions.
  // Never replace canonical steps or their progressive publication identities.
  const presentations = useMemo(() => assessSolutionFinalAnswerPresentations({ ...problem, steps }, {
    validationFindings: problem.finalAnswerPresentation?.findings?.map(({ issue }) => issue) || [],
  }), [problem, steps]);
  const presentedSteps = useMemo(() => presentations.reduce((current, plan) => presentSolutionSteps(current, plan), steps), [steps, presentations]);
  return (
    <div
      className="omni-solution-flow flex flex-col gap-0"
      data-solve-request-id={requestId || undefined}
      data-final-answer-action={presentations.map((plan) => plan.action).join(" ")}
    >
      {presentedSteps.map((step, index) => (
        step.presentationOnly ? (
          <article key={step.id} data-step-id={step.id} data-final-answer="true" className="step-card notebook-step final-answer-step min-w-0 max-w-full px-3 py-3.5 md:px-6 md:py-4">
            <p className="text-base font-semibold text-neutral-950 md:text-lg">Final Answer</p>
            <div className="omni-step-lines mt-2 min-w-0 max-w-full">
              <InteractiveMathLine line={{ id: `${step.id}-line`, kind: "math", role: "final_answer", latex: step.math, tokens: [] }} stepId={step.id} />
            </div>
          </article>
        ) : <SolutionStep
          key={step.id}
          step={step}
          index={index}
          requestId={requestId}
          progressive={progressive}
          selected={selectedStepId === step.id}
          expanded={Boolean(expandedStepIds[step.id])}
          onSelect={onSelect}
          onToggleExpanded={onToggleExpanded}
        />
      ))}
      {presentations.flatMap((presentation) => ["suppressed", "fallback"].includes(presentation.action) ? presentation.retainedFinalText || [] : []).map(({ stepId, text }, index) => (
        <p key={`${stepId}-${index}`} className="omni-text-wrap-safe px-3 py-2 text-sm leading-6 text-neutral-600 md:px-6"><MathText>{text}</MathText></p>
      ))}
      {presentations.map((presentation, index) => presentation.action === "fallback" && presentation.latex && (
        <div key={index} className="min-w-0 max-w-full">
          <p className="omni-text-wrap-safe px-3 py-2 text-sm leading-6 text-neutral-600 md:px-6">{presentation.fallbackText}</p>
          <CompleteResultDisclosure key={`${requestId}-${presentation.latex}`} latex={presentation.latex} ownerId={presentation.finalStepIds[0] || `result-${index}`} />
        </div>
      ))}
    </div>
  );
}
