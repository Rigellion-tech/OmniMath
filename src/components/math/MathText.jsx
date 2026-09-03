import React from "react";
import InlineMath from "./InlineMath";
import { inspectMathTextPipeline } from "@/lib/mathTextSegments";
import { shouldTraceReasoningStep } from "@/lib/reasoningLatexDiagnostics";

export default function MathText({ children, className = "", diagnosticStepIndex = null }) {
  const text = typeof children === "string" ? children : String(children ?? "");
  const inspection = inspectMathTextPipeline(text);
  const stepSelector = import.meta.env.VITE_DEBUG_REASONING_LATEX_STEPS || "1,2";
  const traceReasoning = import.meta.env.DEV
    && import.meta.env.VITE_DEBUG_REASONING_LATEX === "true"
    && Number.isInteger(diagnosticStepIndex)
    && shouldTraceReasoningStep(diagnosticStepIndex, stepSelector);
  const parts = inspection.parts;

  if (traceReasoning) {
    console.info("[omnimath:reasoning-latex]", {
      stage: "5-6.frontend_segmentation_and_inline_normalization",
      stepIndex: diagnosticStepIndex,
      stepNumber: diagnosticStepIndex + 1,
      ...inspection,
      parts: undefined,
    });
  }

  return (
    <span className={className}>
      {parts.map((part, index) => (
        part.type === "math"
          ? (
            <InlineMath
              key={part.key || `math-${index}`}
              math={part.value}
              className={part.displayMode ? "omni-block-math" : "omni-inline-math"}
              displayMode={part.displayMode}
              diagnosticReasoningStepIndex={traceReasoning ? diagnosticStepIndex : null}
              diagnosticReasoningSpanIndex={index}
            />
          )
          : <React.Fragment key={`text-${index}`}>{part.value}</React.Fragment>
      ))}
    </span>
  );
}
