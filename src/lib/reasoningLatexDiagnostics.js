import { inspectMathTextPipeline } from "./mathTextSegments.js";

function selectedStepNumbers(value = "1,2") {
  const numbers = String(value || "1,2")
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item) && item > 0);
  return new Set(numbers.length > 0 ? numbers : [1, 2]);
}

function reasoningValue(step = {}) {
  if (typeof step.reasoning === "string") return step.reasoning;
  if (typeof step.summary === "string") return step.summary;
  if (typeof step.plainExplanation === "string") return step.plainExplanation;
  return "";
}

export function shouldTraceReasoningStep(stepIndex, selector = "1,2") {
  return selectedStepNumbers(selector).has(Number(stepIndex) + 1);
}

export function inspectReasoningValue(value = "") {
  return inspectMathTextPipeline(String(value ?? ""));
}

export function inspectReasoningCandidate(candidate = {}, {
  stage = "unknown",
  stepSelector = "1,2",
} = {}) {
  const steps = Array.isArray(candidate?.steps) ? candidate.steps : [];
  return {
    stage,
    selectedStepNumbers: [...selectedStepNumbers(stepSelector)],
    steps: steps.flatMap((step, stepIndex) => {
      if (!shouldTraceReasoningStep(stepIndex, stepSelector)) return [];
      return [{
        stepIndex,
        stepNumber: stepIndex + 1,
        stepId: step?.id || null,
        field: typeof step?.reasoning === "string" ? "reasoning" : "summary",
        ...inspectReasoningValue(reasoningValue(step)),
      }];
    }),
  };
}
