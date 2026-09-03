import { inspectReasoningCandidate } from "../src/lib/reasoningLatexDiagnostics.js";

function reasoningLatexDiagnosticsEnabled() {
  return process.env.NODE_ENV !== "production" && (
    process.env.OMNIMATH_DEBUG_REASONING_LATEX === "true"
    || process.env.OMNIMATH_DEBUG_REASONING_LATEX === "1"
  );
}

export function logBackendReasoningLatexStage(stage, candidate) {
  if (!reasoningLatexDiagnosticsEnabled()) return;
  console.info("[omnimath:reasoning-latex]", inspectReasoningCandidate(candidate, {
    stage,
    stepSelector: process.env.OMNIMATH_DEBUG_REASONING_LATEX_STEPS || "1,2",
  }));
}
