import React from "react";
import SolutionStep from "./MathStep";

export default function SolutionFlow({
  steps,
  selectedStepId,
  expandedStepIds,
  onSelect,
  onToggleExpanded,
}) {
  return (
    <div className="omni-solution-flow flex flex-col gap-0">
      {steps.map((step, index) => (
        <SolutionStep
          key={step.id}
          step={step}
          index={index}
          selected={selectedStepId === step.id}
          expanded={Boolean(expandedStepIds[step.id])}
          onSelect={onSelect}
          onToggleExpanded={onToggleExpanded}
        />
      ))}
    </div>
  );
}
