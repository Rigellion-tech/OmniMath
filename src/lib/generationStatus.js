import { getStatusStepText } from "./problemLabels.js";
import { getSolutionSteps } from "./solutionSteps.js";

export function getGeneratedProblemStatus(data = {}, problemData = {}) {
  const problemSteps = getSolutionSteps(problemData);
  const steps = problemSteps.length > 0 ? problemSteps : getSolutionSteps(data);
  const hasSteps = steps.length > 0;
  const saveWarning = data.runtime?.saveWarning || data.saveWarning || "";

  if (!hasSteps) {
    return {
      type: "error",
      label: "No solution steps returned",
      detail: "The solver response did not include renderable steps.",
      meta: "",
    };
  }

  if (saveWarning) {
    return {
      type: "warning",
      label: "Solved but not saved",
      detail: getStatusStepText(steps),
      meta: saveWarning === "auth_expired" ? "Sign in again to save" : "Live solution only",
    };
  }

  return {
    type: "success",
    label: "Explanation ready",
    detail: getStatusStepText(steps),
    meta: data.runtimeNotice || "",
  };
}

export function getFinalSolveTimeoutStatus({ source = "text", code = "AI_SOLVE_TIMEOUT", retryable = false } = {}) {
  const reviewedImage = source === "image-solve";
  return {
    type: "error",
    label: "Solve timed out",
    detail: reviewedImage
      ? "The solver reached its time limit before producing a usable solution. Your reviewed problem has been preserved so you can retry."
      : "The solver reached its time limit before producing a usable solution. Your problem has been preserved so you can retry.",
    meta: reviewedImage ? "Retry solve from the reviewed extraction." : "",
    code,
    retryable,
  };
}
