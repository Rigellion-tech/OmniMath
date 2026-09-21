import React from "react";
import SolutionStep from "./MathStep";

export default function SolutionFlow({
  steps,
  requestId = "",
  selectedStepId,
  expandedStepIds,
  onSelect,
  onToggleExpanded,
}) {
  return (
    <div
      className="omni-solution-flow flex flex-col gap-0"
      data-solve-request-id={requestId || undefined}
    >
      {steps.map((step, index) => (
        <SolutionStep
          key={step.id}
          step={step}
          index={index}
          requestId={requestId}
          selected={selectedStepId === step.id}
          expanded={Boolean(expandedStepIds[step.id])}
          onSelect={onSelect}
          onToggleExpanded={onToggleExpanded}
        />
      ))}
    </div>
  );
}
