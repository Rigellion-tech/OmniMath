import { assertSolveCandidateStructure, inspectSolveCandidateStructure } from "./solveCandidateStructure.js";
import { decideCandidateAcceptance } from "./solveAcceptancePolicy.js";
import { verifySolution } from "./verification/solutionVerifier.js";

export function assessSolveCandidate(result, context = {}) {
  const structural = inspectSolveCandidateStructure(result, {
    requireFinalAnswer: context.requireFinalAnswer !== false,
  });
  const verification = structural.usable ? verifySolution(result, context) : null;
  return { structural, verification, acceptance: decideCandidateAcceptance({ structural, verification }) };
}

/** Run once after normalization/local adjustment, before final presentation.
 * Additive metadata preserves all existing steps and hidden usage diagnostics.
 * Provider-supplied evidence is always replaced by a server-side assessment.
 */
export function finalizeSolveCandidate(result, context = {}) {
  assertSolveCandidateStructure(result, {
    stage: "accepted",
    requestId: context.requestId,
    endpoint: context.endpoint,
    requireFinalAnswer: context.requireFinalAnswer !== false,
  });
  const assessment = assessSolveCandidate(result, context);
  result.verification = assessment.verification;
  result.candidateAcceptance = assessment.acceptance;
  return result;
}
