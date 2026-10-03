import { assertSolveCandidateStructure, inspectSolveCandidateStructure } from "./solveCandidateStructure.js";
import { decideCandidateAcceptance } from "./solveAcceptancePolicy.js";
import { verifySolution } from "./verification/solutionVerifier.js";
import { assessMathematicalAssurance } from "./mathAssurancePolicy.js";
import { assessSolutionFinalAnswerPresentations } from "../src/lib/finalAnswerPresentation.js";
import { getSolveDiagnosticContext } from "./solveDiagnosticContext.js";

function annotatedTokenCount(steps) {
  const pending = steps.flatMap((step) => (step.expressions || []).flatMap((expression) => expression.tokens || []));
  let count = 0;
  while (pending.length && count < 10000) {
    const token = pending.pop();
    count += 1;
    if (Array.isArray(token?.children)) pending.push(...token.children);
  }
  return { count, capped: pending.length > 0, source: "server_expression_tokens" };
}

export function assessSolveCandidate(result, context = {}) {
  const structural = inspectSolveCandidateStructure(result, {
    requireFinalAnswer: context.requireFinalAnswer !== false,
  });
  const verification = structural.usable ? verifySolution(result, context) : null;
  const assurance = structural.usable ? assessMathematicalAssurance(verification, context) : null;
  return { structural, verification, assurance,
    acceptance: decideCandidateAcceptance({ structural, verification, assurance }) };
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
  result.assurance = assessment.assurance;
  result.candidateAcceptance = assessment.acceptance;
  // Presentation is a projection of accepted evidence. It never edits the
  // mathematics inspected by assurance and never requests another solve.
  const presentations = assessSolutionFinalAnswerPresentations(result, {
    validationFindings: assessment.structural.warnings.filter((finding) => finding.startsWith("finalAnswerLatex:")),
  });
  result.finalAnswerPresentation = presentations[0];
  result.finalAnswerStepPresentations = presentations.slice(1);
  const diagnosticContext = getSolveDiagnosticContext();
  for (const presentation of presentations) {
    const { latex: _latex, retainedFinalText: _retainedText, ...presentationDiagnostics } = presentation;
    console.info("[omnimath:final-answer-presentation]", {
      requestId: context.requestId || diagnosticContext.requestId || result.requestId || null,
      candidateId: context.candidateId || result.assurance?.candidateId || result._omniOpenAiDiagnostics?.candidateId || null,
      ...presentationDiagnostics,
      finalCardAnnotatedTokens: annotatedTokenCount(result.steps.filter((step) => presentation.finalStepIds.includes(step.id))),
    });
  }
  return result;
}
