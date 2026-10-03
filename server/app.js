import crypto from "node:crypto";
import { getEnvLoadStatus, loadEnvFiles } from "./env.js";
import {
  buildImageExtractionPrompt,
  buildCompareMethodsPrompt,
  buildMathExplanationPrompt,
  buildTokenExplanationPrompt,
} from "./mathPrompt.js";
import { parseMultipartForm } from "./multipart.js";
import {
  createMathExplanation,
  createImageProblemExtraction,
  estimateImageExtractionReservation,
  createFollowupAnswer,
  streamFollowupAnswer,
  createCompareMethods,
  createLazyTokenExplanation,
  debugOpenAiConnection,
  estimateOpenAiCost,
  estimateOpenAiCostBudget,
  estimateOpenAiTokenBudget,
  getOpenAiRuntimeConfig,
  getLazyMaxOutputTokens,
  isOpenAiConfigured,
  normalizeOpenAiUsage,
  getSolveMaxOutputTokens,
  getSolveOutputTokenBudget,
  getSolveTotalTimeoutMs,
  logSolveCandidateOutcome,
  normalizeProviderSolveCandidate,
  streamMathExplanation,
} from "./openai.js";
import { createSolveBudget } from "./solveBudget.js";
import { createProgressiveJsonFramer } from "./progressiveJsonFramer.js";
import { createProgressiveStepValidator } from "./progressiveStepValidation.js";
import { classifyProgressiveFailure, decideProgressiveRecovery } from "./progressiveRecoveryPolicy.js";
import { decideOrdinaryRecovery } from "./ordinaryRecoveryPolicy.js";
import {
  buildModelExecutionConfig,
  isMeaningfullyDifferentEscalationConfig,
} from "./modelExecutionConfig.js";
import { progressiveProviderEnabled } from "./progressiveCanaryConfig.js";
import {
  checkAndReserveUsage,
  createUsageHeaders,
  getUsageSnapshot,
  releaseTokenReservation,
  settleTokenUsage,
} from "./usageLimits.js";
import { getClerkAuthRuntimeConfig, requireClerkIdentity } from "./usageIdentity.js";
import { throttleRequest } from "./requestThrottle.js";
import { runDeduplicatedRequest } from "./duplicateRequests.js";
import { imageIngestionRegistry, ingestionDigest } from "./imageIngestionRegistry.js";
import { applyLocalRulesToExplanation, createLocalRuleExplanation } from "./localRules.js";
import { annotateMathExplanation } from "./mathAnnotator.js";
import { validateExtraction } from "./extractionValidation.js";
import {
  getOpenAiModelForPath,
  getOpenAiSamplingForPath,
  resolveOpenAiRequestTimeout,
  selectOpenAiModel,
} from "./openaiModels.js";
import {
  buildProvenanceFollowupPrompt,
  createGeneralFollowupFallback,
  followupCorrelation,
} from "./followupProvenance.js";
import { chooseSolverRoleForProblem } from "./solverRouting.js";
import { buildExtractedProblemDisplay, normalizeExtractedProblemText } from "./ocrTextNormalization.js";
import { createMethodFingerprint } from "./mathValidationAnalysis.js";
import { analyzeSymbolOrigins } from "./symbolInventory.js";
import { captureFailedSolveDiagnostic } from "./failedSolveDiagnostics.js";
import { assertSolveCandidateStructure as acceptStructurallyParsedSolve, inspectSolveCandidateStructure } from "./solveCandidateStructure.js";
import { finalizeSolveCandidate } from "./solveCandidateLifecycle.js";
import { decideAssuranceRecovery, finalizeAssuranceSelection, selectAssuranceCandidate } from "./mathAssurancePolicy.js";
import { decideCandidateAcceptance } from "./solveAcceptancePolicy.js";
import { assessOcrSolveDecision, assertOcrSolveAllowed } from "./ocrSolvePolicy.js";
import { getSolveDiagnosticContext, withSolveDiagnosticContext } from "./solveDiagnosticContext.js";
import {
  createExplanationCacheKey,
  createImageHash,
  getCachedExplanation,
  setCachedExplanation,
} from "./explanationCache.js";
import { traceMathStage } from "../src/lib/mathNode.js";
import {
  getCanonicalSolverInput,
  logCanonicalProblem,
  normalizeCanonicalProblem,
} from "./solveRequestContext.js";
import { stripTerminalControlSequences } from "../src/lib/textSanitization.js";
import {
  createUserSessionForRequest,
  deleteUserSessionForRequest,
  getCurrentUserData,
  getCurrentUserHistory,
  getCurrentUserSessions,
  saveExplanationForRequest,
  updateUserSessionForRequest,
} from "./userData.js";

loadEnvFiles();

const MAX_JSON_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PROBLEM_CHARS = 4000;
const MAX_HISTORY_ITEMS = 10;
const MAX_HISTORY_ITEM_CHARS = 1000;
const MAX_FOLLOWUP_QUESTION_CHARS = 1000;
const MAX_PROBLEM_CONTEXT_CHARS = 600;
const MAX_SELECTED_LATEX_CHARS = 1200;
const MAX_STEP_LATEX_CHARS = 2400;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

// Private, server-owned context used by source adapters. Public request fields
// cannot select quota or persistence policy.
const canonicalSolveRequestContexts = new WeakMap();
const activeFollowupStreams = new Set();

function imageSolveTelemetry(sourceMetadata) {
  const ingestion = sourceMetadata?.ingestion;
  if (!ingestion) return {};
  return {
    logicalImageIngestionRequestId: ingestion.ingestionRequestId,
    ingestionRequestId: ingestion.ingestionRequestId,
    imageHash: ingestion.imageHash,
    uploadId: ingestion.uploadId,
    extractionId: ingestion.extractionId,
    selectedExtractionId: ingestion.extractionId,
    reviewRevision: ingestion.reviewRevision,
    reviewRevisionId: ingestion.reviewRevisionId,
    canonicalProblemId: sourceMetadata.canonicalProblemId,
    canonicalSolveRequestId: sourceMetadata.canonicalSolveRequestId,
  };
}

function isSolveDebugEnabled() {
  return process.env.NODE_ENV !== "production" && (
    process.env.OMNIMATH_DEBUG_SOLVE === "true"
    || process.env.OMNIMATH_DEBUG_SOLVE === "1"
    || process.env.VITE_DEBUG_SOLUTION_STATE === "true"
  );
}

function isHoverDebugEnabled() {
  return process.env.NODE_ENV !== "production" && (
    process.env.VITE_DEBUG_MATH_HOVER === "true"
    || process.env.VITE_DEBUG_MATH_HOVER === "1"
    || process.env.VITE_DEBUG_SEMANTIC_HITBOXES === "true"
  );
}

function createDebugRequestId(prefix = "req") {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Adapt an incoming request for an internal route without dropping headers.
 * Node's IncomingMessage exposes some request properties through accessors;
 * spreading it is therefore not a faithful copy and, in particular, loses
 * `authorization`/cookies.  Internal image/OCR adapters must preserve auth
 * ownership just like a same-origin browser request.
 */
export function copyInternalRequest(req, overrides = {}) {
  const headers = {
    ...(req?.headers || {}),
    ...(overrides.headers || {}),
  };
  return {
    ...req,
    ...overrides,
    method: overrides.method || req?.method,
    headers,
  };
}

function hashDebugText(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function logSolveDebug(event, details = {}) {
  if (!isSolveDebugEnabled()) return;
  console.info("[omnimath:solve-debug]", {
    event,
    ...details,
  });
}

function logSolveRecovery(event, details = {}) {
  console.info("[omnimath:solve-recovery]", {
    event,
    eventTimestamp: new Date().toISOString(),
    ...details,
  });
}

function logAssuranceChecks({ requestId, endpoint, assurance, attemptId = null }) {
  for (const check of assurance?.checks || []) {
    logSolveRecovery("verification_check", {
      requestId, endpoint, attemptId,
      routeAttemptId: assurance.routeAttemptId,
      candidateId: assurance.candidateId,
      verificationAttemptId: assurance.verificationAttemptId,
      checkId: check.checkId, applicability: check.applicability,
      classification: check.classification, scope: check.scope,
      outcome: check.outcome, contradictionCategory: check.category,
      assuranceStatus: assurance.status,
    });
  }
}

export function resolveInitialSolveRouting(input = {}) {
  const decision = chooseSolverRoleForProblem(input);
  const routeSource = decision.role === "solver" ? "default" : "difficulty-based";
  const selectedInitialModelPath = decision.role === "solver" ? "canonicalSolve" : decision.role;
  const selection = selectOpenAiModel({
    modelPath: selectedInitialModelPath,
    debugContext: { attemptType: "initial" },
  });
  return {
    routingDecision: decision.tier,
    routingReason: decision.reason,
    selectedInitialModelRole: decision.role,
    selectedInitialModelPath,
    selectedInitialModel: selection.modelId,
    selectedInitialReasoningEffort: selection.reasoningEffort,
    selectedInitialTimeoutMs: selection.timeoutMs,
    structuredOutputPolicy: selection.structuredOutput ? "strict_json_schema" : "provider_default",
    recoveryEligible: decision.tier !== "standard",
    routeSource,
  };
}

function solveExecutionConfig({
  modelPath = "canonicalSolve",
  attemptType = "initial",
  recoveryPurpose = "initial_generation",
  promptStrategy = "canonical_problem",
  responseMode = "full_response_json",
  compact = false,
} = {}) {
  const debugContext = { attemptType, retryPurpose: compact ? "compact" : recoveryPurpose };
  return buildModelExecutionConfig({
    modelPath,
    debugContext,
    responseMode,
    structuredOutputPolicy: {
      type: "json_schema",
      schema: compact ? "math_compact_solve" : "math_fast_solve",
      strict: true,
    },
    recoveryPurpose,
    promptStrategy,
    maxOutputTokens: getSolveOutputTokenBudget({ compact, modelPath, debugContext }),
  });
}

function logInitialSolveRouting({ requestId = "", endpoint = "", routing = {} } = {}) {
  console.info("[omnimath:solve-routing]", {
    requestId,
    endpoint,
    routingDecision: routing.routingDecision || null,
    routingReason: routing.routingReason || null,
    selectedInitialModelRole: routing.selectedInitialModelRole || null,
    selectedInitialModelPath: routing.selectedInitialModelPath || null,
    selectedInitialModel: routing.selectedInitialModel || null,
    selectedInitialReasoningEffort: routing.selectedInitialReasoningEffort || null,
    selectedInitialTimeoutMs: routing.selectedInitialTimeoutMs || null,
    structuredOutputPolicy: routing.structuredOutputPolicy || null,
    recoveryEligible: Boolean(routing.recoveryEligible),
    routeSource: routing.routeSource || null,
  });
}

function logHoverDebug(event, details = {}) {
  if (!isHoverDebugEnabled()) return;
  console.info("[omnimath:hover-debug]", {
    event,
    ...details,
  });
}

function isGenericImageProblemPrompt(value = "") {
  return /explain\s+(?:the\s+)?math\s+problem\s+in\s+this\s+image/i.test(String(value || ""));
}

function problemForSymbolDiagnostics(problem = "", result = {}) {
  if (isGenericImageProblemPrompt(problem)) {
    return result?.extractedProblemLatex || result?.expression || result?.originalProblem || problem || "";
  }
  return problem || result?.extractedProblemLatex || result?.originalProblem || result?.expression || result?.problem || "";
}

function logAcceptedSolvePayload({ requestId = "", endpoint = "", problem = "", result = {}, source = "" } = {}) {
  if (!isSolveDebugEnabled()) return;
  const symbolProblem = problemForSymbolDiagnostics(problem, result);
  const symbolDiagnostics = analyzeSymbolOrigins(symbolProblem, result);
  logSolveDebug("final_accepted_payload", {
    requestId,
    endpoint,
    source,
    normalizedOriginalProblem: symbolProblem,
    finalAnswerLatex: result?.finalAnswerLatex || result?.finalAnswer || "",
    stepCount: Array.isArray(result?.steps) ? result.steps.length : 0,
    originalSymbolInventory: symbolDiagnostics.originalSymbols,
    generatedSymbolInventory: symbolDiagnostics.generatedSymbols,
    newlyIntroducedSymbols: symbolDiagnostics.newlyIntroducedSymbols,
    unexplainedSymbols: symbolDiagnostics.unexplainedSymbols,
    boundSymbolProvenance: symbolDiagnostics.boundSymbolProvenance,
    finalAcceptedPayload: result,
  });
}

function logExtractionReviewDebug(validation, correlation = {}) {
  if (process.env.NODE_ENV === "production") return;
  console.info("[omnimath:ocr-review]", {
    ...correlation,
    path: "extractionReview",
    model: getOpenAiModelForPath("extractionReview"),
    llmReviewCalled: false,
    confidence: validation?.confidence,
    tier: validation?.tier,
    critical: Boolean(validation?.critical),
    reasons: Array.isArray(validation?.issues)
      ? validation.issues.map((issue) => ({
          type: issue.type,
          severity: issue.severity,
          critical: Boolean(issue.critical),
          message: issue.message,
        }))
      : [],
    metrics: validation?.metrics || null,
  });
}

const MAX_REPAIR_EVIDENCE_CHARS = 1400;
const MAX_REPAIR_EVIDENCE_ITEM_CHARS = 420;
const MAX_PREVIOUS_INVALID_SOLUTION_CHARS = 6000;

const RULE_SPECIFIC_REPAIR_INSTRUCTIONS = {
  unsupported_integration_by_parts_setup: [
    "For unsupported_integration_by_parts_setup:",
    "- If integration by parts is used, explicitly provide u, dv, du, a correct explicit v, and the substituted integration-by-parts equation.",
    "- Verify v by differentiating it before using it.",
    "- Do not leave v as an unevaluated integral.",
    "- Do not invent or assert an antiderivative identity without checking it.",
    "- If dv has no usable closed form, abandon that integration-by-parts choice and use a different method.",
    "- Preserve the original problem and independently verify the final answer.",
  ],
  sign_contradiction_positive_integrand_negative_answer: [
    "For sign_contradiction_positive_integrand_negative_answer:",
    "- Recompute from the first sign error; a positive integrand over ordered bounds cannot have a negative value.",
    "- Verify the sign of every transformed factor and the final constant before answering.",
  ],
  sign_contradiction_reversed_positive_integrand_positive_answer: [
    "For sign_contradiction_reversed_positive_integrand_positive_answer:",
    "- Recompute from the first sign error; reversed bounds change the sign of a positive integrand.",
    "- Verify bound order and orientation before simplifying.",
  ],
  numerical_final_answer_mismatch: [
    "For numerical_final_answer_mismatch:",
    "- Rebuild the derivation from the earliest suspect step; do not change only finalAnswerLatex to match a number.",
    "- Verify the exact final value against a reliable numerical estimate before answering.",
  ],
  invalid_antiderivative: [
    "For invalid_antiderivative:",
    "- Do not preserve the invalid antiderivative or identity.",
    "- Differentiate any claimed antiderivative before using it.",
  ],
  unverified_critical_identity: [
    "For unverified_critical_identity:",
    "- Either derive the identity from a valid parameter family/theorem or use a different method.",
    "- Do not cite Beta, Gamma, digamma, or special-function identities without showing why they match the original integrand.",
  ],
  parameter_derivative_mismatch: [
    "For parameter_derivative_mismatch:",
    "- Verify that differentiating the introduced parameter family reproduces the original integrand at the stated parameter.",
    "- If it does not, choose a corrected family or a different method.",
  ],
  incorrect_substitution_jacobian: [
    "For incorrect_substitution_jacobian:",
    "- Redo the substitution from the differential and Jacobian, preserving every transformed factor and bound.",
    "- Do not reuse a transformed integral whose algebra has not been verified.",
  ],
  final_answer_not_supported_by_steps: [
    "For final_answer_not_supported_by_steps:",
    "- Connect the final answer to the last evaluated expression with valid equalities or recompute from the unsupported jump.",
  ],
  final_answer_sign_inconsistent_with_steps: [
    "For final_answer_sign_inconsistent_with_steps:",
    "- Recompute from the sign-changing step; do not flip signs in the final answer without justification.",
  ],
  unsupported_special_function_simplification: [
    "For unsupported_special_function_simplification:",
    "- Show the special-function identity used for simplification and verify it before converting to constants.",
  ],
  unsupported_numeric_final_answer_syntax: [
    "For unsupported_numeric_final_answer_syntax:",
    "- Rewrite the final answer using standard evaluable LaTeX syntax such as \\frac, \\ln, powers, and ordinary numbers.",
    "- Do not change only formatting if the derivation or value is mathematically wrong.",
  ],
};

function normalizeRepairIssueList(issues = []) {
  return [...new Set((Array.isArray(issues) ? issues : [issues])
    .map((issue) => String(issue || "").trim())
    .filter(Boolean))];
}

const STRUCTURAL_REPAIR_ISSUES = new Set([
  "strict_generated_latex",
  "missing_final_answer",
  "undefined_final_placeholder",
  "unsupported_numeric_final_answer_syntax",
  "malformed_set_valued_answer",
  "detached_relation_leading_fragment",
  "step_renderable_content",
]);

function unexplainedSymbolAffectsMathematics(issue = "", error = null) {
  if (!String(issue || "").startsWith("unexplained_generated_symbol:")) return false;
  const evaluations = failedEvaluationsForIssue(error || {}, issue);
  if (evaluations.length === 0) return false;
  return evaluations.some((evaluation) => {
    const evidence = parseRedactedEvaluationEvidence(evaluation);
    const sourceType = String(evidence?.sourceType || "");
    const fieldPath = String(evidence?.fieldPath || evaluation.inputFields?.[0] || "");
    return sourceType === "finalAnswer" || /finalAnswer/iu.test(fieldPath);
  });
}

function isStructuralRepairIssue(issue = "", { error = null } = {}) {
  const normalized = String(issue || "").trim();
  if (normalized.startsWith("unexplained_generated_symbol:")) {
    return !unexplainedSymbolAffectsMathematics(normalized, error);
  }
  return STRUCTURAL_REPAIR_ISSUES.has(normalized)
    || normalized.startsWith("invalid_latex:")
    || normalized.startsWith("strict_generated_latex:");
}

export function categorizeRepairIssues(issues = [], { error = null } = {}) {
  const normalizedIssues = normalizeRepairIssueList(issues);
  if (normalizedIssues.length === 0) {
    return {
      category: "mathematical",
      structuralIssues: [],
      mathematicalIssues: [],
      unknownIssues: [],
    };
  }
  const structuralIssues = normalizedIssues.filter((issue) => isStructuralRepairIssue(issue, { error }));
  const nonStructuralIssues = normalizedIssues.filter((issue) => !isStructuralRepairIssue(issue, { error }));
  return {
    category: nonStructuralIssues.length === 0 ? "structural" : "mathematical",
    structuralIssues,
    mathematicalIssues: nonStructuralIssues,
    unknownIssues: nonStructuralIssues,
  };
}

function extractUnexplainedGeneratedSymbols(issues = []) {
  return normalizeRepairIssueList(issues)
    .map((issue) => issue.match(/^unexplained_generated_symbol:(.+)$/u)?.[1]?.trim() || "")
    .filter(Boolean)
    .filter((symbol, index, symbols) => symbols.indexOf(symbol) === index);
}

function buildSymbolBindingRepairInstructions(issues = []) {
  const symbols = extractUnexplainedGeneratedSymbols(issues);
  if (symbols.length === 0) return "";

  return [
    "For unexplained_generated_symbol:",
    "Undefined generated symbols detected:",
    ...symbols.map((symbol) => `- ${symbol}`),
    "For each listed symbol, do exactly one of the following before reusing it:",
    "1. define it explicitly in rendered LaTeX before first use",
    "2. bind it in valid mathematical notation",
    "3. remove or replace it",
    "- Every substitution variable must be explicitly defined in rendered LaTeX before first use.",
    "- Every named quantity or constant must be explicitly defined in rendered LaTeX before first use.",
    "- Every summation or product index must be bound in the summation/product notation.",
    "- Every integration variable must be bound by a differential or explicitly defined.",
    "- A symbol mentioned only in prose is not considered defined.",
    "- If a symbol is unnecessary, remove it instead of inventing a definition.",
    "- Do not rename the same quantity inconsistently across steps.",
    "- Do not introduce additional symbols while repairing the listed ones.",
    "Valid example shapes: v = g(u); K = Q; \\sum_{j\\in J} a_j; \\int_D f(u)\\,du.",
    "Invalid example shapes: using v before defining it; writing \"let K be the constant\" only in prose; using \\sum_j without a clear bound when j is otherwise unexplained; switching between u and v for the same substitution without defining both.",
  ].join("\n");
}

function sanitizeRepairPromptText(value = "", maxChars = MAX_REPAIR_EVIDENCE_ITEM_CHARS) {
  const sanitized = stripTerminalControlSequences(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > maxChars ? `${sanitized.slice(0, maxChars)}...` : sanitized;
}

function compactPreviousInvalidSolution(result = {}) {
  if (!result || typeof result !== "object") return "Unavailable.";
  const compact = {
    title: result.title || "",
    problem: result.problem || result.originalProblem || result.expression || result.extractedProblemLatex || "",
    finalAnswer: result.finalAnswerLatex || result.finalAnswer || "",
    numericCheck: result.numericCheck || "",
    steps: Array.isArray(result.steps)
      ? result.steps.slice(0, 12).map((step) => ({
          label: step.label || step.title || step.heading || "",
          math: step.math || step.latex || step.equationLatex || "",
          summary: step.summary || step.reasoning || step.plainExplanation || "",
        }))
      : [],
  };
  return sanitizeRepairPromptText(JSON.stringify(compact), MAX_PREVIOUS_INVALID_SOLUTION_CHARS);
}

function collectRepairFailureEvidenceItems(error = {}, issues = []) {
  const issueSet = new Set(normalizeRepairIssueList(issues));
  const evaluations = Array.isArray(error.solutionRuleEvaluations) ? error.solutionRuleEvaluations : [];
  return evaluations
    .filter((evaluation) => (
      evaluation?.result === "fail"
      && evaluation.failureEvidence
      && (
        issueSet.size === 0
        || issueSet.has(evaluation.issue)
        || issueSet.has(evaluation.name)
        || issueSet.has(evaluation.validatorName)
      )
    ))
    .map((evaluation) => `${evaluation.issue || evaluation.name || evaluation.validatorName}: ${sanitizeRepairPromptText(evaluation.failureEvidence)}`);
}

function collectRepairFailureEvidence(error = {}, issues = []) {
  const evidenceItems = collectRepairFailureEvidenceItems(error, issues);

  const uniqueItems = [...new Set(evidenceItems)];
  const joined = uniqueItems.join("\n");
  return sanitizeRepairPromptText(joined, MAX_REPAIR_EVIDENCE_CHARS) || "No exact failure evidence was provided.";
}

function numberOrNull(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseNumericalEvidenceText(value = "") {
  const text = String(value || "");
  const read = (name) => numberOrNull(text.match(new RegExp(`${name}=(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)`, "iu"))?.[1]);
  return {
    numericalEstimate: read("estimate"),
    proposedValue: read("proposed"),
    absoluteDifference: read("absDiff"),
    tolerance: read("tolerance"),
  };
}

function collectNumericalRepairEvidence(error = {}) {
  const contextCheck = error?.solutionValidationContext?.numericalCrossCheckResult || {};
  const evaluationEvidence = Array.isArray(error?.solutionRuleEvaluations)
    ? error.solutionRuleEvaluations
      .filter((evaluation) => (
        evaluation?.result === "fail"
        && (
          evaluation.issue === "numerical_final_answer_mismatch"
          || evaluation.name === "numerical_final_answer_cross_check"
          || evaluation.validatorName === "numerical_final_answer_cross_check"
        )
      ))
      .map((evaluation) => evaluation.failureEvidence || "")
      .find(Boolean)
    : "";
  const parsedEvidence = parseNumericalEvidenceText(evaluationEvidence);
  const evidence = {
    numericalEstimate: numberOrNull(contextCheck.numericalEstimate) ?? parsedEvidence.numericalEstimate,
    proposedValue: numberOrNull(contextCheck.proposedValue) ?? parsedEvidence.proposedValue,
    absoluteDifference: numberOrNull(contextCheck.absoluteDifference) ?? parsedEvidence.absoluteDifference,
    tolerance: numberOrNull(contextCheck.tolerance) ?? parsedEvidence.tolerance,
  };
  const hasEvidence = Object.values(evidence).some((value) => value !== null);
  if (!hasEvidence) return "";
  return [
    "The previous final answer is numerically inconsistent.",
    `- independent numerical estimate: ${evidence.numericalEstimate ?? "unavailable"}`,
    `- proposed model value: ${evidence.proposedValue ?? "unavailable"}`,
    `- absolute difference: ${evidence.absoluteDifference ?? "unavailable"}`,
    `- allowed tolerance: ${evidence.tolerance ?? "unavailable"}`,
  ].join("\n");
}

function compactEscalationFailureSummary(error = {}, issues = [], previousResult = null) {
  const context = error?.solutionValidationContext || {};
  const numerical = collectNumericalRepairEvidence(error);
  const evidence = collectRepairFailureEvidence(error, issues);
  const finalAnswer = previousResult?.finalAnswerLatex || previousResult?.finalAnswer || "";
  const relevantStep = context.relevantStepLatex || "";
  const firstStep = context.firstFailingStepId || "";
  return [
    `Failed validation rules: ${normalizeRepairIssueList(issues).join(", ") || "unknown"}.`,
    firstStep ? `First failing step id: ${sanitizeRepairPromptText(firstStep, 200)}.` : "",
    relevantStep ? `Relevant invalid step excerpt: ${sanitizeRepairPromptText(relevantStep, 800)}` : "",
    finalAnswer ? `Previous final answer to avoid repeating without proof: ${sanitizeRepairPromptText(finalAnswer, 800)}` : "",
    numerical ? `Trusted numerical validation evidence:\n${numerical}` : "",
    evidence ? `Validator evidence:\n${evidence}` : "",
  ].filter(Boolean).join("\n\n");
}

function compactPriorEscalationFailures(priorFailures = []) {
  const summaries = priorFailures.slice(-2).map((failure, index) => {
    const stage = sanitizeRepairPromptText(failure?.stage || `prior-${index + 1}`, 80);
    const issues = failure?.issues || failure?.error?.solutionIssues || [];
    const summary = compactEscalationFailureSummary(
      failure?.error || {},
      issues,
      failure?.result || null,
    );
    return summary ? `${stage}:\n${sanitizeRepairPromptText(summary, 1200)}` : "";
  }).filter(Boolean);
  return sanitizeRepairPromptText(summaries.join("\n\n"), 2400);
}

export function buildFreshEscalationSolvePrompt({
  problem = "",
  canonicalLatex = "",
  canonicalText = "",
  issues = [],
  error = null,
  previousResult = null,
  priorFailures = [],
} = {}) {
  const originalProblem = sanitizeRepairPromptText(problem || canonicalLatex || canonicalText, 2400)
    || "Use the canonical problem below.";
  const trustedLatex = sanitizeRepairPromptText(canonicalLatex || problem, 2400);
  const trustedText = sanitizeRepairPromptText(canonicalText || "", 2000);
  const failureSummary = compactEscalationFailureSummary(error || {}, issues, previousResult);
  const priorFailureSummary = compactPriorEscalationFailures(priorFailures);

  return `You are OmniMath, a careful AI math tutor solving an escalated problem independently.

Fresh escalation task:
- Solve the canonical original problem from scratch.
- Do not repair or continue the previous derivation.
- Do not preserve previous constants, substitutions, final answers, special functions, or numerical claims unless you rederive them from the original problem.
- Use the validator findings only to avoid repeating known invalid reasoning.
- Treat any trusted numerical estimate as a validation constraint, not as a derivation.
- Independently verify the final result numerically against the canonical original problem before answering.
- If you use a special constant or auxiliary function, define it explicitly in rendered LaTeX before first use and prove why it belongs.
- If a closed form is not justified, return a numerically checked value rather than hallucinating a symbolic simplification.

Canonical original problem:
${originalProblem}

Canonical LaTeX:
${trustedLatex || "Unavailable"}

Human-readable canonical text:
${trustedText || "Unavailable"}

Trusted validator findings:
${failureSummary || "No detailed validator findings were available. Solve independently from the canonical problem."}

Earlier rejected candidate findings:
${priorFailureSummary || "No earlier rejected candidate findings were available."}

Output contract:
- Return JSON only. Do not include markdown, comments, code fences, or explanatory prose outside JSON.
- Return only valid JSON matching the requested schema.
- Required fields: title, problemLatex, steps, finalAnswerLatex, numericCheck.
- steps must be an array of 3-8 meaningful items unless the problem truly requires otherwise.
- Each step must include id, heading, latex, reasoning, and anchors.
- Every step must include an anchors array, even when empty.
- Generate at most 3 anchors per step and at most 20 anchors across the whole solution.
- Math-rendered fields must contain pure valid LaTeX only: problemLatex, steps[].latex, finalAnswerLatex, and anchor latex.
- Do not wrap math-rendered fields in Markdown fences, latex code blocks, \\[...\\], $$...$$, or $...$.
- Never put plain text inside math unless it is wrapped in \\text{}.
- Use proper LaTeX function names such as \\ln, \\arctan, \\sin, and \\cos.
- Use LaTeX commands instead of Unicode math symbols: \\int, \\infty, \\frac{}{}, \\le, \\ge, and so on.
- Preserve spacing commands for differentials, such as \\,dx.
- finalAnswerLatex must be exactly one standalone mathematical expression or one equation assigning the original expression to the final value.
- finalAnswerLatex must contain no prose, intermediate derivation, \\Rightarrow, multiline content, display separators, or multiple unrelated equations.
- numericCheck should be a decimal approximation when applicable, or an empty string.
- Keep each reasoning field to 1-2 concise sentences, maximum 35 words.
- Do not restate the entire original problem inside step 1; start with the first meaningful transformation or theorem setup.
- The final answer belongs in finalAnswerLatex and, if included in steps, only as one clearly titled "Final Answer" step at the end.`;
}

function buildRuleSpecificRepairInstructions(issues = []) {
  const normalizedIssues = normalizeRepairIssueList(issues);
  const instructions = normalizedIssues
    .flatMap((issue) => RULE_SPECIFIC_REPAIR_INSTRUCTIONS[issue] || [])
    .join("\n");
  const symbolInstructions = buildSymbolBindingRepairInstructions(normalizedIssues);
  return [instructions, symbolInstructions].filter(Boolean).join("\n") || "No rule-specific instructions.";
}

function buildStructuralRepairInstructions(issues = []) {
  const normalizedIssues = normalizeRepairIssueList(issues);
  const symbolInstructions = buildSymbolBindingRepairInstructions(normalizedIssues);
  const formattingIssues = normalizedIssues.filter((issue) => (
    issue === "strict_generated_latex"
    || issue === "missing_final_answer"
    || issue === "undefined_final_placeholder"
    || issue === "unsupported_numeric_final_answer_syntax"
    || issue === "malformed_set_valued_answer"
    || issue === "detached_relation_leading_fragment"
    || issue === "step_renderable_content"
    || issue.startsWith("invalid_latex:")
    || issue.startsWith("strict_generated_latex:")
  ));
  const formattingInstructions = formattingIssues.length > 0
    ? [
        "For formatting, LaTeX compatibility, final-answer shape, and placeholder issues:",
        "- Repair only the rendered field structure, LaTeX syntax, missing final-answer field, or placeholder definition/removal needed to satisfy the listed validator.",
        "- Keep all mathematical claims, transformations, constants, signs, bounds, and the final value unchanged.",
        "- If finalAnswerLatex is malformed but the previous final value is recoverable from the previous solution, rewrite only that same value as one valid standalone LaTeX expression.",
      ].join("\n")
    : "";
  return [symbolInstructions, formattingInstructions].filter(Boolean).join("\n") || "No structural instructions.";
}

function buildNarrowStructuralRepairPrompt({
  failedRules,
  problem = "",
  previousResult = null,
  error = null,
} = {}) {
  const rulesText = failedRules.join(", ") || "generic_structural_invalid_solution";
  const evidenceText = collectRepairFailureEvidence(error || {}, failedRules);
  const structuralInstructions = buildStructuralRepairInstructions(failedRules);
  const originalProblem = sanitizeRepairPromptText(problem, 2000) || "Use the original problem supplied in this repair request.";
  const previousSolution = compactPreviousInvalidSolution(previousResult || {});
  const previousFinalAnswer = sanitizeRepairPromptText(previousResult?.finalAnswerLatex || previousResult?.finalAnswer || "", 1200);
  const previousNumericCheck = sanitizeRepairPromptText(previousResult?.numericCheck || "", 200);

  return `You are OmniMath, a careful AI math tutor repairing a structurally rejected solution.

Structural repair task:
- Preserve derivation.
- Preserve mathematics.
- Preserve final answer.
- Preserve the previous finalAnswerLatex exactly when it is valid: ${previousFinalAnswer || "Unavailable"}.
- Preserve numericCheck when present: ${previousNumericCheck || "Unavailable"}.
- Only repair symbol introduction.
- Only repair formatting, LaTeX compatibility, field shape, or placeholder resolution required by the listed validation failures.
- Do not recompute.
- Do not regenerate the proof from scratch.
- Do not change the method, constants, identities, signs, bounds, or final value.
- Do not replace the solution with a different derivation.

Canonical problem:
${originalProblem}

Previous structurally invalid solution:
${previousSolution}

Structural validation failures:
${rulesText}

Exact failure evidence:
${evidenceText}

Structural corrective instructions:
${structuralInstructions}

Output contract:
- Return JSON only. Do not include markdown, comments, code fences, or explanatory prose outside JSON.
- Return only valid JSON matching the requested schema.
- Required fields: title, problemLatex, steps, finalAnswerLatex, numericCheck.
- steps must remain the same derivation with only minimal structural edits.
- Each step must include id, heading, latex, reasoning, and anchors.
- Every step must include an anchors array, even when empty.
- Math-rendered fields must contain pure valid LaTeX only: problemLatex, steps[].latex, finalAnswerLatex, and anchor latex.
- Do not wrap math-rendered fields in Markdown fences, latex code blocks, \\[...\\], $$...$$, or $...$.
- Never put plain text inside math unless it is wrapped in \\text{}.
- Use proper LaTeX function names such as \\ln, \\arctan, \\sin, and \\cos.
- Preserve spacing commands for differentials, such as \\,dx.
- finalAnswerLatex must be exactly one standalone mathematical expression or one equation assigning the original expression to the same final value.
- finalAnswerLatex must contain no prose, intermediate derivation, \\Rightarrow, multiline content, display separators, or multiple unrelated equations.
- numericCheck should remain the previous decimal approximation when applicable, or an empty string.
- Keep each reasoning field to 1-2 concise sentences, maximum 35 words.
- The final answer belongs in finalAnswerLatex and, if included in steps, only as one clearly titled "Final Answer" step at the end.`;
}

export function buildRepairFeedbackDetails(issues = [], {
  error = null,
  previousResult = null,
  currentResult = null,
} = {}) {
  const issueCodes = normalizeRepairIssueList(issues);
  const evidenceExcerpts = [...new Set(collectRepairFailureEvidenceItems(error || {}, issueCodes))]
    .map((item) => sanitizeRepairPromptText(item, MAX_REPAIR_EVIDENCE_ITEM_CHARS));
  const requestedCorrectionStrategy = buildRuleSpecificRepairInstructions(issueCodes);
  const earliestFailingStepId = error?.solutionValidationContext?.firstFailingStepId || null;
  const previousMethodFingerprint = previousResult ? createMethodFingerprint(previousResult, error) : null;
  const currentMethodFingerprint = currentResult ? createMethodFingerprint(currentResult, error) : null;
  const repeatedMethodDetected = Boolean(
    previousMethodFingerprint
    && currentMethodFingerprint
    && previousMethodFingerprint.primaryMethod !== "unknown"
    && previousMethodFingerprint.primaryMethod === currentMethodFingerprint.primaryMethod
    && (
      previousMethodFingerprint.failingIdentity
      && currentMethodFingerprint.failingIdentity
      ? previousMethodFingerprint.failingIdentity === currentMethodFingerprint.failingIdentity
      : previousMethodFingerprint.fingerprint === currentMethodFingerprint.fingerprint
    )
  );
  return {
    issueCodes,
    repairCategory: categorizeRepairIssues(issueCodes, { error }).category,
    evidenceExcerpts,
    earliestFailingStepId,
    requestedCorrectionStrategy,
    previousMethodFingerprint,
    currentMethodFingerprint,
    repeatedMethodDetected,
  };
}

export function buildRepairSolvePrompt(_prompt, issues = [], {
  problem = "",
  previousResult = null,
  error = null,
} = {}) {
  const failedRules = normalizeRepairIssueList(issues);
  const repairCategorization = categorizeRepairIssues(failedRules, { error }).category;
  if (repairCategorization === "structural") {
    return buildNarrowStructuralRepairPrompt({
      failedRules,
      problem,
      previousResult,
      error,
    });
  }
  const rulesText = failedRules.join(", ") || "generic_invalid_solution";
  const evidenceText = collectRepairFailureEvidence(error || {}, failedRules);
  const numericalEvidence = collectNumericalRepairEvidence(error || {}) || "No numerical disagreement evidence was provided.";
  const ruleSpecificInstructions = buildRuleSpecificRepairInstructions(failedRules);
  const originalProblem = sanitizeRepairPromptText(problem, 2000) || "Use the original problem supplied in this repair request.";
  const previousSolution = compactPreviousInvalidSolution(previousResult || {});

  return `You are OmniMath, a careful AI math tutor repairing a rejected solution.

Repair task:
- Solve the canonical problem below.
- Do NOT preserve the previous derivation.
- Assume the previous derivation is mathematically unreliable.
- Reconstruct the solution from scratch using a mathematically justified strategy.
- Do not merely change finalAnswerLatex or numericCheck to satisfy a validator.
- Explicitly verify substitutions, derivatives, signs, and final numerical agreement before answering.
- Verify substitutions, derivatives, signs, and special-function simplifications before using them.

Canonical problem:
${originalProblem}

Previous invalid solution:
${previousSolution}

Failed validation rules:
${rulesText}

Exact failure evidence:
${evidenceText}

Numerical disagreement evidence:
${numericalEvidence}

Rule-specific corrective instructions:
${ruleSpecificInstructions}

General repair requirements:
- Solve the actual extracted math problem, not a generic rule example.
- If the previous approach relied on unsupported integration by parts, avoid integration by parts unless every part is fully justified.
- If integration by parts is unavoidable, provide u, dv, du, a correct explicit v, and verify v by differentiating it.
- If a special function was introduced previously, do not introduce it again unless the identity is derived explicitly and matched to the original integrand.
- Use a different mathematical strategy when the previous method caused a validator failure.
- Do not repeat the previous method or preserve invalid identities, unsupported antiderivatives, or unsupported special-function shortcuts.
- Do not output placeholders such as "Recognized rule", "f g x", or a one-step rule summary.
- Do not use undefined placeholder functions such as G(r,\theta), H(x), "symmetric function", or "defined above"; write the actual integral/formula or a numeric value.
- Keep finalAnswerLatex structurally valid as a concise complete result summary.

Output contract:
- Return JSON only. Do not include markdown, comments, code fences, or explanatory prose outside JSON.
- Return only valid JSON matching the requested schema.
- Required fields: title, problemLatex, steps, finalAnswerLatex, numericCheck.
- steps must be an array of 3-8 meaningful items unless the problem truly requires otherwise.
- Each step must include id, heading, latex, reasoning, and anchors.
- Every step must include an anchors array, even when empty.
- Generate at most 3 anchors per step and at most 20 anchors across the whole solution.
- Math-rendered fields must contain pure valid LaTeX only: problemLatex, steps[].latex, finalAnswerLatex, and anchor latex.
- Do not wrap math-rendered fields in Markdown fences, latex code blocks, \\[...\\], $$...$$, or $...$.
- Never put plain text inside math unless it is wrapped in \\text{}.
- Use proper LaTeX function names such as \\ln, \\arctan, \\sin, and \\cos.
- Use LaTeX commands instead of Unicode math symbols: \\int, \\infty, \\frac{}{}, \\le, \\ge, and so on.
- Preserve spacing commands for differentials, such as \\,dx.
- finalAnswerLatex must be a concise complete result summary, not a repeated derivation or intermediate system dump.
- Related equations, labelled multi-part results and valid multiline environments are allowed. Preserve necessary domain restrictions, branches, assumptions, residuals and parameter conditions. Put explanatory step sequences in the derivation.
- numericCheck should be a decimal approximation when applicable, or an empty string.
- Keep each reasoning field to 1-2 concise sentences, maximum 35 words.
- Do not restate the entire original problem inside step 1; start with the first meaningful transformation or theorem setup.
- The final answer belongs in finalAnswerLatex and, if included in steps, only as one clearly titled "Final Answer" step at the end.`;
}

const MATH_ESCALATION_ELIGIBLE_ISSUES = new Set([
  "numerical_final_answer_mismatch",
  "unsupported_integration_by_parts_setup",
  "identity_verification_failed",
  "substitution_verification_failed",
  "symbolic_inconsistency",
  "mathematically_invalid_derivation",
  "invalid_antiderivative",
  "unverified_critical_identity",
  "parameter_derivative_mismatch",
  "incorrect_substitution_jacobian",
  "final_answer_not_supported_by_steps",
  "final_answer_sign_inconsistent_with_steps",
  "sign_contradiction_positive_integrand_negative_answer",
  "sign_contradiction_reversed_positive_integrand_positive_answer",
  "unsupported_special_function_simplification",
  "unsupported_final_answer_jump",
  "unsupported_theorem_or_symmetry_claim",
  "unsupported_symmetry_cancellation",
  "dropped_nonpolynomial_fraction_derivative",
  "sign_inconsistent_named_quantity",
]);

const KNOWN_INCORRECT_FINAL_ANSWER_ISSUES = new Set([
  "answer_target_mismatch",
  "undefined_final_placeholder",
  "malformed_set_valued_answer",
  "final_answer_not_supported_by_steps",
  "final_answer_sign_inconsistent_with_steps",
  "sign_contradiction_positive_integrand_negative_answer",
  "sign_contradiction_reversed_positive_integrand_positive_answer",
  "numerical_final_answer_mismatch",
  "incorrect_simple_power_equation_final",
]);

const FALLBACK_SAFE_SYMBOL_SOURCE_TYPES = new Set([
  "heading",
  "label",
  "title",
  "reasoning",
  "summary",
  "plainExplanation",
]);

const SOLVE_CANDIDATE_STAGE_ORDER = {
  initial: 0,
  repair: 1,
  "repair-compact": 2,
  escalation: 3,
  "escalation-compact": 4,
};

function isEscalationEligibleIssue(issue) {
  const normalized = String(issue || "").trim();
  return MATH_ESCALATION_ELIGIBLE_ISSUES.has(normalized)
    || normalized.startsWith("abrupt_special_function_introduction");
}

function isStructuralRecoveryIssue(issue) {
  const normalized = String(issue || "").trim();
  return normalized === "strict_generated_latex"
    || normalized.startsWith("strict_generated_latex:")
    || normalized.startsWith("unexplained_generated_symbol:");
}

function evaluationMatchesIssue(evaluation = {}, issue = "") {
  const candidates = [
    evaluation.issue,
    evaluation.name,
    evaluation.validatorName,
  ].filter(Boolean).map((value) => String(value));
  return candidates.some((candidate) => (
    candidate === issue
    || candidate.startsWith(`${issue}:`)
    || issue.startsWith(`${candidate}:`)
  ));
}

function hasAffirmativeFailedEvaluation(error = {}, issue = "") {
  const evaluations = Array.isArray(error.solutionRuleEvaluations) ? error.solutionRuleEvaluations : [];
  if (evaluations.some((evaluation) => evaluation?.result === "fail" && evaluationMatchesIssue(evaluation, issue))) {
    return true;
  }
  const numericalIssue = error?.solutionValidationContext?.numericalCrossCheckResult?.issue;
  if (issue === "numerical_final_answer_mismatch" && numericalIssue === issue) {
    return true;
  }
  const signIssue = error?.solutionValidationContext?.signAnalysisResult?.issue;
  return Boolean(signIssue && signIssue === issue);
}

function failedEvaluationsForIssue(error = {}, issue = "") {
  const evaluations = Array.isArray(error.solutionRuleEvaluations) ? error.solutionRuleEvaluations : [];
  return evaluations.filter((evaluation) => (
    evaluation?.result === "fail" && evaluationMatchesIssue(evaluation, issue)
  ));
}

function parseRedactedEvaluationEvidence(evaluation = {}) {
  if (typeof evaluation.failureEvidence !== "string") return null;
  try {
    const parsed = JSON.parse(evaluation.failureEvidence);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isFallbackSafeUnexplainedSymbol(error = {}, issue = "") {
  if (!String(issue || "").startsWith("unexplained_generated_symbol:")) return false;
  const evaluations = failedEvaluationsForIssue(error, issue);
  if (evaluations.length === 0) return false;
  return evaluations.every((evaluation) => {
    const evidence = parseRedactedEvaluationEvidence(evaluation);
    const sourceType = String(evidence?.sourceType || "");
    const fieldPath = String(evidence?.fieldPath || evaluation.inputFields?.[0] || "");
    if (!FALLBACK_SAFE_SYMBOL_SOURCE_TYPES.has(sourceType)) return false;
    return !/(?:^|\.)(?:math|latex|equationLatex|lines|chunks)(?:$|\.|\[)|finalAnswer|problemLatex/iu.test(fieldPath);
  });
}

function candidateCompleteness(result = {}) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const meaningfulSteps = steps.filter((step) => (
    String(step?.math || step?.latex || "").trim()
    && String(step?.summary || step?.reasoning || step?.plainExplanation || "").trim()
  )).length;
  const hasFinalAnswer = Boolean(String(result?.finalAnswerLatex || result?.finalAnswer || "").trim());
  return {
    hasFinalAnswer,
    meaningfulSteps,
    score: (hasFinalAnswer ? 2 : 0) + Math.min(8, meaningfulSteps),
  };
}

// Legacy candidate-analysis exports are retained for offline diagnostics and
// compatibility tests only. They are not the ordinary production recovery
// state machine; ordinary recovery is governed by ordinaryRecoveryPolicy.js.
export function classifySolveCandidate({
  source = "initial",
  result = null,
  error = null,
  parseSchemaSuccess = Boolean(result),
} = {}) {
  const issueCodes = [...new Set(
    (Array.isArray(error?.solutionIssues) ? error.solutionIssues : []).filter(Boolean)
  )];
  const numericalIssue = error?.solutionValidationContext?.numericalCrossCheckResult?.issue || null;
  const numericalConfidence = error?.solutionValidationContext?.numericalCrossCheckResult?.confidence || null;
  const numericalMismatch = numericalIssue === "numerical_final_answer_mismatch"
    || issueCodes.includes("numerical_final_answer_mismatch");
  const numericalAgreement = !numericalMismatch && numericalConfidence === "agreement";
  const issueClassifications = issueCodes.map((code) => {
    const affirmativeMathematical = isEscalationEligibleIssue(code)
      && hasAffirmativeFailedEvaluation(error || {}, code);
    const knownIncorrectFinalAnswer = KNOWN_INCORRECT_FINAL_ANSWER_ISSUES.has(code);
    const fallbackSafeStructural = isFallbackSafeUnexplainedSymbol(error || {}, code);
    const severity = affirmativeMathematical || knownIncorrectFinalAnswer || numericalMismatch
      ? "mathematical"
      : fallbackSafeStructural
        ? "presentation"
        : "unsafe_structural";
    return {
      code,
      severity,
      affirmativeMathematical,
      knownIncorrectFinalAnswer,
      fallbackEligible: fallbackSafeStructural
        && !affirmativeMathematical
        && !knownIncorrectFinalAnswer
        && !numericalMismatch,
    };
  });
  const affirmativeMathematicalFailure = issueClassifications.some((issue) => issue.affirmativeMathematical);
  const knownIncorrectFinalAnswer = issueClassifications.some((issue) => (
    KNOWN_INCORRECT_FINAL_ANSWER_ISSUES.has(issue.code)
  ));
  const structuralRecovery = issueCodes.length > 0 && issueCodes.every(isStructuralRecoveryIssue);
  const completeness = candidateCompleteness(result || {});
  const structural = inspectSolveCandidateStructure(result);
  structural.usable = Boolean(parseSchemaSuccess && structural.usable);
  const acceptance = decideCandidateAcceptance({ structural, verification: result?.verification });
  const structurallyUsable = acceptance.accepted;
  const fallbackEligible = false;
  return {
    source,
    result,
    parseSchemaSuccess: Boolean(parseSchemaSuccess),
    qualityIssueCodes: issueCodes,
    issueClassifications,
    affirmativeMathematicalFailure,
    knownIncorrectFinalAnswer,
    numericalMismatch,
    numericalAgreement,
    numericalStatus: numericalMismatch ? "mismatch" : numericalAgreement ? "agreement" : "no_contradiction",
    structuralRecovery,
    completeness,
    acceptance,
    accepted: structurallyUsable,
    rejectionReason: structurallyUsable ? null : "parse_or_schema_failed",
    fallbackEligible,
  };
}

export function decideSolveFailureAction({ candidate = null, ...candidateInput } = {}) {
  const classifiedCandidate = candidate || classifySolveCandidate(candidateInput);
  if (classifiedCandidate.accepted && inspectSolveCandidateStructure(classifiedCandidate.result).usable) {
    return {
      action: "accept",
      candidate: classifiedCandidate,
      repairCategory: null,
    };
  }

  const failureClassification = classifySolveFailure({
    error: candidateInput.error || null,
    candidate: classifiedCandidate.parseSchemaSuccess ? classifiedCandidate.result : null,
  });
  if (failureClassification.category === "response_generation_failure") {
    return {
      action: "response_generation_failure",
      candidate: classifiedCandidate,
      failureClassification,
      repairCategory: null,
    };
  }

  return {
    action: "response_generation_failure",
    candidate: classifiedCandidate,
    failureClassification,
    repairCategory: null,
  };
}

export function classifySolveFailure({ error = null, candidate = null } = {}) {
  const errorCode = error?.code || null;
  const hasParsedCandidate = Boolean(candidate && typeof candidate === "object");

  return {
    category: "response_generation_failure",
    errorCode,
    responseFailureType: error?.responseFailureType || null,
    hasParsedCandidate,
  };
}

export function compareSafeSolveCandidates(left = {}, right = {}) {
  const leftMathSafety = left.affirmativeMathematicalFailure
    || left.numericalMismatch
    || left.knownIncorrectFinalAnswer ? 0 : 1;
  const rightMathSafety = right.affirmativeMathematicalFailure
    || right.numericalMismatch
    || right.knownIncorrectFinalAnswer ? 0 : 1;
  if (leftMathSafety !== rightMathSafety) return rightMathSafety - leftMathSafety;
  const leftNumerical = left.numericalAgreement ? 2 : left.numericalMismatch ? 0 : 1;
  const rightNumerical = right.numericalAgreement ? 2 : right.numericalMismatch ? 0 : 1;
  if (leftNumerical !== rightNumerical) return rightNumerical - leftNumerical;
  const leftSeverity = (left.issueClassifications || []).reduce((total, issue) => (
    total + (issue.severity === "presentation" ? 1 : issue.severity === "unsafe_structural" ? 10 : 100)
  ), 0);
  const rightSeverity = (right.issueClassifications || []).reduce((total, issue) => (
    total + (issue.severity === "presentation" ? 1 : issue.severity === "unsafe_structural" ? 10 : 100)
  ), 0);
  if (leftSeverity !== rightSeverity) return leftSeverity - rightSeverity;
  const leftCompleteness = Number(left.completeness?.score || 0);
  const rightCompleteness = Number(right.completeness?.score || 0);
  if (leftCompleteness !== rightCompleteness) return rightCompleteness - leftCompleteness;
  return Number(SOLVE_CANDIDATE_STAGE_ORDER[right.source] || 0)
    - Number(SOLVE_CANDIDATE_STAGE_ORDER[left.source] || 0);
}

export function selectBestSafeSolveCandidate(candidates = []) {
  return candidates
    .filter((candidate) => candidate?.fallbackEligible)
    .sort(compareSafeSolveCandidates)[0] || null;
}

export function decideSolveEscalation(error, { alreadyEscalated = false, afterRepairAttempt = false } = {}) {
  if (alreadyEscalated) {
    return {
      shouldEscalate: false,
      reason: "escalation_already_attempted",
      triggeringValidatorIssues: [],
    };
  }
  if (error?.code && error.code !== "AI_SOLUTION_QUALITY_INVALID") {
    return {
      shouldEscalate: false,
      reason: "non_mathematical_failure",
      triggeringValidatorIssues: [],
    };
  }
  if (!isSolutionQualityValidationError(error)) {
    return {
      shouldEscalate: false,
      reason: "non_validator_failure",
      triggeringValidatorIssues: [],
    };
  }
  const issues = normalizeRepairIssueList(error?.solutionIssues || []);
  const triggeringValidatorIssues = issues.filter((issue) => (
    isEscalationEligibleIssue(issue)
    && hasAffirmativeFailedEvaluation(error || {}, issue)
  ));
  if (triggeringValidatorIssues.length > 0) {
    return {
      shouldEscalate: true,
      reason: "affirmative_mathematical_validator_failure",
      triggeringValidatorIssues,
    };
  }
  const structuralRecoveryIssues = afterRepairAttempt
    ? issues.filter(isStructuralRecoveryIssue)
    : [];
  if (structuralRecoveryIssues.length > 0) {
    return {
      shouldEscalate: true,
      reason: "structural_recovery_after_failed_repair",
      triggeringValidatorIssues: structuralRecoveryIssues,
    };
  }
  if (triggeringValidatorIssues.length === 0) {
    return {
      shouldEscalate: false,
      reason: afterRepairAttempt ? "no_escalation_recovery_issue" : "no_affirmative_mathematical_invalidity",
      triggeringValidatorIssues: [],
    };
  }
}

function isSolutionQualityValidationError(error) {
  return error?.message === "Solution failed quality validation."
    || Array.isArray(error?.solutionRuleEvaluations);
}

function hasGeneratedResponseFailureDiagnostics(error) {
  if (!error || typeof error !== "object") return false;
  if (!["AI_RESPONSE_INVALID", "AI_RESPONSE_TRUNCATED"].includes(error.code)) return false;
  return Boolean(
    error.responseFailureType
    || error.invalidOutputText
    || Array.isArray(error.solutionIssues)
    || Array.isArray(error.latexValidationIssues)
    || error.finishReason
    || error.incompleteDetails
    || error._omniOpenAiDiagnostics
  );
}

function isCapturableSolveFailure(error) {
  return isSolutionQualityValidationError(error) || hasGeneratedResponseFailureDiagnostics(error);
}

function extractionDiagnostics(extraction = {}) {
  const validation = extraction?.extractionValidation || {};
  const imageSource = extraction?.imageSource || {};
  return {
    confidence: extraction?.confidence ?? validation.confidence ?? imageSource.confidence ?? null,
    confidenceTier: extraction?.confidenceTier || validation.tier || imageSource.confidenceTier || "",
    ocrConfidence: extraction?.ocrConfidence ?? validation.ocrConfidence ?? imageSource.ocrConfidence ?? null,
    mathIntegrityScore: extraction?.mathIntegrityScore ?? validation.mathIntegrityScore ?? imageSource.mathIntegrityScore ?? null,
    issues: Array.isArray(extraction?.issues)
      ? extraction.issues
      : Array.isArray(validation.issues)
        ? validation.issues
        : Array.isArray(imageSource.issues)
          ? imageSource.issues
          : [],
  };
}

async function captureSolveQualityFailure({
  error,
  result,
  stage,
  requestId,
  endpoint,
  prompt,
  promptHash,
  problem = "",
  problemText = "",
  canonicalProblem = null,
  extraction = null,
  repairAttempted = null,
  failureClassification = null,
  qualityRepairAttempted = repairAttempted,
  compactRetryAttempted = null,
  freshEscalationAttempted = null,
  purpose = null,
  attemptType = null,
  repairFeedback = null,
  previousResult = null,
  canonicalDisplayText = "",
  canonicalDisplaySource = "",
  canonicalMathInput = "",
  canonicalMathInputSource = "",
} = {}) {
  if (!isCapturableSolveFailure(error)) return;
  if (error && typeof error === "object" && error._omniFailedSolveCaptureAttempted) return;
  const extractionMeta = extractionDiagnostics(extraction || {});
  await captureFailedSolveDiagnostic({
    requestId,
    endpoint,
    stage,
    prompt,
    promptHash,
    result,
    error,
    input: {
      originalReviewedOcrText: problemText,
      canonicalNormalizedSolverInput: problem,
      canonicalText: canonicalProblem?.canonicalText || "",
      canonicalLatex: canonicalProblem?.canonicalLatex || "",
      canonicalDisplayText,
      canonicalDisplaySource,
      canonicalMathInput,
      canonicalMathInputSource,
      extractionConfidence: extractionMeta.confidence,
      extractionConfidenceTier: extractionMeta.confidenceTier,
      extractionOcrConfidence: extractionMeta.ocrConfidence,
      extractionMathIntegrityScore: extractionMeta.mathIntegrityScore,
      extractionIssues: extractionMeta.issues,
      canonicalProblem,
    },
    validation: {
      solutionIssues: error.solutionIssues || [],
      latexValidationIssues: error.latexValidationIssues || [],
      responseFailureType: error.responseFailureType || null,
      ruleEvaluations: error.solutionRuleEvaluations || [],
      validationContext: error.solutionValidationContext || null,
      repairFeedback: repairFeedback || buildRepairFeedbackDetails(error.solutionIssues || [error.code || error.message].filter(Boolean), {
        error,
        previousResult,
        currentResult: result,
      }),
      earliestFailingStepId: error.solutionValidationContext?.firstFailingStepId || null,
      purpose,
      attemptType,
      initialValidationPassed: String(stage || "").startsWith("initial") ? false : null,
      repairAttempted,
      failureClassification: failureClassification || classifySolveFailure({ error, candidate: result }).category,
      qualityRepairAttempted,
      compactRetryAttempted,
      freshEscalationAttempted,
      repairValidationPassed: String(stage || "").startsWith("repair") ? false : null,
    },
  });
  if (error && typeof error === "object") {
    Object.defineProperty(error, "_omniFailedSolveCaptureAttempted", {
      enumerable: false,
      configurable: true,
      value: true,
    });
  }
}

function createGeneratedResponseFailureCapture({
  requestId,
  endpoint,
  prompt,
  promptHash,
  problem = "",
  problemText = "",
  canonicalProblem = null,
  extraction = null,
  repairAttempted = null,
  qualityRepairAttempted = repairAttempted,
  freshEscalationAttempted = false,
  canonicalDisplayText = "",
  canonicalDisplaySource = "",
  canonicalMathInput = "",
  canonicalMathInputSource = "",
} = {}) {
  return async ({
    error,
    stage,
    attemptType,
    prompt: attemptPrompt,
    promptHash: attemptPromptHash,
    purpose,
    compactRetryAttempted,
    qualityRepairAttempted: attemptQualityRepairAttempted = qualityRepairAttempted,
    freshEscalationAttempted: attemptFreshEscalationAttempted = freshEscalationAttempted,
  } = {}) => captureSolveQualityFailure({
    error,
    result: null,
    stage: attemptType || stage,
    requestId,
    endpoint,
    prompt: attemptPrompt || prompt,
    promptHash: attemptPromptHash || promptHash,
    problem,
    problemText,
    canonicalProblem,
    extraction,
    repairAttempted,
    failureClassification: "response_generation_failure",
    qualityRepairAttempted: attemptQualityRepairAttempted,
    compactRetryAttempted: compactRetryAttempted ?? false,
    freshEscalationAttempted: attemptFreshEscalationAttempted,
    purpose,
    attemptType,
    canonicalDisplayText,
    canonicalDisplaySource,
    canonicalMathInput,
    canonicalMathInputSource,
  });
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function sendRedirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, {
    Location: location,
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`Redirecting to ${location}`);
}

function sendMethodNotAllowed(res, methods) {
  sendJson(
    res,
    405,
    {
      code: "METHOD_NOT_ALLOWED",
      error: "Method not allowed",
      message: `Use ${methods.join(" or ")} for this endpoint.`,
    },
    { Allow: methods.join(", ") }
  );
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

function getDevClientOrigin(req) {
  if (isProductionRuntime()) return null;

  const configured = process.env.DEV_CLIENT_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");

  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || "localhost:8787";
  const hostname = host.replace(/:\d+$/, "");
  return `${protocol}://${hostname}:5173`;
}

function redirectDevFrontendRequest(req, res, url) {
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const origin = getDevClientOrigin(req);
  if (!origin) return false;

  sendRedirect(res, `${origin}${url.pathname}${url.search}`);
  return true;
}

function sendError(res, error) {
  const statusCode = error.statusCode || 500;
  const isServerError = statusCode >= 500;
  const message = error.code === "AI_SERVICE_UNAVAILABLE" && error.publicMessage
    ? error.publicMessage
    : isServerError && isProductionRuntime()
    ? error.publicMessage || "The AI backend could not complete the request."
    : error.message || error.publicMessage;

  if (isServerError) {
    console.error(error);
  }

  const payload = {
    code: error.code || (statusCode === 429 ? "USAGE_LIMIT_EXCEEDED" : "REQUEST_FAILED"),
    error: isServerError ? "Server error" : error.message,
    message,
  };
  if (error.ingestionStage) payload.ingestionStage = error.ingestionStage;
  if (error.responseFailureType) payload.failureClassification = error.responseFailureType;
  if (error.accountingStatus) payload.accountingStatus = error.accountingStatus;
  if (error.timeoutSource) payload.timeoutSource = error.timeoutSource;
  if (error.timeoutScope) payload.timeoutScope = error.timeoutScope;
  if (error.code === "AI_SOLVE_TIMEOUT") payload.retryable = true;
  if (error.omniDebugContext?.requestId) payload.requestId = error.omniDebugContext.requestId;
  if (error.limitBytes) {
    payload.limitBytes = error.limitBytes;
    payload.actualBytes = error.actualBytes;
  }

  if (error.code === "AI_SOLUTION_QUALITY_INVALID") {
    const solutionIssues = [...new Set((Array.isArray(error.solutionIssues) ? error.solutionIssues : [])
      .map(sanitizePublicIssueCode)
      .filter(Boolean))]
      .slice(0, 20);
    payload.publicMessage = error.publicMessage || "The generated solution failed mathematical validation.";
    payload.solutionIssues = solutionIssues;
    payload.retryable = true;
    payload.retryType = "reviewed_problem";
    payload.validationSummary = publicValidationSummary(solutionIssues);
  }

  if (error.usage) {
    payload.usage = error.usage;
  }

  if (!isProductionRuntime() && error.openAiTransportDiagnostics) {
    const diagnostics = error.openAiTransportDiagnostics;
    payload.openAiTransportDiagnostics = {
      apiHost: diagnostics.apiHost || null,
      model: diagnostics.model || null,
      modelPath: diagnostics.modelPath || null,
      modelRole: diagnostics.modelRole || null,
      solveMode: diagnostics.solveMode || null,
      purpose: diagnostics.purpose || null,
      maxAttempts: diagnostics.maxAttempts ?? null,
      timeoutMs: diagnostics.timeoutMs ?? null,
      timeoutSource: diagnostics.timeoutSource || null,
      timeoutConfigStatus: diagnostics.timeoutConfigStatus || null,
      transportAttempts: diagnostics.transportAttempts ?? null,
      successfulProviderResponses: diagnostics.successfulProviderResponses ?? null,
      retryCount: diagnostics.retryCount ?? null,
      finalInfrastructureErrorCode: diagnostics.finalInfrastructureErrorCode || error.networkCauseCode || null,
      finalInfrastructureFailureType: diagnostics.finalInfrastructureFailureType || null,
      finalNormalizedErrorCode: diagnostics.finalNormalizedErrorCode || error.networkCauseCode || null,
      finalLegacyNumericCode: diagnostics.finalLegacyNumericCode ?? error.networkLegacyNumericCode ?? null,
      finalErrorName: diagnostics.finalErrorName || error.networkCauseName || null,
      finalErrorMessage: diagnostics.finalErrorMessage || error.networkCauseMessage || null,
      finalCauseChain: diagnostics.finalCauseChain || error.networkCauseChain || [],
      finalTimeoutScope: diagnostics.finalTimeoutScope || null,
      attempts: Array.isArray(diagnostics.attempts)
        ? diagnostics.attempts.map((attempt) => ({
            attempt: attempt.attempt ?? null,
            stage: attempt.stage || null,
            elapsedMs: attempt.elapsedMs ?? null,
            status: attempt.status ?? null,
            retryable: Boolean(attempt.retryable),
            errorCode: attempt.errorCode || null,
            normalizedErrorCode: attempt.normalizedErrorCode || attempt.errorCode || null,
            legacyNumericCode: attempt.legacyNumericCode ?? null,
            errorName: attempt.errorName || null,
            errorMessage: attempt.errorMessage || null,
            causeChain: attempt.causeChain || [],
            timeoutScope: attempt.timeoutScope || null,
            failureType: attempt.failureType || null,
          }))
        : [],
    };
  }

  if (error.omniDebugContext?.requestId) {
    payload.requestId = error.omniDebugContext.requestId;
  }

  if (!isProductionRuntime() && error.authDebug) {
    payload.debug = { auth: error.authDebug };
  }

  const headers = createUsageHeaders(error.usage, { includeRetryAfter: statusCode === 429 });
  if (error.retryAfterSeconds && !headers["Retry-After"]) {
    headers["Retry-After"] = String(error.retryAfterSeconds);
  }

  logSolveDebug("http_response", {
    requestId: error.omniDebugContext?.requestId || null,
    statusCode,
    code: payload.code,
    message,
    error: payload.error,
    failedRules: error.omniDebugContext?.failedRules || error.solutionIssues || [],
  });
  sendJson(res, statusCode, payload, headers);
}

async function readBody(req, maxBytes) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > maxBytes) {
      throw bodySizeError(req.body.length, maxBytes);
    }
    return req.body;
  }

  if (typeof req.body === "string") {
    const body = Buffer.from(req.body);
    if (body.length > maxBytes) {
      throw bodySizeError(body.length, maxBytes);
    }
    return body;
  }

  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw bodySizeError(total, maxBytes);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function bodySizeError(actualBytes, limitBytes) {
  return Object.assign(new Error("Request body is too large."), {
    statusCode: 413, code: "REQUEST_BODY_TOO_LARGE", actualBytes, limitBytes,
    ingestionStage: "request_body",
  });
}

async function readJson(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    const bytes = Buffer.byteLength(JSON.stringify(req.body), "utf8");
    if (bytes > MAX_JSON_BYTES) throw bodySizeError(bytes, MAX_JSON_BYTES);
    return req.body;
  }

  const body = await readBody(req, MAX_JSON_BYTES);
  try {
    return JSON.parse(body.toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), {
      statusCode: 400,
      code: "BAD_INPUT",
    });
  }
}

function createBadInputError(message) {
  return Object.assign(new Error(message), {
    statusCode: 400,
    code: "BAD_INPUT",
  });
}

function sanitizePublicIssueCode(value = "") {
  const issue = String(value || "").trim();
  if (!issue || issue.length > 120) return "";
  return /^[A-Za-z0-9_:\\-]+$/.test(issue) ? issue : "";
}

function publicValidationSummary(solutionIssues = []) {
  const issueSet = new Set(solutionIssues);
  if (issueSet.has("numerical_final_answer_mismatch")) {
    return "The proposed final value disagreed with an independent numerical check.";
  }
  if (issueSet.has("detached_relation_leading_fragment")) {
    return "A generated equation fragment had invalid presentation structure.";
  }
  return "The generated solution failed mathematical validation.";
}

function requireTextProblem(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw createBadInputError("Problem input is required.");
  }
  if (value.length > MAX_PROBLEM_CHARS) {
    throw Object.assign(new Error("Problem input is too long."), {
      statusCode: 413,
      code: "BAD_INPUT",
    });
  }
  return value.trim();
}

function parseHistory(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw createBadInputError("History must be an array.");
  }

  return value.slice(-MAX_HISTORY_ITEMS).map((item, index) => {
    if (!item || typeof item !== "object") {
      throw createBadInputError(`History item ${index + 1} is invalid.`);
    }

    const role = item.role === "tutor" || item.role === "assistant" ? "tutor" : "user";
    if (typeof item.text !== "string") {
      throw createBadInputError(`History item ${index + 1} is missing text.`);
    }

    return { role, text: item.text.slice(0, MAX_HISTORY_ITEM_CHARS) };
  });
}

function parseFollowupHistory(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw createBadInputError("Follow-up history must be an array.");
  }

  return value.slice(-8).map((item, index) => {
    if (!item || typeof item !== "object") {
      throw createBadInputError(`Follow-up history item ${index + 1} is invalid.`);
    }
    const role = item.role === "assistant" || item.role === "tutor" ? "assistant" : "user";
    return {
      role,
      text: String(item.text || "").slice(0, MAX_HISTORY_ITEM_CHARS),
    };
  }).filter((item) => item.text.trim());
}

function requireFollowupQuestion(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw createBadInputError("Follow-up question is required.");
  }
  if (value.length > MAX_FOLLOWUP_QUESTION_CHARS) {
    throw Object.assign(new Error("Follow-up question is too long."), {
      statusCode: 413,
      code: "BAD_INPUT",
    });
  }
  return value.trim();
}

function isLocalPersistenceError(error) {
  return error?.code === "USAGE_STORE_UNAVAILABLE"
    || error?.code === "DATABASE_UNAVAILABLE"
    || error?.code === "SERVER_CONFIG_ERROR";
}

function createLocalFollowupIdentity() {
  return {
    key: "local-dev-followup",
    tier: "local",
    subject: "local-dev",
    clerkUserId: "local-dev-followup",
  };
}

function createLocalDevIdentity(route = "local-dev") {
  return {
    key: `local-dev-${route}`,
    tier: "local",
    subject: "local-dev",
    clerkUserId: `local-dev-${route}`,
  };
}

async function requireRequestIdentity(req, route = "request") {
  try {
    return await requireClerkIdentity(req);
  } catch (error) {
    if (!isProductionRuntime()) {
      console.warn("[omnimath:dev-auth-fallback]", {
        route,
        reason: "using local dev identity",
        code: error.code,
        message: error.message,
      });
      return createLocalDevIdentity(route);
    }
    throw error;
  }
}

async function resolveFollowupIdentity(req) {
  try {
    return await requireClerkIdentity(req);
  } catch (error) {
    if (!isProductionRuntime()) {
      console.warn("[omnimath:followup-fallback]", {
        reason: "auth/session unavailable",
        code: error.code,
        message: error.message,
      });
      return {
        identity: createLocalFollowupIdentity(),
        fallbackReason: error.message,
      };
    }
    throw error;
  }
}

async function reserveFollowupUsage(req, identity, prompt) {
  const maxOutputTokens = 900;
  const estimatedTokens = estimateOpenAiTokenBudget({ prompt, maxOutputTokens });
  const estimatedCostMicros = dollarsToMicros(estimateOpenAiCostBudget({ prompt, maxOutputTokens }));
  try {
    return await checkAndReserveUsage({
      req,
      identity,
      kind: "explanation",
      estimatedTokens: isOpenAiConfigured() ? estimatedTokens : 0,
      estimatedCostMicros: isOpenAiConfigured() ? estimatedCostMicros : 0,
    });
  } catch (error) {
    if (!isProductionRuntime() && isLocalPersistenceError(error)) {
      console.warn("[omnimath:followup-fallback]", {
        reason: "usage reservation unavailable",
        code: error.code,
        message: error.message,
      });
      return {
        usage: null,
        reservation: null,
        fallbackReason: error.message,
      };
    }
    throw error;
  }
}

function requireImage(file) {
  if (!file) {
    logRejectedUpload({ reason: "missing_file" });
    throw Object.assign(new Error("Image file is required."), {
      statusCode: 400,
      code: "BAD_INPUT",
    });
  }
  if (!ALLOWED_IMAGE_TYPES.has(file.contentType)) {
    logRejectedUpload({ file, reason: "invalid_mime_type" });
    throw Object.assign(new Error("Uploaded file must be an image."), {
      statusCode: 400,
      code: "BAD_INPUT",
      publicMessage: "Please upload a PNG, JPG, WebP, or GIF image.",
    });
  }
  if (file.buffer.length > MAX_IMAGE_BYTES) {
    logRejectedUpload({ file, reason: "file_too_large" });
    throw Object.assign(new Error("Image file is too large."), {
      statusCode: 413,
      code: "BAD_INPUT",
    });
  }
  if (!matchesImageSignature(file)) {
    logRejectedUpload({ file, reason: "mime_signature_mismatch" });
    throw Object.assign(new Error("Uploaded file content does not match its image type."), {
      statusCode: 400,
      code: "BAD_INPUT",
      publicMessage: "Please upload a valid PNG, JPG, WebP, or GIF image.",
    });
  }
  return file;
}

function matchesImageSignature(file) {
  const header = file.buffer.subarray(0, 12);
  if (file.contentType === "image/png") {
    return header.length >= 8
      && header[0] === 0x89
      && header[1] === 0x50
      && header[2] === 0x4e
      && header[3] === 0x47;
  }
  if (file.contentType === "image/jpeg") {
    return header.length >= 3
      && header[0] === 0xff
      && header[1] === 0xd8
      && header[2] === 0xff;
  }
  if (file.contentType === "image/webp") {
    return header.length >= 12
      && header.subarray(0, 4).toString("ascii") === "RIFF"
      && header.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (file.contentType === "image/gif") {
    const signature = header.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  return false;
}

function logRejectedUpload({ file = null, reason }) {
  console.warn("[omnimath:image-upload-rejected]", {
    reason,
    filename: file?.filename,
    contentType: file?.contentType,
    bytes: file?.buffer?.length || 0,
  });
}

function logImageUploadDebug(event, details = {}) {
  if (isProductionRuntime()) return;
  console.info(`[omnimath:image-${event}]`, details);
}

function logSolutionStateDebug(event, details = {}) {
  if (process.env.VITE_DEBUG_SOLUTION_STATE !== "true") return;
  console.info("[omnimath:solution-state]", {
    event,
    ...details,
  });
}

function getSolutionStepsForDebug(value = {}) {
  if (Array.isArray(value?.steps)) return value.steps.length;
  if (Array.isArray(value?.explanation?.steps)) return value.explanation.steps.length;
  if (Array.isArray(value?.solution?.steps)) return value.solution.steps.length;
  if (Array.isArray(value?.result?.steps)) return value.result.steps.length;
  return 0;
}

function getCacheRequestFields(body = {}) {
  return {
    reference: body.selectedTokenId || body.selectedStepId || body.reference || "",
    depth: body.depth || "intermediate",
  };
}

function estimateTokens(text = "") {
  return Math.ceil(String(text).length / 4);
}

function dollarsToMicros(value) {
  return Math.ceil(Math.max(0, Number(value) || 0) * 1000000);
}

function progressiveUsageDiagnostics(usage = null, model = null) {
  if (!usage) {
    return {
      usageReported: false,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
    };
  }
  const normalized = normalizeOpenAiUsage(usage, 0);
  return {
    usageReported: true,
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    reasoningTokens: normalized.reasoningTokens,
    totalTokens: normalized.totalTokens,
    estimatedCostUsd: Number(estimateOpenAiCost(usage, { model: model || "" }).toFixed(6)),
  };
}

function progressiveRecoverySummary(attempts = [], aggregateUsage = null, providerCallCount = attempts.length) {
  const recoveryAttempts = attempts.slice(1);
  const sum = (items, field) => {
    if (items.length === 0) return 0;
    if (items.some((item) => !item?.usage?.usageReported)) return null;
    return Number(items.reduce(
      (total, item) => total + (Number(item.usage[field]) || 0), 0
    ).toFixed(6));
  };
  const reportedProviderCalls = attempts.filter((attempt) => attempt.usage?.usageReported).length;
  const usageComplete = reportedProviderCalls === providerCallCount;
  const aggregate = progressiveUsageDiagnostics(aggregateUsage);
  const aggregateUsageDiagnostics = {
    ...aggregate,
    usageComplete,
    reportedProviderCalls,
    expectedProviderCalls: providerCallCount,
    reportedTotalTokens: aggregate.totalTokens,
    reportedEstimatedCostUsd: aggregate.estimatedCostUsd,
    totalTokens: usageComplete ? aggregate.totalTokens : null,
    estimatedCostUsd: usageComplete ? aggregate.estimatedCostUsd : null,
  };
  return {
    initialAttemptSucceeded: attempts.length === 1 && attempts[0]?.decision === "authoritative",
    initialAttemptPublishedPrefix: Boolean(attempts[0]?.authoritativePrefixPublished),
    retryCount: attempts.filter((attempt) => attempt.attemptType === "retry").length,
    repairCount: attempts.filter((attempt) => attempt.attemptType === "repair").length,
    escalationCount: attempts.filter((attempt) => attempt.attemptType === "escalation").length,
    recoveryDurationMs: recoveryAttempts.reduce(
      (total, attempt) => total + Math.max(0, attempt.endedAt - attempt.startedAt), 0
    ),
    recoveryTokens: sum(recoveryAttempts, "totalTokens"),
    recoveryEstimatedCostUsd: sum(recoveryAttempts, "estimatedCostUsd"),
    escalationTokens: sum(attempts.filter((attempt) => attempt.attemptType === "escalation"), "totalTokens"),
    escalationEstimatedCostUsd: sum(
      attempts.filter((attempt) => attempt.attemptType === "escalation"), "estimatedCostUsd"
    ),
    aggregateUsage: aggregateUsageDiagnostics,
  };
}

function mergeOpenAiUsageValues(...usages) {
  const present = usages.filter(Boolean);
  if (present.length === 0) return null;
  return present.reduce((merged, usage) => {
    const normalized = normalizeOpenAiUsage(usage, 0);
    return {
      input_tokens: (merged.input_tokens || 0) + normalized.inputTokens,
      output_tokens: (merged.output_tokens || 0) + normalized.outputTokens,
      total_tokens: (merged.total_tokens || 0) + normalized.totalTokens,
      output_tokens_details: {
        reasoning_tokens: (merged.output_tokens_details?.reasoning_tokens || 0) + normalized.reasoningTokens,
      },
      _omni_model_usage: [
        ...(Array.isArray(merged._omni_model_usage) ? merged._omni_model_usage : []),
        ...(Array.isArray(usage?._omni_model_usage) ? usage._omni_model_usage : []),
      ],
    };
  }, { input_tokens: 0, output_tokens: 0, total_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } });
}

function aiUsageFrom(value = null) {
  return value?._aiUsage || value?._omniOpenAiDiagnostics?.usage || null;
}

function aiCallCountFrom(value = null) {
  if (!value || typeof value !== "object") return 0;
  if (Number.isFinite(value._aiCallCount)) return Math.max(0, Number(value._aiCallCount));
  if (value._omniOpenAiDiagnostics?.usage) return 1;
  return 0;
}

function attachAccumulatedAiUsage(result, usage = null, aiCallCount = 0) {
  if (!result || typeof result !== "object") return result;
  attachHiddenUsageValue(result, "_aiUsage", usage);
  attachHiddenUsageValue(result, "_aiCallCount", aiCallCount);
  return result;
}

function attachHiddenUsageValue(target, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor && descriptor.configurable === false) {
    if (descriptor.writable) {
      target[key] = value;
    }
    return;
  }
  Object.defineProperty(target, key, {
    enumerable: false,
    configurable: true,
    writable: true,
    value,
  });
}

async function settleAiUsageReservation(reservation, usage = null, {
  providerCalls = 0,
  settlementReason = "success",
  providerAttempts = [],
} = {}) {
  if (!reservation) return null;
  // The canonical ledger records each fetch once, including transport retries.
  if (providerAttempts.length) providerCalls = providerAttempts.length;
  const unobservedAttempts = providerAttempts.filter((attempt) => attempt.usageStatus !== "observed");
  const providerDispatched = providerCalls > 0 || providerAttempts.length > 0;
  const unknownUsage = unobservedAttempts.length > 0 || (providerDispatched && !usage);
  const usageStatus = !unknownUsage ? "observed"
    : usage ? "partially_observed"
    : unobservedAttempts.some((attempt) => attempt.abortAt || attempt.abortedAt)
      ? "unknown_due_to_abort" : "unknown_unreconciled";
  const normalizedUsage = normalizeOpenAiUsage(usage, 0);
  return settleTokenUsage(
    reservation,
    normalizedUsage.totalTokens,
    dollarsToMicros(estimateOpenAiCost(usage)),
    {
      actualInputTokens: normalizedUsage.inputTokens,
      actualOutputTokens: normalizedUsage.outputTokens,
      actualReasoningTokens: normalizedUsage.reasoningTokens,
      providerCalls,
      settlementReason,
      providerDispatched,
      usageStatus,
      providerAttempts,
    }
  );
}

async function settleFailureUsageOrRelease(reservation, error = null, result = null, providerAttempts = []) {
  if (!reservation) return null;
  const errorUsage = aiUsageFrom(error);
  const resultUsage = aiUsageFrom(result);
  const usage = errorUsage || resultUsage || null;
  if (!providerAttempts.length) {
    providerAttempts = error?._omniOpenAiDiagnostics?.providerAttempts
      || error?.openAiTransportDiagnostics?.providerAttempts
      || result?._omniOpenAiDiagnostics?.providerAttempts || [];
  }
  const providerCalls = Math.max(aiCallCountFrom(error), aiCallCountFrom(result), providerAttempts.length);
  if (usage || providerCalls > 0) {
    return settleAiUsageReservation(reservation, usage, {
      providerCalls: Math.max(providerCalls, usage ? 1 : 0),
      settlementReason: "failure",
      providerAttempts,
    });
  }
  return releaseTokenReservation(reservation, { providerCalls: 0, settlementReason: "failure-before-provider" });
}

function isAiEnabled() {
  return process.env.AI_ENABLED !== "false";
}

function assertAiEnabled() {
  if (isAiEnabled()) return;

  throw Object.assign(new Error("AI endpoints are disabled."), {
    statusCode: 503,
    code: "AI_DISABLED",
    publicMessage: "AI features are temporarily disabled.",
  });
}

function createOpenAiRequiredError() {
  return Object.assign(new Error("OPENAI_API_KEY is not configured on the server."), {
    statusCode: 500,
    code: "SERVER_CONFIG_ERROR",
    publicMessage: "The AI backend is not configured.",
  });
}

function logExplanationSource({
  source,
  kind,
  endpoint,
  identity,
  requestId = null,
  attemptId = null,
  recoveryPurpose = null,
  prompt = "",
  aiUsage = null,
  execution = null,
}) {
  const normalizedUsage = normalizeOpenAiUsage(aiUsage, estimateTokens(prompt));
  const tokenUsage = aiUsage
    ? normalizedUsage
    : {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        approximateInputTokens: estimateTokens(prompt),
      };

  const diagnostics = execution && typeof execution === "object" ? execution : {};
  const requestedModel = diagnostics.requestedModel || null;
  const effectiveModel = diagnostics.effectiveModel || diagnostics.model || null;
  const providerModel = diagnostics.providerModel ?? diagnostics.responseModel ?? null;
  const accountingModel = diagnostics.accountingModel
    || aiUsage?._omni_model_usage?.at(-1)?.accountingModel
    || aiUsage?._omni_model_usage?.at(-1)?.model
    || effectiveModel
    || null;
  console.info("[omnimath:ai-request]", {
    requestId,
    attemptId,
    routeAttemptId: diagnostics.routeAttemptId || null,
    routeAttemptIndex: diagnostics.routeAttemptIndex ?? null,
    candidateId: diagnostics.candidateId || null,
    providerResponseId: diagnostics.responseId || diagnostics.providerResponseId || null,
    providerTransportAttempt: diagnostics.attempt ?? null,
    providerTransportAttempts: diagnostics.transportDiagnostics?.transportAttempts ?? null,
    userId: identity?.clerkUserId,
    endpoint,
    source,
    kind,
    role: diagnostics.modelRole || diagnostics.role || null,
    requestedModel,
    effectiveModel,
    providerModel,
    accountingModel,
    reasoningEffort: diagnostics.reasoningEffort ?? null,
    recoveryPurpose: recoveryPurpose || diagnostics.recoveryPurpose || null,
    // Compatibility field now means observed provider identity only. It is
    // deliberately null when the provider did not report a model.
    model: providerModel,
    tokens: tokenUsage,
    estimatedCostUsd: Number(estimateOpenAiCost(aiUsage, { model: accountingModel || "" }).toFixed(6)),
  });
}

function logSolveTiming({
  endpoint,
  startedAt,
  source,
  identity,
  prompt = "",
  aiUsage = null,
  apiCallCount = 0,
  requestBodyChars = null,
}) {
  const durationMs = Math.max(0, Date.now() - startedAt);
  const normalizedUsage = normalizeOpenAiUsage(aiUsage, estimateTokens(prompt));
  const details = {
    userId: identity?.clerkUserId,
    endpoint,
    source,
    durationMs,
    apiCallCount,
    promptChars: prompt.length,
    requestBodyChars,
    inputTokenEstimate: estimateTokens(prompt),
    inputTokens: normalizedUsage.inputTokens || null,
    outputTokens: normalizedUsage.outputTokens || null,
    totalTokens: normalizedUsage.totalTokens || null,
  };
  const logger = apiCallCount > 1 ? console.warn : console.info;
  logger(apiCallCount > 1 ? "[omnimath:solve-api-warning]" : "[omnimath:solve-api-duration]", details);
}

async function getUsageForKind(req, kind, identity) {
  const snapshot = await getUsageSnapshot({ req, identity });
  return snapshot.usage?.[kind];
}

function buildResponse(result, {
  usage,
  saved,
  saveStatus = null,
  source,
  demoMode,
  canonicalProblem = null,
  requestId = null,
}) {
  const degradedFallback = result?._omniDegradedFallback || null;
  const presentationDegraded = result?._omniPresentationDegraded || null;
  return {
    ...result,
    ...(requestId ? { requestId } : {}),
    canonicalProblem: canonicalProblem || result.canonicalProblem || null,
    canonicalInputHash: canonicalProblem?.hash || result.canonicalProblem?.hash || null,
    usage,
    savedExplanationId: saved?.id,
    runtime: {
      source,
      demoMode,
      ...(saveStatus ? { saveStatus } : {}),
      saveWarning: saved?.warning || null,
      ...(degradedFallback?.selected ? {
        degradedFallback: true,
        degradedFallbackSource: degradedFallback.source || null,
        failedLaterStage: degradedFallback.failedLaterStage || null,
      } : {}),
      ...(presentationDegraded?.accepted ? {
        presentationDegraded: true,
        presentationDegradedSource: presentationDegraded.source || null,
        presentationDegradedIssueCodes: presentationDegraded.issueCodes || [],
      } : {}),
    },
  };
}

function getRequestBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header));
  return match?.[1] || "";
}

function decodeJwtPayload(token) {
  try {
    const payload = token?.split(".")?.[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function requestHasExpiredBearerToken(req) {
  const claims = decodeJwtPayload(getRequestBearerToken(req));
  const expiresAt = Number(claims?.exp);
  return Number.isFinite(expiresAt) && expiresAt <= Math.floor(Date.now() / 1000);
}

function isClerkTokenExpiredError(error) {
  const values = [
    error?.code,
    error?.reason,
    error?.message,
    error?.cause?.code,
    error?.cause?.reason,
    error?.cause?.message,
  ].map((value) => String(value || "").toLowerCase());
  return values.some((value) => value.includes("token-expired") || value.includes("jwt expired") || value.includes("token expired"));
}

function createExpiredSaveWarning() {
  return {
    id: null,
    warning: "auth_expired",
  };
}

async function runHandler(res, handler) {
  try {
    await handler();
  } catch (error) {
    if (res.headersSent) {
      console.error("[omnimath:handler-after-headers]", { code: error?.code || null, message: error?.message || "Unhandled error" });
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
    }
    sendError(res, error);
  }
}

function requireObject(value, label = "Request body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createBadInputError(`${label} must be an object.`);
  }
  return value;
}

function requireShortText(value, label, maxChars) {
  if (typeof value !== "string" || !value.trim()) {
    throw createBadInputError(`${label} is required.`);
  }
  if (value.length > maxChars) {
    throw Object.assign(new Error(`${label} is too long.`), {
      statusCode: 413,
      code: "BAD_INPUT",
    });
  }
  return value.trim();
}

function optionalShortText(value, label, maxChars) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    throw createBadInputError(`${label} must be text.`);
  }
  if (value.length > maxChars) {
    throw Object.assign(new Error(`${label} is too long.`), {
      statusCode: 413,
      code: "BAD_INPUT",
    });
  }
  return value.trim();
}

function buildLazyCacheKey(identity, body, type) {
  return createExplanationCacheKey({
    userId: identity.clerkUserId,
    problem: body.problemId || body.problemContext || body.problemLatex || body.problem || "",
    reference: [
      type,
      body.anchorId || body.selectedTokenId || "",
      body.stepId || "",
      body.stepHeading || "",
      body.selectedLatex || "",
      body.parentExpression || "",
      body.stepLatex || "",
    ].join(":"),
    depth: type,
    type,
  });
}

function validateSessionPayload(value) {
  const session = requireObject(value.session || value, "Session");
  const title = typeof session.title === "string" ? session.title.trim().slice(0, 120) : "";

  if (session.messages !== undefined) parseHistory(session.messages);

  const problem = session.problem;
  if (problem !== undefined && problem !== null) {
    requireObject(problem, "Session problem");
  }

  const problems = session.problems;
  if (problems !== undefined && !Array.isArray(problems)) {
    throw createBadInputError("Session problems must be an array.");
  }

  const pinnedWindows = session.pinnedWindows;
  if (pinnedWindows !== undefined && !Array.isArray(pinnedWindows)) {
    throw createBadInputError("Pinned explanation windows must be an array.");
  }

  const workspaceConversation = session.workspaceConversation;
  if (workspaceConversation !== undefined && (workspaceConversation === null
    || typeof workspaceConversation !== "object" || Array.isArray(workspaceConversation)
    || (workspaceConversation.messages !== undefined && !Array.isArray(workspaceConversation.messages)))) {
    throw createBadInputError("Workspace conversation must contain a messages array.");
  }

  return {
    id: typeof session.id === "string" ? session.id.trim().slice(0, 80) : "",
    title,
    demoKey: typeof session.demoKey === "string" ? session.demoKey : null,
    messages: Array.isArray(session.messages) ? parseHistory(session.messages) : [],
    problem: problem || null,
    problems: Array.isArray(problems) ? problems : problem ? [problem] : [],
    steps: Array.isArray(session.steps) ? session.steps : problem?.steps || [],
    pinnedWindows: Array.isArray(pinnedWindows) ? pinnedWindows : [],
    workspaceConversation: workspaceConversation || null,
  };
}

async function saveExplanationBestEffort(req, details) {
  try {
    const saved = await saveExplanationForRequest(req, details);
    if (!saved && requestHasExpiredBearerToken(req)) {
      console.warn("[omnimath:save-auth-warning]", {
        ...getSolveDiagnosticContext(),
        operation: "saveExplanationBestEffort",
        reason: "token-expired",
      });
      return createExpiredSaveWarning();
    }
    return saved;
  } catch (error) {
    if (isClerkTokenExpiredError(error) || requestHasExpiredBearerToken(req)) {
      console.warn("[omnimath:save-auth-warning]", {
        ...getSolveDiagnosticContext(),
        operation: "saveExplanationBestEffort",
        reason: "token-expired",
        code: error.code,
        message: error.message,
      });
      return createExpiredSaveWarning();
    }
    console.warn("[omnimath:save-warning]", {
      ...getSolveDiagnosticContext(),
      operation: "saveExplanationBestEffort",
      code: error.code,
      message: error.message,
    });
    return null;
  }
}

export async function handleHealthRequest(req, res) {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, ["GET"]);
    return;
  }

  sendJson(res, 200, {
    ok: true,
    status: "healthy",
    progressiveProviderEnabled: progressiveProviderEnabled(),
    demoMode: !isOpenAiConfigured(),
    aiEnabled: isAiEnabled(),
    openai: getOpenAiRuntimeConfig(),
    auth: getClerkAuthRuntimeConfig(),
    env: getEnvLoadStatus(),
  });
}

export async function handleOpenAiDebugRequest(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    sendMethodNotAllowed(res, ["GET", "POST"]);
    return;
  }

  if (isProductionRuntime() && process.env.ENABLE_OPENAI_DEBUG_ROUTE !== "true") {
    sendJson(res, 404, { code: "NOT_FOUND", error: "Not found", message: "Not found" });
    return;
  }

  try {
    const result = await debugOpenAiConnection();
    sendJson(res, 200, {
      ok: true,
      message: "OpenAI debug request succeeded.",
      openai: getOpenAiRuntimeConfig(),
      result,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendJson(res, statusCode, {
      ok: false,
      code: error.code || "OPENAI_DEBUG_FAILED",
      message: error.message,
      providerStatus: error.providerStatus ?? null,
      providerCode: error.providerCode ?? null,
      networkCauseCode: error.networkCauseCode ?? null,
      networkCauseMessage: error.networkCauseMessage ?? null,
      openai: getOpenAiRuntimeConfig(),
      env: getEnvLoadStatus(),
    });
  }
}

function requireProgressiveIdentity(body, requestId) {
  const raw = requireObject(body.progressiveIdentity, "Progressive identity");
  const identity = Object.fromEntries(
    ["requestId", "attemptId", "sessionId", "conversationId"]
      .map((key) => [key, requireShortText(raw[key], `Progressive ${key}`, 120)])
  );
  if (identity.requestId !== requestId || !identity.attemptId.startsWith(`${requestId}:`)) {
    throw createBadInputError("Progressive request and attempt identity do not match.");
  }
  if (raw.supersedesAttemptId !== undefined) {
    const previous = requireShortText(raw.supersedesAttemptId, "Superseded attempt id", 120);
    if (previous === identity.attemptId) throw createBadInputError("A solve cannot supersede itself.");
  }
  return identity;
}

function parseCompleteProgressiveRepairCandidate(outputText) {
  if (typeof outputText !== "string" || outputText.length > 1_000_000) return null;
  try {
    const candidate = JSON.parse(outputText);
    const keys = ["title", "problemLatex", "steps", "finalAnswerLatex", "numericCheck"];
    return candidate && !Array.isArray(candidate) && typeof candidate === "object"
      && keys.every((key) => Object.hasOwn(candidate, key)) && Array.isArray(candidate.steps)
      ? candidate : null;
  } catch { return null; }
}

async function handleProgressiveProviderSolve({
  req, res, body, requestId, prompt, problem, canonicalProblem,
  initialRouting, solveDeadlineAt, solveBudget, usageKind, persistenceSource, identity,
  estimatedTokens, estimatedCostMicros, endpoint, inputSource, cacheKey, sourceMetadata,
}) {
  const progressiveStartedAt = Date.now();
  const eventIdentity = requireProgressiveIdentity(body, requestId);
  if (!isOpenAiConfigured()) throw createOpenAiRequiredError();
  const { reservation } = await checkAndReserveUsage({
    req, identity, kind: usageKind, estimatedTokens, estimatedCostMicros,
  });
  const abortController = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) abortController.abort(new DOMException("Client disconnected.", "AbortError"));
  };
  const onRequestError = (error) => {
    if (error?.message === "aborted" || error?.code === "ECONNRESET") onClose();
  };
  res.on("close", onClose);
  req.on?.("error", onRequestError);
  if (req.aborted) onClose();
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  let sequence = 0;
  let terminal = false;
  let settlementDone = false;
  let settlementSucceeded = false;
  let settlementStatus = "pending";
  let providerResult = null;
  const completedSteps = [];
  let authoritativePrefixPublished = false;
  let accumulatedUsage = null;
  let providerCallCount = 0;
  const recoveryAttempts = [];
  const initialExecutionConfig = solveExecutionConfig({
    modelPath: initialRouting.selectedInitialModelPath,
    attemptType: "initial",
    recoveryPurpose: "progressive_initial",
    promptStrategy: "canonical_problem",
    responseMode: "provider_stream_json",
  });
  const escalationExecutionConfig = solveExecutionConfig({
    modelPath: "escalation",
    attemptType: "escalation",
    recoveryPurpose: "progressive_escalation",
    promptStrategy: "canonical_problem",
    responseMode: "provider_stream_json",
  });
  const initialSelectedModel = initialExecutionConfig.effectiveModel;
  const escalationModelAvailable = isMeaningfullyDifferentEscalationConfig(
    initialExecutionConfig,
    escalationExecutionConfig,
  );
  let escalationReason = null;
  let metadata = null;
  let framedFinal = null;
  let firstProviderEventAt = null;
  let firstValidatedStepAt = null;
  let authoritativeModel = null;
  let authoritativeEffectiveModel = null;
  const emit = (type, fields = {}) => {
    if (terminal || res.destroyed || res.writableEnded) return false;
    const event = { ...eventIdentity, sequence: sequence++, type, ...fields };
    res.write(`event: solve\ndata: ${JSON.stringify(event)}\n\n`);
    if (["solve_completed", "solve_failed", "solve_cancelled"].includes(type)) terminal = true;
    return true;
  };
  const settle = async (usage, providerCalls, reason) => {
    if (settlementDone) return null;
    settlementDone = true;
    try {
      const result = usage || providerCalls > 0 || solveBudget.providerAttempts.length > 0
        ? await settleAiUsageReservation(reservation, usage, {
          providerCalls: Math.max(providerCalls, solveBudget.providerAttempts.length, usage ? 1 : 0), settlementReason: reason,
          providerAttempts: solveBudget.providerAttempts,
        })
        : await releaseTokenReservation(reservation, { providerCalls: 0, settlementReason: "failure-before-provider" });
      settlementSucceeded = true;
      settlementStatus = "settled";
      for (const attempt of recoveryAttempts) attempt.usageSettlementStatus = "settled";
      console.info("[omnimath:progressive-recovery-settlement]", {
        requestId, attemptId: eventIdentity.attemptId, providerCallCount,
        settlementReason: reason,
        providerAttempts: recoveryAttempts.map((attempt) => ({
          index: attempt.index, model: attempt.model, usageReported: attempt.usage?.usageReported || false,
          usageSettlementStatus: attempt.usageSettlementStatus,
        })),
      });
      return result;
    } catch (error) {
      settlementStatus = "failed";
      for (const attempt of recoveryAttempts) attempt.usageSettlementStatus = "failed";
      throw error;
    }
  };
  emit("solve_started", body.progressiveIdentity.supersedesAttemptId
    ? { supersedesAttemptId: body.progressiveIdentity.supersedesAttemptId } : {});
  try {
    let activePrompt = prompt;
    let attemptType = "initial";
    let retryAttempted = false;
    let repairAttempted = false;
    let escalationAttempted = false;
    let normalized;
    while (true) {
      if (abortController.signal.aborted) throw abortController.signal.reason;
      if (Date.now() >= solveDeadlineAt) {
        throw Object.assign(new Error("Interactive solve deadline exceeded."), {
          code: "AI_SERVICE_UNAVAILABLE", responseFailureType: "interactive_deadline_exceeded",
          publicMessage: "The AI service did not complete the explanation in time.",
        });
      }
      const providerAttemptIndex = recoveryAttempts.length + 1;
      const routeAttemptId = `${eventIdentity.attemptId}:route:${providerAttemptIndex}`;
      const attemptStartedAt = Date.now();
      const framer = createProgressiveJsonFramer();
      const validator = createProgressiveStepValidator({ sourceHash: canonicalProblem.hash });
      const deferPublication = attemptType === "repair";
      const stagedSteps = [];
      let candidateMetadata = null;
      let candidateFinal = null;
      let draftOutput = "";
      let prePrefixError = null;
      let callResult = null;
      let counted = false;
      const accountCall = (value) => {
        if (counted) return;
        counted = true;
        accumulatedUsage = mergeOpenAiUsageValues(accumulatedUsage, aiUsageFrom(value) || value?.usage || null);
        providerCallCount += aiCallCountFrom(value) || value?.providerCallCount || 0;
      };
      const attemptModelPath = attemptType === "repair"
        ? "repair"
        : attemptType === "escalation"
          ? "escalation"
          : initialRouting.selectedInitialModelPath;
      const attemptRecoveryPurpose = attemptType === "repair"
        ? "progressive_structured_repair"
        : attemptType === "escalation"
          ? "progressive_escalation"
          : retryAttempted
            ? "progressive_transport_retry"
            : "progressive_initial";
      const attemptPromptStrategy = attemptType === "repair"
        ? "repair_complete_candidate"
        : "canonical_problem";
      const attemptExecutionConfig = solveExecutionConfig({
        modelPath: attemptModelPath,
        attemptType,
        recoveryPurpose: attemptRecoveryPurpose,
        promptStrategy: attemptPromptStrategy,
        responseMode: "provider_stream_json",
      });
      const selectedModel = attemptExecutionConfig.effectiveModel;
      logSolveRecovery("progressive_attempt_started", {
        requestId,
        endpoint,
        attemptId: eventIdentity.attemptId,
        routeAttemptId,
        routeAttemptIndex: providerAttemptIndex,
        recoveryPurpose: attemptRecoveryPurpose,
        promptHash: hashDebugText(activePrompt),
        executionConfig: attemptExecutionConfig,
      });
      const observeProviderEvent = (providerEvent = {}) => {
        const elapsedMs = Number(providerEvent.elapsedMs);
        const observedAt = Number.isFinite(elapsedMs) ? attemptStartedAt + elapsedMs : Date.now();
        firstProviderEventAt ??= observedAt;
      };
      try {
        callResult = await streamMathExplanation({
          prompt: activePrompt,
          originalProblem: problem,
          modelPath: attemptModelPath,
          maxProviderAttempts: 1,
          debugContext: {
                  ...imageSolveTelemetry(sourceMetadata),
            requestId, attemptId: eventIdentity.attemptId, routeAttemptId, providerAttemptIndex,
            recoveryPurpose: attemptRecoveryPurpose,
            attemptType, endpoint, inputSource, normalizedProblem: problem,
            promptHash: hashDebugText(activePrompt), solveDeadlineAt, solveBudget,
            solveBudgetStage: providerAttemptIndex === 1 ? "primary" : "recovery", initialRouting,
          },
          signal: abortController.signal,
          onTextDelta: async (delta, providerEvent) => {
            observeProviderEvent(providerEvent);
            if (abortController.signal.aborted) throw abortController.signal.reason;
            draftOutput = (draftOutput + delta).slice(0, 1_000_001);
            if (prePrefixError) return;
            let records;
            try { records = framer.push(delta); }
            catch (error) {
              if (authoritativePrefixPublished) throw error;
              prePrefixError = error;
              return;
            }
            for (const record of records) {
              if (record.type === "metadata") {
                candidateMetadata = {
                  title: record.value.title, problemLatex: record.value.problemLatex,
                  originalProblem: problem, canonicalProblem,
                  canonicalInputHash: canonicalProblem.hash,
                  source: inputSource, ...(sourceMetadata || {}),
                  model: providerEvent.providerModel ?? providerEvent.model ?? null,
                  providerModel: providerEvent.providerModel ?? providerEvent.model ?? null,
                  effectiveModel: providerEvent.effectiveModel || selectedModel,
                };
              } else if (record.type === "step") {
                const validationStartedAt = performance.now();
                let accepted;
                try {
                  accepted = validator.accept(record.value, {
                    stepIndex: record.index, sourceHash: canonicalProblem.hash,
                  });
                } catch (validationError) {
                  console.warn("[omnimath:progressive-step]", {
                    requestId, attemptId: eventIdentity.attemptId, providerAttemptIndex,
                    providerResponseId: providerEvent.providerResponseId,
                    model: providerEvent.model, stepIndex: record.index,
                    validation: "rejected", reason: validationError?.reason || validationError?.code || null,
                    validationDurationMs: Number((performance.now() - validationStartedAt).toFixed(3)),
                  });
                  if (authoritativePrefixPublished) throw validationError;
                  prePrefixError = validationError;
                  return;
                }
                if (abortController.signal.aborted) throw abortController.signal.reason;
                const validationDurationMs = Number((performance.now() - validationStartedAt).toFixed(3));
                const acceptedAt = Date.now();
                if (deferPublication) {
                  stagedSteps.push({ accepted, stepIndex: record.index, acceptedAt, validationDurationMs,
                    providerResponseId: providerEvent.providerResponseId,
                    providerModel: providerEvent.providerModel ?? providerEvent.model ?? null,
                    effectiveModel: providerEvent.effectiveModel || selectedModel });
                  continue;
                }
                if (!authoritativePrefixPublished) {
                  if (!emit("solution_metadata", { metadata: candidateMetadata })) throw abortController.signal.reason || new Error("Client disconnected.");
                  metadata = candidateMetadata;
                }
                if (!emit("step_completed", {
                  stepId: accepted.step.id, stepIndex: record.index,
                  step: accepted.step, validation: accepted.validation,
                  acceptedAt, validationDurationMs,
                })) throw abortController.signal.reason || new Error("Client disconnected.");
                firstValidatedStepAt ??= acceptedAt;
                completedSteps.push(accepted.step);
                authoritativePrefixPublished = true;
                authoritativeModel ??= providerEvent.providerModel ?? providerEvent.model ?? null;
                authoritativeEffectiveModel ??= providerEvent.effectiveModel || selectedModel;
                console.info("[omnimath:progressive-step]", {
                  requestId, attemptId: eventIdentity.attemptId, providerAttemptIndex,
                  providerResponseId: providerEvent.providerResponseId,
                  model: providerEvent.model, sequence: sequence - 1,
                  stepIndex: record.index, validation: "accepted",
                  validationDurationMs, acceptedAt, elapsedMs: providerEvent.elapsedMs,
                });
              } else if (record.type === "final_answer") {
                candidateFinal = record.value;
              }
            }
          },
          onProviderEvent: observeProviderEvent,
        });
        accountCall(callResult);
        if (abortController.signal.aborted) throw abortController.signal.reason;
        if (!draftOutput.trim()) {
          throw Object.assign(new Error("Provider stream returned no solution text."), {
            code: "AI_RESPONSE_INVALID", responseFailureType: "empty_response",
            publicMessage: "The AI service returned an empty explanation.",
          });
        }
        if (prePrefixError) throw prePrefixError;
        const full = framer.finish();
        validator.assertPrefix(full);
        normalized = normalizeProviderSolveCandidate(full, { originalProblem: problem });
        normalized.steps = deferPublication ? stagedSteps.map((item) => item.accepted.step) : completedSteps;
        normalized.canonicalProblem = canonicalProblem;
        normalized.canonicalInputHash = canonicalProblem.hash;
        normalized.canonicalContentHash = canonicalProblem.contentHash;
        normalized.model = callResult.providerModel ?? callResult.model ?? null;
        normalized.providerModel = callResult.providerModel ?? callResult.model ?? null;
        normalized.effectiveModel = callResult.effectiveModel || selectedModel;
        finalizeSolveCandidate(normalized, {
          problem, inputSource, requestId,
          candidateId: `${routeAttemptId}:candidate:progressive`, routeAttemptId,
        });
        logAssuranceChecks({ requestId, endpoint, assurance: normalized.assurance,
          attemptId: eventIdentity.attemptId });
        finalizeAssuranceSelection({ result: normalized, assurance: normalized.assurance },
          [{ result: normalized, assurance: normalized.assurance }], false, {
            attempted: false, outcome: "not_attempted", reason: "authoritative_prefix_published",
          });
        logSolveRecovery("assurance_decision", {
          requestId, endpoint, attemptId: eventIdentity.attemptId, routeAttemptId,
          candidateId: normalized.assurance.candidateId,
          assuranceStatus: normalized.assurance.status,
          contradictionCategories: normalized.assurance.findings.map((finding) => finding.category),
          recoveryDecision: normalized.assurance.status === "contradiction_detected"
            ? "present_unresolved" : "present",
          recoveryReason: authoritativePrefixPublished ? "authoritative_prefix_published" : "progressive_route_policy",
        });
        if (deferPublication) {
          if (!candidateMetadata || !stagedSteps.length || typeof candidateFinal !== "string") {
            throw Object.assign(new Error("Repair stream did not contain a complete solution."), {
              code: "PROGRESSIVE_FRAME_INVALID",
            });
          }
          if (abortController.signal.aborted) throw abortController.signal.reason;
          candidateMetadata.model = callResult.providerModel ?? callResult.model ?? null;
          candidateMetadata.providerModel = callResult.providerModel ?? callResult.model ?? null;
          candidateMetadata.effectiveModel = callResult.effectiveModel || selectedModel;
          if (!emit("solution_metadata", { metadata: candidateMetadata })) throw abortController.signal.reason || new Error("Client disconnected.");
          metadata = candidateMetadata;
          for (const item of stagedSteps) {
            if (abortController.signal.aborted) throw abortController.signal.reason;
            if (!emit("step_completed", {
              stepId: item.accepted.step.id, stepIndex: item.stepIndex,
              step: item.accepted.step, validation: item.accepted.validation,
              acceptedAt: item.acceptedAt, validationDurationMs: item.validationDurationMs,
            })) throw abortController.signal.reason || new Error("Client disconnected.");
            firstValidatedStepAt ??= item.acceptedAt;
            completedSteps.push(item.accepted.step);
            authoritativePrefixPublished = true;
            authoritativeModel ??= item.providerModel ?? callResult.providerModel ?? callResult.model ?? null;
            authoritativeEffectiveModel ??= item.effectiveModel || callResult.effectiveModel || selectedModel;
            console.info("[omnimath:progressive-step]", {
              requestId, attemptId: eventIdentity.attemptId, providerAttemptIndex,
              providerResponseId: item.providerResponseId, model: item.providerModel,
              sequence: sequence - 1, stepIndex: item.stepIndex,
              validation: "accepted", validationDurationMs: item.validationDurationMs,
              acceptedAt: item.acceptedAt,
            });
          }
        }
        framedFinal = candidateFinal;
        providerResult = callResult;
        const attemptUsage = aiUsageFrom(callResult) || callResult?.usage || null;
        const attemptDiagnostics = { index: providerAttemptIndex, routeAttemptId, attemptType,
          role: attemptExecutionConfig.role,
          requestedModel: attemptExecutionConfig.requestedModel,
          effectiveModel: attemptExecutionConfig.effectiveModel,
          providerModel: callResult.providerModel ?? callResult.model ?? null,
          accountingModel: callResult.accountingModel || attemptExecutionConfig.effectiveModel,
          reasoningEffort: attemptExecutionConfig.reasoningEffort,
          executionConfig: attemptExecutionConfig,
          model: callResult.providerModel ?? callResult.model ?? null,
          classification: null, decision: "authoritative", escalationReason,
          startedAt: attemptStartedAt, endedAt: Date.now(), authoritativePrefixPublished,
          usage: progressiveUsageDiagnostics(
            attemptUsage,
            callResult.accountingModel || attemptExecutionConfig.effectiveModel,
          ),
          providerResponseId: callResult.responseId || null,
          providerEventCount: callResult.providerEventCount ?? null,
          firstProviderEventMs: callResult.firstProviderEventMs ?? null,
          usageSettlementStatus: "pending" };
        recoveryAttempts.push(attemptDiagnostics);
        console.info(`[omnimath:progressive-recovery] ${JSON.stringify({
          eventTimestamp: new Date().toISOString(), requestId, attemptId: eventIdentity.attemptId,
          providerAttemptIndex, routeAttemptId, attemptType,
          role: attemptDiagnostics.role,
          requestedModel: attemptDiagnostics.requestedModel,
          effectiveModel: attemptDiagnostics.effectiveModel,
          providerModel: attemptDiagnostics.providerModel,
          accountingModel: attemptDiagnostics.accountingModel,
          reasoningEffort: attemptDiagnostics.reasoningEffort,
          model: attemptDiagnostics.providerModel, classification: null, decision: "authoritative",
          escalationReason, startedAt: attemptStartedAt, endedAt: attemptDiagnostics.endedAt,
          durationMs: attemptDiagnostics.endedAt - attemptDiagnostics.startedAt,
          authoritativePrefixPublished, providerResponseId: attemptDiagnostics.providerResponseId,
          providerEventCount: attemptDiagnostics.providerEventCount,
          firstProviderEventMs: attemptDiagnostics.firstProviderEventMs,
          usage: attemptDiagnostics.usage,
          usageSettlementStatus: attemptDiagnostics.usage.usageReported ? "pending" : "unavailable",
        })}`);
        break;
      } catch (error) {
        accountCall(callResult || error);
        const classification = classifyProgressiveFailure(error, { cancelled: abortController.signal.aborted,
          disconnected: res.destroyed });
        const repairCandidate = parseCompleteProgressiveRepairCandidate(draftOutput || error?._omniFailedOutputText);
        const decision = decideProgressiveRecovery({
          classification, authoritativePrefixPublished, retryAttempted,
          repairAttempted, escalationAttempted,
          repairCandidateAvailable: Boolean(repairCandidate), escalationModelAvailable,
          deadlineRemaining: solveBudget.canStartRecovery() && !abortController.signal.aborted,
          providerAttemptCount: providerAttemptIndex,
        });
        if (!solveBudget.canStartRecovery() && !abortController.signal.aborted) {
          decision.reason = "insufficient_recovery_budget";
        }
        const failedProviderModel = callResult?.providerModel
          ?? error?._omniOpenAiDiagnostics?.providerModel
          ?? error?._omniOpenAiDiagnostics?.responseModel
          ?? null;
        const failedModel = failedProviderModel;
        const attemptUsage = aiUsageFrom(callResult || error) || callResult?.usage || null;
        const attemptDiagnostics = { index: providerAttemptIndex, routeAttemptId, attemptType,
          role: attemptExecutionConfig.role,
          requestedModel: attemptExecutionConfig.requestedModel,
          effectiveModel: attemptExecutionConfig.effectiveModel,
          providerModel: failedProviderModel,
          accountingModel: callResult?.accountingModel || attemptExecutionConfig.effectiveModel,
          reasoningEffort: attemptExecutionConfig.reasoningEffort,
          executionConfig: attemptExecutionConfig,
          model: failedModel,
          classification, decision: decision.action, escalationReason: decision.action === "escalate" ? decision.reason : null,
          decisionReason: decision.reason || null,
          startedAt: attemptStartedAt, endedAt: Date.now(), authoritativePrefixPublished,
          usage: progressiveUsageDiagnostics(
            attemptUsage,
            callResult?.accountingModel || attemptExecutionConfig.effectiveModel,
          ),
          providerResponseId: callResult?.responseId || error?._omniOpenAiDiagnostics?.providerResponseId || null,
          providerEventCount: callResult?.providerEventCount ?? error?._omniOpenAiDiagnostics?.providerEventCount ?? null,
          firstProviderEventMs: callResult?.firstProviderEventMs
            ?? error?._omniOpenAiDiagnostics?.firstProviderEventMs ?? null,
          usageSettlementStatus: "pending" };
        recoveryAttempts.push(attemptDiagnostics);
        console.info(`[omnimath:progressive-recovery] ${JSON.stringify({
          eventTimestamp: new Date().toISOString(), requestId, attemptId: eventIdentity.attemptId,
          providerAttemptIndex, routeAttemptId, attemptType,
          role: attemptDiagnostics.role,
          requestedModel: attemptDiagnostics.requestedModel,
          effectiveModel: attemptDiagnostics.effectiveModel,
          providerModel: attemptDiagnostics.providerModel,
          accountingModel: attemptDiagnostics.accountingModel,
          reasoningEffort: attemptDiagnostics.reasoningEffort,
          model: failedModel,
          failureClassification: classification, recoveryDecision: decision.action,
          recoveryReason: decision.reason || null,
          escalationReason: decision.action === "escalate" ? decision.reason : null,
          startedAt: attemptStartedAt, endedAt: attemptDiagnostics.endedAt,
          durationMs: attemptDiagnostics.endedAt - attemptDiagnostics.startedAt,
          authoritativePrefixPublished, providerResponseId: attemptDiagnostics.providerResponseId,
          providerEventCount: attemptDiagnostics.providerEventCount,
          firstProviderEventMs: attemptDiagnostics.firstProviderEventMs,
          usage: attemptDiagnostics.usage,
          usageSettlementStatus: attemptDiagnostics.usage.usageReported ? "pending" : "unavailable",
        })}`);
        if (decision.action === "retry") {
          retryAttempted = true;
          attemptType = "retry";
          logSolveRecovery("progressive_recovery_selected", {
            requestId,
            endpoint,
            attemptId: eventIdentity.attemptId,
            priorRouteAttemptId: routeAttemptId,
            nextRouteAttemptId: `${eventIdentity.attemptId}:route:${providerAttemptIndex + 1}`,
            recoveryDecision: "retry",
            recoveryReason: decision.reason,
            expectedImprovement: "bounded_transport_retry_after_transient_or_request_timeout",
            identicalExecutionConfigurationAllowed: true,
          });
          continue;
        }
        if (decision.action === "repair") {
          repairAttempted = true;
          activePrompt = buildRepairSolvePrompt(prompt, [error.reason || error.code || classification], {
            problem, previousResult: repairCandidate, error,
          });
          attemptType = "repair";
          logSolveRecovery("progressive_recovery_selected", {
            requestId,
            endpoint,
            attemptId: eventIdentity.attemptId,
            priorRouteAttemptId: routeAttemptId,
            nextRouteAttemptId: `${eventIdentity.attemptId}:route:${providerAttemptIndex + 1}`,
            recoveryDecision: "repair",
            recoveryReason: decision.reason,
            expectedImprovement: "complete_candidate_repair_with_changed_prompt_and_repair_route",
            identicalExecutionConfigurationAllowed: false,
          });
          continue;
        }
        if (decision.action === "escalate") {
          escalationAttempted = true;
          escalationReason = decision.reason;
          activePrompt = prompt;
          attemptType = "escalation";
          logSolveRecovery("progressive_recovery_selected", {
            requestId,
            endpoint,
            attemptId: eventIdentity.attemptId,
            priorRouteAttemptId: routeAttemptId,
            nextRouteAttemptId: `${eventIdentity.attemptId}:route:${providerAttemptIndex + 1}`,
            recoveryDecision: "escalate",
            recoveryReason: decision.reason,
            expectedImprovement: "materially_different_escalation_execution_configuration",
            identicalExecutionConfigurationAllowed: false,
            executionConfig: escalationExecutionConfig,
          });
          continue;
        }
        attachAccumulatedAiUsage(error, accumulatedUsage, providerCallCount);
        throw error;
      }
    }
    if (!metadata || !completedSteps.length || typeof framedFinal !== "string") {
      throw Object.assign(new Error("Provider stream did not contain a complete solution."), {
        code: "PROGRESSIVE_FRAME_INVALID",
      });
    }
    // The published prefix is the durable source of step identity and content.
    // A later whole-solution normalization cannot replace those steps.
    normalized.progressiveRecovery = {
      initialSelectedModel,
      finalAuthoritativeModel: authoritativeModel,
      finalAuthoritativeEffectiveModel: authoritativeEffectiveModel,
      escalationReason,
      providerCallCount,
      providerAttempts: recoveryAttempts,
    };
    if (abortController.signal.aborted) throw abortController.signal.reason;
    await settle(accumulatedUsage, providerCallCount, "success");
    setCachedExplanation(cacheKey, structuredClone(normalized));
    saveExplanationBestEffort(req, { source: persistenceSource, problem, result: normalized, identity })
      .catch((error) => console.warn("[omnimath:progressive-save-warning]", { requestId, code: error?.code || null }));
    emit("final_answer", { answer: {
      finalAnswer: normalized.finalAnswer || "",
      finalAnswerLatex: normalized.finalAnswerLatex || framedFinal,
      finalAnswerPresentation: normalized.finalAnswerPresentation,
      finalAnswerStepPresentations: normalized.finalAnswerStepPresentations,
    }, assurance: normalized.assurance });
    emit("solve_completed", {
      model: providerResult.providerModel ?? providerResult.model ?? null,
      providerModel: providerResult.providerModel ?? providerResult.model ?? null,
      effectiveModel: providerResult.effectiveModel || null,
      providerResponseId: providerResult.responseId,
    });
    const recoverySummary = progressiveRecoverySummary(recoveryAttempts, accumulatedUsage, providerCallCount);
    console.info(`[omnimath:progressive-terminal] ${JSON.stringify({
      eventTimestamp: new Date().toISOString(), requestId, attemptId: eventIdentity.attemptId,
      providerResponseId: providerResult.responseId,
      requestedModel: providerResult.requestedModel || null,
      effectiveModel: providerResult.effectiveModel || null,
      providerModel: providerResult.providerModel ?? providerResult.model ?? null,
      accountingModel: providerResult.accountingModel || providerResult.effectiveModel || null,
      reasoningEffort: providerResult.reasoningEffort ?? null,
      model: providerResult.providerModel ?? providerResult.model ?? null,
      steps: completedSteps.length, events: sequence,
      firstProviderByteMs: providerResult.firstProviderByteMs,
      firstProviderEventMs: firstProviderEventAt === null ? null : firstProviderEventAt - progressiveStartedAt,
      firstValidatedStepMs: firstValidatedStepAt === null ? null : firstValidatedStepAt - progressiveStartedAt,
      firstStepAcceptedAt: firstValidatedStepAt,
      durationMs: Date.now() - progressiveStartedAt,
      totalDurationMs: Date.now() - progressiveStartedAt,
      terminalReason: "completed", usageSettled: settlementSucceeded, settlementStatus,
      providerCallCount, initialSelectedModel,
      finalAuthoritativeModel: authoritativeModel,
      finalAuthoritativeEffectiveModel: authoritativeEffectiveModel,
      finalFailureClassification: null, finalRecoveryDecision: null,
      escalationReason, partialPrefixFailure: false,
      ...recoverySummary,
      providerAttempts: recoveryAttempts,
    })}`);
  } catch (error) {
    const cancelled = abortController.signal.aborted;
    try {
      await settle(accumulatedUsage || error?._aiUsage || providerResult?.usage || null,
        providerCallCount || error?._aiCallCount || providerResult?.providerCallCount || 0,
        cancelled ? "cancelled" : "failure");
    } catch (settlementError) {
      console.warn("[omnimath:progressive-usage-warning]", {
        requestId, code: settlementError?.code || null,
      });
    }
    const finalFailure = recoveryAttempts.at(-1);
    const preserveProviderReason = ["usage_rate_limit_error", "authentication_configuration_error", "bad_request", "refusal"]
      .includes(finalFailure?.classification);
    emit(cancelled ? "solve_cancelled" : "solve_failed", cancelled ? {} : {
      reason: recoveryAttempts.length > 1 && !preserveProviderReason
        ? "The AI service could not complete the explanation after recovery attempts."
        : error.publicMessage || "The AI service could not complete the explanation.",
      retryable: !["PROGRESSIVE_STEP_REJECTED", "PROGRESSIVE_FRAME_INVALID"].includes(error.code),
      failureClassification: finalFailure?.classification || null,
      recoveryDecision: finalFailure?.decision || null,
    });
    if (completedSteps.length) {
      const partial = {
        ...(metadata || {}),
        steps: completedSteps,
        progressiveSolve: {
          ...eventIdentity,
          status: cancelled ? "cancelled" : "failed",
          completedStepIds: completedSteps.map((step) => step.id),
          finalAnswer: null,
          failure: cancelled ? null : {
            message: "Generation stopped before completion.", retryable: true,
          },
          mode: "progressive",
        },
      };
      saveExplanationBestEffort(req, { source: persistenceSource, problem, result: partial, identity })
        .catch((saveError) => console.warn("[omnimath:progressive-save-warning]", {
          requestId, code: saveError?.code || null,
        }));
    }
    const recoverySummary = progressiveRecoverySummary(recoveryAttempts, accumulatedUsage, providerCallCount);
    const finalExecution = recoveryAttempts.at(-1) || null;
    console.warn(`[omnimath:progressive-terminal] ${JSON.stringify({
      eventTimestamp: new Date().toISOString(), requestId, attemptId: eventIdentity.attemptId,
      providerResponseId: providerResult?.responseId || error?._omniOpenAiDiagnostics?.providerResponseId || null,
      requestedModel: finalExecution?.requestedModel
        || error?._omniOpenAiDiagnostics?.requestedModel || null,
      effectiveModel: finalExecution?.effectiveModel
        || error?._omniOpenAiDiagnostics?.effectiveModel || null,
      providerModel: finalExecution?.providerModel
        ?? error?._omniOpenAiDiagnostics?.providerModel
        ?? error?._omniOpenAiDiagnostics?.responseModel
        ?? null,
      accountingModel: finalExecution?.accountingModel
        || error?._omniOpenAiDiagnostics?.accountingModel || null,
      reasoningEffort: finalExecution?.reasoningEffort
        ?? error?._omniOpenAiDiagnostics?.reasoningEffort
        ?? null,
      model: finalExecution?.providerModel
        ?? error?._omniOpenAiDiagnostics?.providerModel
        ?? error?._omniOpenAiDiagnostics?.responseModel
        ?? null,
      steps: completedSteps.length, events: sequence,
      terminalReason: cancelled ? "cancelled" : error.code || "failure",
      firstProviderEventMs: firstProviderEventAt === null ? null : firstProviderEventAt - progressiveStartedAt,
      firstValidatedStepMs: firstValidatedStepAt === null ? null : firstValidatedStepAt - progressiveStartedAt,
      firstStepAcceptedAt: firstValidatedStepAt,
      durationMs: Date.now() - progressiveStartedAt,
      totalDurationMs: Date.now() - progressiveStartedAt,
      usageSettled: settlementSucceeded, settlementStatus, providerCallCount,
      initialSelectedModel, finalAuthoritativeModel: authoritativeModel,
      finalAuthoritativeEffectiveModel: authoritativeEffectiveModel,
      finalFailureClassification: finalFailure?.classification || null,
      finalRecoveryDecision: finalFailure?.decision || null,
      recoveryReason: finalFailure?.decisionReason || null,
      escalationReason, partialPrefixFailure: !cancelled && completedSteps.length > 0,
      ...recoverySummary,
      providerAttempts: recoveryAttempts,
    })}`);
  } finally {
    res.off("close", onClose);
    req.off?.("error", onRequestError);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

export async function handleExplainRequest(req, res) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  await runHandler(res, async () => {
    const startedAt = Date.now();
    const solveContext = canonicalSolveRequestContexts.get(req) || {};
    const endpoint = solveContext.endpoint || "/api/explain";
    const inputSource = solveContext.inputSource || "typed";
    const usageKind = solveContext.usageKind || "explanation";
    const persistenceSource = solveContext.persistenceSource || "text";
    const sourceMetadata = solveContext.sourceMetadata || null;
    const identity = await requireRequestIdentity(req, solveContext.identityOperation || "explain");
    throttleRequest(req, identity, "ai");
    assertAiEnabled();
    const body = await readJson(req);
    requireObject(body);
    const requestId = optionalShortText(body.debugRequestId || body.clientRequestId || "", "Debug request id", 120)
      || createDebugRequestId("solve-text");
    const requestedProblemInput = body.problemInput && typeof body.problemInput === "object"
      ? body.problemInput
      : {};
    const canonicalProblem = normalizeCanonicalProblem(body, {
      canonicalText: requestedProblemInput.problemText || "",
      source: inputSource,
      forceSource: inputSource,
    });
    const problemInput = {
      problemText: requireTextProblem(getCanonicalSolverInput(canonicalProblem, requestedProblemInput.problemText)),
      source: inputSource,
      sourceMetadata,
    };
    const problem = problemInput.problemText;
    logCanonicalProblem("solve request", canonicalProblem, { endpoint, inputSource });
    logSolveDebug("shared_solver_entry", {
      ...imageSolveTelemetry(sourceMetadata),
      requestId,
      endpoint,
      inputSource,
      canonicalInputHash: canonicalProblem.hash,
      normalizedProblemHash: hashDebugText(problem),
    });
    logSolutionStateDebug("server explain received", {
      receivedProblemText: problem,
      bodyKeys: Object.keys(body),
      historyCount: Array.isArray(body.history) ? body.history.length : 0,
      hasSelectedTokenContext: Boolean(body.selectedTokenId || body.selectedLatex || body.selectedText),
    });
    const history = parseHistory(body.history);
    const { reference, depth } = getCacheRequestFields(body);
    const cacheKey = createExplanationCacheKey({
      userId: identity.clerkUserId,
      problem,
      canonicalInputHash: canonicalProblem.hash,
      context: {
        inputSource,
        history,
      },
      reference,
      depth,
      type: "canonical-solve",
    });
    const cachedBase = getCachedExplanation(cacheKey);
    if (cachedBase) {
      const cached = structuredClone(cachedBase);
      const originEvidence = cached.assurance?.version === "bounded-assurance-v1"
        ? { assurance: structuredClone(cached.assurance),
          verification: structuredClone(cached.verification),
          candidateAcceptance: structuredClone(cached.candidateAcceptance) } : null;
      // Cached local-rule teaching cards use a prose `finalAnswer` and do not
      // claim a provider-style `finalAnswerLatex`. Preserve the same
      // structural contract used on the initial local-rule path.
      withSolveDiagnosticContext({ requestId, endpoint }, () => finalizeSolveCandidate(cached, {
        problem,
        inputSource,
        requireFinalAnswer: Boolean(String(cached.finalAnswerLatex || "").trim()),
      }));
      if (originEvidence) Object.assign(cached, originEvidence);
      const usage = await getUsageForKind(req, usageKind, identity);
      cached.canonicalProblem = canonicalProblem;
      cached.canonicalInputHash = canonicalProblem.hash;
      cached.canonicalContentHash = canonicalProblem.contentHash;
      if (sourceMetadata) Object.assign(cached, sourceMetadata);
      logExplanationSource({
        source: "cached",
        kind: persistenceSource,
        endpoint,
        identity,
        requestId,
      });
      sendJson(
        res,
        200,
        buildResponse(cached, { usage, source: "cached", demoMode: !isOpenAiConfigured(), canonicalProblem, requestId }),
        createUsageHeaders(usage)
      );
      return;
    }

    const prompt = buildMathExplanationPrompt({ problem, history });
    const promptHash = hashDebugText(prompt);
    const solveTimeoutMs = getSolveTotalTimeoutMs();
    const cancellationRequest = solveContext.originalRequest || req;
    const cancellationResponse = solveContext.originalResponse || res;
    const requestAbortController = new AbortController();
    const abortForClientDisconnect = () => {
      if (cancellationResponse.writableEnded || requestAbortController.signal.aborted) return;
      const reason = new DOMException("Client disconnected.", "AbortError");
      reason.timeoutSource = "upstream_abort";
      reason.timeoutScope = "upstream";
      requestAbortController.abort(reason);
    };
    const onRequestError = (error) => {
      if (error?.message === "aborted" || error?.code === "ECONNRESET") abortForClientDisconnect();
    };
    const onRequestSignalAbort = () => abortForClientDisconnect();
    cancellationResponse.on?.("close", abortForClientDisconnect);
    cancellationRequest.on?.("aborted", abortForClientDisconnect);
    cancellationRequest.on?.("error", onRequestError);
    cancellationRequest.signal?.addEventListener?.("abort", onRequestSignalAbort, { once: true });
    if (cancellationRequest.aborted || cancellationRequest.signal?.aborted) abortForClientDisconnect();
    const solveBudget = createSolveBudget({
      totalTimeoutMs: solveTimeoutMs,
      signal: requestAbortController.signal,
    });
    const solveDeadlineAt = solveBudget.deadlineAt;
    try {
    const initialRouting = resolveInitialSolveRouting({
      problem,
      // Routing consumes the same canonical solver text as the prompt. OCR-only
      // display LaTeX remains provenance and must not create a second policy.
      canonicalLatex: problem,
    });
    const solverSampling = getOpenAiSamplingForPath(initialRouting.selectedInitialModelRole);
    logInitialSolveRouting({ requestId, endpoint, routing: initialRouting });
    logSolveDebug("request_received", {
      requestId,
      endpoint,
      normalizedProblem: problem,
      normalizedProblemHash: hashDebugText(problem),
      promptHash,
      model: initialRouting.selectedInitialModel,
      ...initialRouting,
      temperature: solverSampling.temperature ?? null,
      topP: solverSampling.top_p ?? null,
      temperatureSource: solverSampling.temperature === undefined ? "provider_default" : "payload",
      topPSource: solverSampling.top_p === undefined ? "provider_default" : "payload",
      cacheKey,
      historyCount: history.length,
      solveTimeoutMs,
      solveDeadlineAt,
      primaryDeadlineAt: solveBudget.primaryDeadlineAt,
      recoveryDeadlineAt: solveBudget.recoveryDeadlineAt,
      timeoutOwner: "canonical_solve",
    });
    logSolutionStateDebug("server prompt problem", {
      promptProblemText: problem,
      promptChars: prompt.length,
    });
    const initialMaxOutputTokens = getSolveOutputTokenBudget({
      modelPath: initialRouting.selectedInitialModelPath,
      debugContext: { attemptType: "initial", initialRouting },
    });
    const estimatedTokens = estimateOpenAiTokenBudget({ prompt, maxOutputTokens: initialMaxOutputTokens });
    const estimatedCostMicros = dollarsToMicros(estimateOpenAiCostBudget({ prompt, maxOutputTokens: initialMaxOutputTokens }));
    if (body.progressiveMode === "provider-stream") {
      if (!progressiveProviderEnabled()) {
        throw Object.assign(new Error("Provider streaming is not enabled."), {
          statusCode: 404, code: "PROGRESSIVE_SOLVE_DISABLED",
          publicMessage: "Progressive solving is not available.",
        });
      }
      await handleProgressiveProviderSolve({
        req, res, body, requestId, prompt, problem, canonicalProblem,
        initialRouting, solveDeadlineAt, solveBudget, usageKind, persistenceSource, identity,
        estimatedTokens, estimatedCostMicros, endpoint, inputSource, cacheKey, sourceMetadata,
      });
      return;
    }
    const { duplicate, value } = await runDeduplicatedRequest(cacheKey, () => withSolveDiagnosticContext({ requestId, endpoint }, async () => {
      let result = createLocalRuleExplanation(problem, { source: "text" });
      let source = "local rule";
      const willCallOpenAi = !result && isOpenAiConfigured();
      const { reservation } = willCallOpenAi
        ? await checkAndReserveUsage({
            req,
            identity,
            kind: usageKind,
            estimatedTokens,
            estimatedCostMicros,
          })
        : { reservation: null };
      if (!willCallOpenAi && !isProductionRuntime()) {
        console.info("[omnimath:usage]", {
          event: "allowed",
          route: endpoint,
          reason: result ? "local-rule-no-ai-reservation" : "no-openai-configured-no-reservation",
          subject: identity.subject,
          tier: identity.tier,
        });
      }
      let usage;
      let accumulatedAiUsage = null;
      let accumulatedAiCallCount = 0;
      const initialExecutionConfig = solveExecutionConfig({
        modelPath: initialRouting.selectedInitialModelPath,
        attemptType: "initial",
        recoveryPurpose: "initial_generation",
        promptStrategy: "canonical_problem",
      });
      const escalationExecutionConfig = solveExecutionConfig({
        modelPath: "escalation",
        attemptType: "escalation",
        recoveryPurpose: "structured_output_recovery",
        promptStrategy: "fresh_from_canonical_problem",
      });
      const assuranceExecutionConfig = solveExecutionConfig({
        modelPath: "escalation", attemptType: "escalation",
        recoveryPurpose: "mathematical_assurance_recovery",
        promptStrategy: "fresh_from_canonical_problem",
      });
      let selectedRecoveryExecutionConfig = null;

      try {
        if (result) {
          try {
            // Local rule explanations intentionally end in a prose teaching
            // statement (`finalAnswer`) rather than a solver-style
            // `finalAnswerLatex`. Keep the structural step guard, while not
            // requiring the provider-only final-answer contract for this
            // deterministic, non-AI path.
            acceptStructurallyParsedSolve(result, {
              requireFinalAnswer: source !== "local rule",
            });
          } catch (error) {
            if (!isOpenAiConfigured()) throw error;
            result = null;
          }
        }

        if (!result) {
          if (!isOpenAiConfigured()) {
            throw createOpenAiRequiredError();
          } else {
            try {
              logSolveRecovery("attempt_started", {
                requestId,
                endpoint,
                routeAttemptId: `${requestId}:route:1`,
                routeAttemptIndex: 1,
                recoveryPurpose: "initial_generation",
                executionConfig: initialExecutionConfig,
              });
              result = await createMathExplanation({
                prompt,
                originalProblem: problem,
                modelPath: initialRouting.selectedInitialModelPath,
                debugContext: {
                  ...imageSolveTelemetry(sourceMetadata),
                  requestId,
                  routeAttemptId: `${requestId}:route:1`,
                  routeAttemptIndex: 1,
                  recoveryPurpose: "initial_generation",
                  endpoint,
                  inputSource,
                  normalizedProblem: problem,
                  promptHash,
                  solveDeadlineAt,
                  solveBudget,
                  initialRouting,
                },
                onGeneratedResponseFailure: createGeneratedResponseFailureCapture({
                  requestId,
                  endpoint,
                  prompt,
                  promptHash,
                  problem,
                  problemText: "",
                  canonicalProblem,
                  repairAttempted: false,
                  qualityRepairAttempted: false,
                }),
              });
              accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(result));
              accumulatedAiCallCount += aiCallCountFrom(result);
              attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
              result = applyLocalRulesToExplanation(result);
              acceptStructurallyParsedSolve(result);
              source = "live AI call";
            } catch (firstError) {
              accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(firstError));
              accumulatedAiCallCount += aiCallCountFrom(firstError);
              let recoveryPolicyError = solveBudget.signal.aborted
                ? solveBudget.signal.reason
                : firstError;
              if (!solveBudget.signal.aborted && solveBudget.canonicalRemainingMs() <= 0) {
                try {
                  solveBudget.throwIfExpired();
                } catch (deadlineError) {
                  recoveryPolicyError = deadlineError;
                  attachAccumulatedAiUsage(recoveryPolicyError, accumulatedAiUsage, accumulatedAiCallCount);
                }
              }
              const failureClassification = classifySolveFailure({
                error: recoveryPolicyError,
                candidate: null,
              });
              const recoveryDecision = decideOrdinaryRecovery({
                error: recoveryPolicyError,
                routeAttemptCount: 1,
                escalationAttempted: false,
                canonicalDeadlineRemaining: solveBudget.canonicalRemainingMs() > 0,
                recoveryBudgetRemaining: solveBudget.canStartRecovery(),
                recoveryEligible: initialRouting.recoveryEligible,
                usableCandidateExists: false,
                initialConfig: initialExecutionConfig,
                escalationConfig: escalationExecutionConfig,
              });
              await captureSolveQualityFailure({
                error: firstError,
                result: null,
                stage: "initial",
                requestId,
                endpoint,
                prompt,
                promptHash,
                problem,
                problemText: "",
                canonicalProblem,
                repairAttempted: false,
                failureClassification: failureClassification.category,
                qualityRepairAttempted: false,
                compactRetryAttempted: Boolean(firstError?._omniOpenAiDiagnostics?.attemptType?.includes("compact")),
                freshEscalationAttempted: recoveryDecision.action === "escalate",
              });
              logSolveDebug("solve_failure_classification", {
                requestId,
                endpoint,
                ...failureClassification,
                ordinaryFailureClassification: recoveryDecision.classification,
                recoveryDecision: recoveryDecision.action,
                recoveryReason: recoveryDecision.reason,
                qualityRepairAttempted: false,
                compactRetryAttempted: Boolean(firstError?._omniOpenAiDiagnostics?.attemptType?.includes("compact")),
                freshEscalationAttempted: recoveryDecision.action === "escalate",
              });
              logSolveRecovery("attempt_failed", {
                requestId,
                endpoint,
                routeAttemptId: `${requestId}:route:1`,
                routeAttemptIndex: 1,
                classification: recoveryDecision.classification,
                recoveryDecision: recoveryDecision.action,
                recoveryReason: recoveryDecision.reason,
                nextRouteAttemptId: ["escalate", "retry"].includes(recoveryDecision.action)
                  ? `${requestId}:route:2` : null,
                executionConfig: initialExecutionConfig,
              });
              if (!["escalate", "retry"].includes(recoveryDecision.action)) {
                throw recoveryPolicyError;
              }
              const timeoutRecovery = recoveryDecision.action === "retry";
              const escalationPrompt = timeoutRecovery
                ? prompt
                : `${prompt}\n\nStructured-output recovery instruction:\n- This is a fresh solve from the canonical problem.\n- The earlier attempt was unusable because ${recoveryDecision.classification}.\n- Return one complete JSON object matching the requested schema.\n- Do not continue or quote the earlier output.`;
              const escalationPromptHash = hashDebugText(escalationPrompt);
              const recoveryPurpose = timeoutRecovery
                ? "provider_attempt_timeout_recovery"
                : "structured_output_recovery";
              const recoveryExecutionConfig = timeoutRecovery
                ? solveExecutionConfig({
                    modelPath: initialRouting.selectedInitialModelPath,
                    attemptType: "recovery",
                    recoveryPurpose,
                    promptStrategy: "canonical_problem",
                  })
                : escalationExecutionConfig;
              selectedRecoveryExecutionConfig = recoveryExecutionConfig;
              logSolveRecovery("recovery_selected", {
                requestId,
                endpoint,
                priorRouteAttemptId: `${requestId}:route:1`,
                routeAttemptId: `${requestId}:route:2`,
                routeAttemptIndex: 2,
                recoveryPurpose,
                recoveryReason: recoveryDecision.reason,
                timeoutScope: firstError?.timeoutScope || null,
                timeoutSource: firstError?.timeoutSource || null,
                budgetLimitReason: firstError?.budgetLimitReason || null,
                canonicalRemainingMs: solveBudget.canonicalRemainingMs(),
                recoveryRemainingMs: solveBudget.remainingMs({ recovery: true }),
                expectedImprovement: timeoutRecovery
                  ? "fresh_provider_dispatch_with_reserved_recovery_budget"
                  : "higher_reasoning_fresh_prompt_without_reusing_invalid_output",
                promptHash: escalationPromptHash,
                executionConfig: recoveryExecutionConfig,
              });
              try {
                result = await createMathExplanation({
                  prompt: escalationPrompt,
                  originalProblem: problem,
                  modelPath: timeoutRecovery ? initialRouting.selectedInitialModelPath : "escalation",
                  allowCompactRetry: false,
                  debugContext: {
                  ...imageSolveTelemetry(sourceMetadata),
                    requestId,
                    routeAttemptId: `${requestId}:route:2`,
                    routeAttemptIndex: 2,
                    recoveryPurpose,
                    attemptType: timeoutRecovery ? "recovery" : "escalation",
                    endpoint,
                    inputSource,
                    normalizedProblem: problem,
                    promptHash: escalationPromptHash,
                    solveDeadlineAt,
                    solveBudget,
                    solveBudgetStage: "recovery",
                    retryPurpose: timeoutRecovery
                      ? "provider-attempt-timeout-recovery"
                      : "structured-output-recovery",
                    initialRouting,
                  },
                  onGeneratedResponseFailure: createGeneratedResponseFailureCapture({
                    requestId,
                    endpoint,
                    prompt: escalationPrompt,
                    promptHash: escalationPromptHash,
                    problem,
                    problemText: "",
                    canonicalProblem,
                    repairAttempted: false,
                    freshEscalationAttempted: !timeoutRecovery,
                  }),
                });
                accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(result));
                accumulatedAiCallCount += aiCallCountFrom(result);
                attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
                result = applyLocalRulesToExplanation(result);
                acceptStructurallyParsedSolve(result);
                source = timeoutRecovery ? "live AI recovery call" : "live AI escalation call";
              } catch (escalationError) {
                const failureUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(escalationError));
                const failureCallCount = accumulatedAiCallCount + aiCallCountFrom(escalationError);
                const finalRecoveryDecision = decideOrdinaryRecovery({
                  error: escalationError,
                  routeAttemptCount: 2,
                  escalationAttempted: !timeoutRecovery,
                  canonicalDeadlineRemaining: solveBudget.canonicalRemainingMs() > 0,
                  recoveryBudgetRemaining: solveBudget.canStartRecovery(),
                  recoveryEligible: initialRouting.recoveryEligible,
                  usableCandidateExists: false,
                  initialConfig: initialExecutionConfig,
                  escalationConfig: escalationExecutionConfig,
                });
                const preserveRecoveryError = ["client_cancellation", "total_solve_deadline"]
                  .includes(finalRecoveryDecision.classification)
                  || (finalRecoveryDecision.classification === "request_timeout"
                    && escalationError?.code === "AI_SOLVE_TIMEOUT");
                const terminalError = timeoutRecovery && !preserveRecoveryError
                  ? firstError
                  : escalationError;
                attachAccumulatedAiUsage(terminalError, failureUsage, failureCallCount);
                if (terminalError === firstError) {
                  terminalError.recoveryFailureCode = escalationError?.code || null;
                  terminalError.recoveryFailureType = escalationError?.responseFailureType || null;
                  terminalError.recoveryDiagnostics = escalationError?._omniOpenAiDiagnostics || null;
                }
                logSolveRecovery("attempt_failed", {
                  requestId,
                  endpoint,
                  routeAttemptId: `${requestId}:route:2`,
                  routeAttemptIndex: 2,
                  classification: finalRecoveryDecision.classification,
                  recoveryDecision: "fail",
                  recoveryReason: finalRecoveryDecision.reason,
                  timeoutScope: escalationError?.timeoutScope || firstError?.timeoutScope || null,
                  timeoutSource: escalationError?.timeoutSource || firstError?.timeoutSource || null,
                  budgetLimitReason: escalationError?.budgetLimitReason || firstError?.budgetLimitReason || null,
                  canonicalRemainingMs: solveBudget.canonicalRemainingMs(),
                  recoveryRemainingMs: solveBudget.remainingMs({ recovery: true }),
                  executionConfig: recoveryExecutionConfig,
                });
                await captureSolveQualityFailure({
                  error: escalationError,
                  result: null,
                  stage: "escalation",
                  requestId,
                  endpoint,
                  prompt: escalationPrompt,
                  promptHash: escalationPromptHash,
                  problem,
                  problemText: "",
                  canonicalProblem,
                  repairAttempted: false,
                  freshEscalationAttempted: !timeoutRecovery,
                });
                throw terminalError;
              }
            }
          }
        }
        const firstRouteAttemptIndex = ["live AI escalation call", "live AI recovery call"].includes(source) ? 2 : 1;
        const firstRouteAttemptId = `${requestId}:route:${firstRouteAttemptIndex}`;
        const firstCandidateId = result?._omniOpenAiDiagnostics?.candidateId
          || `${firstRouteAttemptId}:candidate:${source === "local rule" ? "local" : "selected"}`;
        finalizeSolveCandidate(result, {
          problem,
          inputSource,
          requireFinalAnswer: source !== "local rule",
          candidateId: firstCandidateId,
          routeAttemptId: firstRouteAttemptId,
        });
        logAssuranceChecks({ requestId, endpoint, assurance: result.assurance });
        const assuranceCandidates = [{ result, assurance: result.assurance }];
        const assuranceRecovery = decideAssuranceRecovery({
          assurance: result.assurance,
          routeAttemptCount: firstRouteAttemptIndex,
          deadlineRemaining: solveBudget.canStartRecovery(),
          escalationAvailable: isMeaningfullyDifferentEscalationConfig(
            initialExecutionConfig, escalationExecutionConfig,
          ) && source === "live AI call",
        });
        if (!solveBudget.canStartRecovery() && assuranceRecovery.action !== "present") {
          assuranceRecovery.reason = "insufficient_recovery_budget";
        }
        logSolveRecovery("assurance_decision", {
          requestId, endpoint, candidateId: firstCandidateId,
          routeAttemptId: firstRouteAttemptId,
          assuranceStatus: result.assurance.status,
          contradictionCategories: result.assurance.findings.map((finding) => finding.category),
          recoveryDecision: assuranceRecovery.action,
          recoveryReason: assuranceRecovery.reason,
          nextRouteAttemptId: assuranceRecovery.action === "escalate" ? `${requestId}:route:2` : null,
        });
        if (assuranceRecovery.action === "escalate") {
          let assuranceRecoveryFailure = null;
          const contradictionCategories = result.assurance.findings.map((finding) => finding.category);
          const assurancePrompt = `${prompt}\n\nMathematical assurance recovery instruction:\n- Solve the canonical problem afresh with the higher-reasoning route.\n- A supported check found a concrete contradiction category: ${contradictionCategories.join(", ")}.\n- Check your final answer against the submitted problem. Return one complete JSON object.`;
          const assurancePromptHash = hashDebugText(assurancePrompt);
          logSolveRecovery("recovery_selected", {
            requestId, endpoint, priorRouteAttemptId: firstRouteAttemptId,
            routeAttemptId: `${requestId}:route:2`, routeAttemptIndex: 2,
            recoveryPurpose: "mathematical_assurance_recovery",
            recoveryReason: assuranceRecovery.reason,
            contradictionCategories, promptHash: assurancePromptHash,
            executionConfig: assuranceExecutionConfig,
          });
          try {
            let replacement = await createMathExplanation({
              prompt: assurancePrompt, originalProblem: problem,
              modelPath: "escalation", allowCompactRetry: false,
              debugContext: {
                  ...imageSolveTelemetry(sourceMetadata),
                requestId, routeAttemptId: `${requestId}:route:2`, routeAttemptIndex: 2,
                recoveryPurpose: "mathematical_assurance_recovery", attemptType: "escalation",
                endpoint, inputSource, normalizedProblem: problem,
                promptHash: assurancePromptHash, solveDeadlineAt, solveBudget, solveBudgetStage: "recovery", initialRouting,
              },
              onGeneratedResponseFailure: createGeneratedResponseFailureCapture({
                requestId, endpoint, prompt: assurancePrompt, promptHash: assurancePromptHash,
                problem, problemText: "", canonicalProblem,
                repairAttempted: false, freshEscalationAttempted: true,
              }),
            });
            accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(replacement));
            accumulatedAiCallCount += aiCallCountFrom(replacement);
            replacement = applyLocalRulesToExplanation(replacement);
            acceptStructurallyParsedSolve(replacement);
            const replacementCandidateId = replacement?._omniOpenAiDiagnostics?.candidateId
              || `${requestId}:route:2:candidate:selected`;
            finalizeSolveCandidate(replacement, {
              problem, inputSource, candidateId: replacementCandidateId,
              routeAttemptId: `${requestId}:route:2`,
            });
            logAssuranceChecks({ requestId, endpoint, assurance: replacement.assurance });
            assuranceCandidates.push({ result: replacement, assurance: replacement.assurance });
            logSolveRecovery("assurance_candidate_assessed", {
              requestId, endpoint, candidateId: replacementCandidateId,
              routeAttemptId: `${requestId}:route:2`,
              assuranceStatus: replacement.assurance.status,
              contradictionCategories: replacement.assurance.findings.map((finding) => finding.category),
              recoveryDecision: "stop_after_one_assurance_recovery",
            });
          } catch (assuranceError) {
            assuranceRecoveryFailure = assuranceError?.code || "candidate_unusable";
            accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(assuranceError));
            accumulatedAiCallCount += aiCallCountFrom(assuranceError);
            logSolveRecovery("assurance_recovery_failed", {
              requestId, endpoint, routeAttemptId: `${requestId}:route:2`,
              recoveryReason: assuranceError?.code || "candidate_unusable",
              recoveryDecision: "present_original_unresolved",
            });
          }
          const selected = selectAssuranceCandidate(assuranceCandidates);
          result = selected.result;
          finalizeAssuranceSelection(selected, assuranceCandidates, true, {
            attempted: true,
            outcome: assuranceRecoveryFailure ? "recovery_failed"
              : selected.result === assuranceCandidates[0].result ? "unresolved" : "replacement_selected",
            reason: assuranceRecoveryFailure || assuranceRecovery.reason,
            routeAttemptId: `${requestId}:route:2`,
          });
          if (selected.result !== assuranceCandidates[0].result) source = "live AI escalation call";
        } else {
          finalizeAssuranceSelection(assuranceCandidates[0], assuranceCandidates, false, {
            attempted: false,
            outcome: assuranceRecovery.action === "present_unresolved" ? "unresolved" : "not_attempted",
            reason: assuranceRecovery.reason,
          });
        }
        const acceptedCandidate = result;
        const acceptedDiagnostics = acceptedCandidate?._omniOpenAiDiagnostics || {};
        const acceptedNormalizationActions = acceptedCandidate?._omniNormalizationActions || [];
        const acceptedRecoverableFindings = acceptedCandidate?._omniRecoverableFindings || [];
        const acceptedWarnings = acceptedCandidate?._omniWarnings || [];
        try {
          const annotated = annotateMathExplanation(acceptedCandidate);
          if (acceptedCandidate?._omniOpenAiDiagnostics) {
            Object.defineProperty(annotated, "_omniOpenAiDiagnostics", {
              enumerable: false,
              configurable: true,
              value: acceptedCandidate._omniOpenAiDiagnostics,
            });
          }
          acceptStructurallyParsedSolve(annotated, {
            stage: "post_annotation",
            requireFinalAnswer: source !== "local rule",
          });
          result = annotated;
        } catch (annotationError) {
          // The provider candidate was already rendered and structurally
          // accepted. If a later semantic decoration fails, keep that usable
          // candidate with its original step, anchor, and follow-up identity.
          if (source === "local rule") throw annotationError;
          acceptStructurallyParsedSolve(acceptedCandidate, {
            stage: "pre_annotation_fallback",
          });
          console.warn("[omnimath:solve-annotation-fallback]", {
            requestId,
            issues: annotationError?.solutionIssues || [annotationError?.code || "annotation_error"],
          });
          result = acceptedCandidate;
        }
        const acceptedInspection = inspectSolveCandidateStructure(result, { stage: "selected" });
        const acceptedRouteAttemptIndex = result.assurance?.routeAttemptId?.endsWith(":route:2") ? 2 : 1;
        const acceptedRouteAttemptId = result.assurance?.routeAttemptId
          || `${requestId}:route:${acceptedRouteAttemptIndex}`;
        logSolveCandidateOutcome({
          requestId,
          attemptId: `${acceptedRouteAttemptId}:accepted`,
          candidateId: result.assurance?.candidateId || acceptedDiagnostics.candidateId || `${requestId}:selected`,
          solveMode: acceptedDiagnostics.solveMode || (source === "local rule" ? "local" : "solver"),
          model: acceptedDiagnostics.model || result?._aiUsage?._omni_model_usage?.at(-1)?.model || null,
          providerCompletionStatus: source === "local rule" ? "not_applicable" : "completed",
          truncationState: acceptedDiagnostics.responseTruncated ? "truncated" : "complete",
          normalizationActions: acceptedNormalizationActions,
          fatalFindings: [],
          recoverableFindings: acceptedRecoverableFindings,
          warnings: [...acceptedWarnings, ...acceptedInspection.warnings],
          previousUsableCandidate: Boolean(result.assurance?.history?.length > 1),
          selectedForUi: true,
          outcome: "selected_for_ui",
        });
        logSolveRecovery("candidate_selected", {
          requestId,
          endpoint,
          routeAttemptId: acceptedRouteAttemptId,
          routeAttemptIndex: acceptedRouteAttemptIndex,
          candidateId: result.assurance?.candidateId || acceptedDiagnostics.candidateId || `${requestId}:selected`,
          verificationPolicy: "bounded_mathematical_assurance_v1",
          verificationStatus: result?.assurance?.status || null,
          assuranceStatus: result?.assurance?.status || null,
          recoveryAttempted: result?.assurance?.recoveryAttempted || false,
          selectedForUi: true,
          executionConfig: acceptedRouteAttemptIndex === 2
            ? result.assurance?.recovery?.routeAttemptId === acceptedRouteAttemptId
              ? assuranceExecutionConfig : selectedRecoveryExecutionConfig || escalationExecutionConfig
            : initialExecutionConfig,
        });
        attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
        logSolutionStateDebug("server model response", {
          problemText: problem,
          responseTitle: result.title || "",
          responseProblem: result.problem || result.originalProblem || result.expression || "",
          normalizedStepCount: getSolutionStepsForDebug(result),
          source,
        });

        solveBudget.throwIfExpired();
        usage = reservation
          ? await settleAiUsageReservation(reservation, result._aiUsage, {
              providerCalls: result._aiCallCount || 0,
              settlementReason: "success",
              providerAttempts: solveBudget.providerAttempts,
            })
          : await getUsageForKind(req, usageKind, identity);
      } catch (error) {
        logSolveDebug("candidate_boundary_failure", {
          requestId,
          endpoint,
          stage: error?.solutionStage || error?.responseFailureType || null,
          solutionIssues: Array.isArray(error?.solutionIssues) ? error.solutionIssues : [],
          solutionDiagnostics: Array.isArray(error?.solutionDiagnostics) ? error.solutionDiagnostics : [],
          responseFailureType: error?.responseFailureType || null,
          code: error?.code || null,
        });
        try {
          usage = await settleFailureUsageOrRelease(reservation, error, result, solveBudget.providerAttempts);
          if (usage) error.usage = usage;
        } catch (releaseError) {
          console.warn("Could not settle failed token reservation:", releaseError.message);
        }
        error.omniDebugContext = { ...error.omniDebugContext, requestId, endpoint };
        throw error;
      }

      // Cache only the source-neutral solver result. OCR/image provenance is
      // applied to the response copy below and must never leak into a typed hit.
      setCachedExplanation(cacheKey, structuredClone(result));
      logAcceptedSolvePayload({
        requestId,
        endpoint,
        problem,
        result,
        source,
      });
      logSolveTiming({
        endpoint,
        startedAt,
        source,
        identity,
        prompt,
        aiUsage: result._aiUsage,
        apiCallCount: result._aiCallCount || (willCallOpenAi ? 1 : 0),
      });
      logExplanationSource({
        source,
        kind: persistenceSource,
        endpoint,
        identity,
        requestId,
        attemptId: result?._omniOpenAiDiagnostics?.attemptId || null,
        recoveryPurpose: result?._omniOpenAiDiagnostics?.recoveryPurpose || null,
        prompt,
        aiUsage: result._aiUsage,
        execution: result?._omniOpenAiDiagnostics || null,
      });
      result.canonicalProblem = canonicalProblem;
      result.canonicalInputHash = canonicalProblem.hash;
      result.canonicalContentHash = canonicalProblem.contentHash;
      if (sourceMetadata) Object.assign(result, structuredClone(sourceMetadata));
      // Persistence is deliberately outside the live-answer critical path.
      // A database outage or a slow connection must not turn a successful
      // provider result into a failed/late solve in the browser. Keep the
      // promise observed so a rejected background save cannot become an
      // unhandled rejection; the helper itself emits save diagnostics.
      const savePromise = saveExplanationBestEffort(req, { source: persistenceSource, problem, result, identity });
      savePromise.then((backgroundSaved) => {
        if (isSolveDebugEnabled()) {
          console.info("[omnimath:save-background-settled]", {
            requestId,
            endpoint,
            status: backgroundSaved?.id ? "saved" : backgroundSaved?.warning ? "warning" : "not_saved",
            savedExplanationId: backgroundSaved?.id || null,
          });
        }
      }).catch((backgroundError) => {
        // saveExplanationBestEffort currently catches its own errors. Keep a
        // final guard here for future persistence implementations.
        console.warn("[omnimath:save-warning]", {
          operation: "saveExplanationBestEffort.background",
          code: backgroundError?.code || null,
          message: backgroundError?.message || "Background save failed",
        });
      });
      const immediateSaveWarning = requestHasExpiredBearerToken(req)
        ? createExpiredSaveWarning()
        : null;
      return {
        result,
        usage,
        saved: immediateSaveWarning,
        saveStatus: immediateSaveWarning ? "not_saved" : "pending",
        source,
      };
    }));

    const { result, usage, saved, saveStatus, source } = value;
    const responseResult = sourceMetadata ? { ...result, ...structuredClone(sourceMetadata) } : result;
    sendJson(
      res,
      200,
      buildResponse(responseResult, {
        usage,
        saved,
        saveStatus,
        source: duplicate ? `${source} (deduplicated)` : source,
        demoMode: !isOpenAiConfigured(),
        canonicalProblem,
        requestId,
      }),
      createUsageHeaders(usage)
    );
    logSolveDebug("http_response", {
      requestId,
      endpoint,
      inputSource,
      canonicalInputHash: canonicalProblem.hash,
      statusCode: 200,
      source,
      finalUiState: "success-response-sent",
      stepCount: Array.isArray(result?.steps) ? result.steps.length : 0,
    });
    } finally {
      solveBudget.cleanup();
      cancellationResponse.off?.("close", abortForClientDisconnect);
      cancellationRequest.off?.("aborted", abortForClientDisconnect);
      cancellationRequest.off?.("error", onRequestError);
      cancellationRequest.signal?.removeEventListener?.("abort", onRequestSignalAbort);
    }
  });
}

export async function handleExtractImageProblemRequest(req, res) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  await runHandler(res, async () => {
    const startedAt = Date.now();
    const identity = await requireClerkIdentity(req);
    throttleRequest(req, identity, "ai");
    assertAiEnabled();
    let body;
    try {
      body = await readBody(req, MAX_IMAGE_BYTES + MAX_JSON_BYTES);
    } catch (error) {
      logRejectedUpload({ reason: "multipart_body_too_large" });
      throw error;
    }
    const { fields, files } = parseMultipartForm(body, req.headers["content-type"]);
    const problem = requireTextProblem(fields.prompt || "Extract the math problem shown in this image.");
    const image = requireImage(files.file);
    const imageHash = createImageHash(image);
    const prompt = buildImageExtractionPrompt({ problem });
    const extractionBudget = estimateImageExtractionReservation({ prompt, image });
    const estimatedTokens = extractionBudget.estimatedTokens;
    const estimatedCostMicros = dollarsToMicros(extractionBudget.estimatedCostUsd);

    logImageUploadDebug("extract-input", {
      filename: image.filename || null,
      contentType: image.contentType,
      bytes: image.buffer.length,
      promptChars: prompt.length,
      imageHash,
    });

    const ingestionRequestId = optionalShortText(fields.ingestionRequestId || fields.debugRequestId || fields.clientRequestId || "", "Image ingestion id", 120) || crypto.randomUUID();
    const scopeId = optionalShortText(fields.ingestionScopeId || ingestionRequestId, "Image upload scope", 120);
    const uploadId = optionalShortText(fields.uploadId || ingestionRequestId, "Image upload id", 120);
    const uploadRevision = fields.uploadRevision === undefined ? 0 : Number(fields.uploadRevision);
    if (!Number.isSafeInteger(uploadRevision) || uploadRevision < 0 || uploadRevision > 1000000) throw createBadInputError("Image upload revision is invalid.");
    const promptHash = ingestionDigest({ prompt, ocrConfidence: fields.ocrConfidence || "" });
    const dedupKey = ingestionDigest({ owner: identity.key, scopeId, uploadId, uploadRevision, ingestionRequestId, imageHash, promptHash });
    const { duplicate, value } = await runDeduplicatedRequest(`ocr-extraction:${dedupKey}`, async () => {
      const claimed = await imageIngestionRegistry.begin({ owner: identity.key, scopeId, uploadId, uploadRevision, ingestionRequestId, imageHash, promptHash });
      if (claimed.kind === "completed") return claimed.record.extraction;
      const record = claimed.record;
      const configuredExtractionTimeoutMs = resolveOpenAiRequestTimeout("imageExtraction").timeoutMs;
      const logicalExtractionBudgetMs = process.env.VERCEL === "1"
        ? Math.min(configuredExtractionTimeoutMs, 60000) : configuredExtractionTimeoutMs;
      const extractionDeadlineAt = Date.now() + logicalExtractionBudgetMs;
      const extractionContext = { requestId: ingestionRequestId, ingestionRequestId,
        logicalImageIngestionRequestId: ingestionRequestId, uploadId, uploadRevision, scopeId, imageHash,
        extractionId: record.ingestion.extractionId, extractionAttemptId: `${record.ingestion.extractionId}:initial` };
      console.info("[omnimath:image-ingestion]", { event: "extraction_started", ...extractionContext, state: "extracting",
        configuredExtractionTimeoutMs, logicalExtractionBudgetMs, extractionDeadlineAt });
      let reservation = null;
      let extraction;
      let usage;
      let settlementStarted = false;
      try {
        ({ reservation } = await checkAndReserveUsage({
          req, identity, kind: "image", estimatedTokens: isOpenAiConfigured() ? estimatedTokens : 0,
          estimatedCostMicros: isOpenAiConfigured() ? estimatedCostMicros : 0,
        }));
        if (!isOpenAiConfigured()) throw createOpenAiRequiredError();
        extraction = await createImageProblemExtraction({ prompt, image, debugContext: extractionContext, deadlineAt: extractionDeadlineAt });
        const rawExtractedText = extraction.extractedProblemText;
        traceMathStage("OCR output", "", extraction.extractedProblemLatex, "model image extraction", {
          extractedProblemText: rawExtractedText,
        });
        const textCleanup = normalizeExtractedProblemText(rawExtractedText);
        traceMathStage("OCR normalization", rawExtractedText, textCleanup.text || rawExtractedText, "plain OCR text spacing cleanup");
        extraction.rawExtractedText = rawExtractedText;
        extraction.extractedProblemText = textCleanup.text || rawExtractedText;
        try { requireTextProblem(extraction.extractedProblemText); } catch (error) {
          throw Object.assign(error, { code: "OCR_INPUT_INVALID", statusCode: 422,
            publicMessage: "The extracted problem is empty or exceeds the supported 4000-character input bound. Crop to one problem or edit it as typed input.",
            ingestionStage: "input_validation" });
        }

        extraction.ocrTextCleanup = textCleanup;
        const display = buildExtractedProblemDisplay({
          rawOcrText: rawExtractedText,
          cleanedPlainText: extraction.extractedProblemText,
          extractedProblemLatex: extraction.extractedProblemLatex,
        });
        extraction.rawOcrText = display.rawOcrText;
        extraction.cleanedPlainText = display.cleanedPlainText;
        extraction.displaySegments = display.displaySegments;
        extraction.solverInput = display.solverInput;
        extraction.latexMathChunks = display.latexMathChunks;
        extraction.extractionValidation = validateExtraction({
          extractedProblemText: extraction.extractedProblemText,
          extractedProblemLatex: extraction.extractedProblemLatex,
          ocrConfidence: fields.ocrConfidence,
          modelConfidence: extraction.confidence,
          modelIssues: extraction.issues,
          textCleanup,
        });
        traceMathStage("Extraction validation", extraction.extractedProblemLatex, extraction.extractedProblemLatex, "structural integrity scoring", {
          validation: extraction.extractionValidation,
        });
        if (display.latexMathChunks.some((chunk) => chunk.renderIssue)) {
          extraction.extractionValidation.issues.push({
            type: "render_preview_issue",
            severity: "low",
            critical: false,
            message: "Math preview could not render, but the extracted text can still be solved.",
          });
          extraction.extractionValidation.status = extraction.extractionValidation.status === "danger" ? "danger" : "warning";
        }
        logExtractionReviewDebug(extraction.extractionValidation, {
          requestId: fields.debugRequestId || fields.clientRequestId || null,
          imageHash,
        });
        extraction.confidence = extraction.extractionValidation.confidence;
        extraction.ocrConfidence = extraction.extractionValidation.ocrConfidence;
        extraction.mathIntegrityScore = extraction.extractionValidation.mathIntegrityScore;
        extraction.confidenceTier = extraction.extractionValidation.tier;
        extraction.issues = extraction.extractionValidation.issues;
        extraction.ocrSolveDecision = assessOcrSolveDecision({
          solveDecision: "direct",
          extractionValidation: extraction.extractionValidation,
        });
        extraction.imageSource = {
          imageHash,
          filename: image.filename || null,
          contentType: image.contentType,
          bytes: image.buffer.length,
          rawExtractedText,
          cleanedExtractedText: extraction.extractedProblemText,
          displaySegments: extraction.displaySegments,
          solverInput: extraction.solverInput,
          latexMathChunks: extraction.latexMathChunks,
          rawExtractedLatex: extraction.extractedProblemLatex,
          confidence: extraction.confidence,
          ocrConfidence: extraction.ocrConfidence,
          mathIntegrityScore: extraction.mathIntegrityScore,
          confidenceTier: extraction.confidenceTier,
          issues: extraction.issues,
        };

        // Once settlement starts, a storage failure must not trigger a second
        // release/settlement that would compound partially applied counter deltas.
        settlementStarted = true;
        usage = await settleAiUsageReservation(reservation, extraction._aiUsage, {
          providerCalls: extraction._aiCallCount || 1, settlementReason: "success",
        });
        const result = await imageIngestionRegistry.extracted({ owner: identity.key, record, extraction: {
          ...extraction, usage, requestId: ingestionRequestId,
          runtime: { source: "live AI extraction", demoMode: false },
        } });
        console.info("[omnimath:image-ingestion]", { event: "extraction_completed", ...extractionContext,
          state: result.ingestion.state, selectedExtractionId: result.ingestion.extractionId, reviewRequired: !result.ocrSolveDecision.allowed,
          schemaParseClassification: "valid_extraction", selectedOutputContract: extraction._omniOpenAiDiagnostics?.selectedExtractionContract || "full",
          providerCallCount: extraction._aiCallCount || 1 });
        logSolveTiming({ endpoint: "/api/extract-image-problem", startedAt, source: "live AI extraction", identity, prompt,
          aiUsage: extraction._aiUsage, apiCallCount: extraction._aiCallCount || 1 });
        return result;
      } catch (error) {
        error.ingestionStage ||= "extraction";
        if (error.responseFailureType === "json_parse") error.publicMessage = "The image reader returned invalid JSON. Extraction did not complete. Try reading the image again.";
        if (error.responseFailureType === "schema_contract") error.publicMessage = "The image reader returned an invalid extraction structure. Extraction did not complete. Try reading the image again.";
        if (settlementStarted && !usage) error.accountingStatus = "unsettled";
        error.omniDebugContext = { ...error.omniDebugContext, requestId: ingestionRequestId, endpoint: "/api/extract-image-problem" };
        if (!settlementStarted) {
          settlementStarted = true;
          try { const settled = await settleFailureUsageOrRelease(reservation, error, extraction); if (settled) error.usage = settled; }
          catch (settlementError) {
            console.error("[omnimath:image-ingestion]", { event: "accounting_failed", ...extractionContext, code: settlementError.code || null });
            error.accountingStatus = "unsettled";
          }
        }
        try { await imageIngestionRegistry.failed({ owner: identity.key, record, error }); }
        catch (lifecycleError) { console.error("[omnimath:image-ingestion]", { event: "failure_state_unavailable", ...extractionContext, code: lifecycleError.code }); }
        console.info("[omnimath:image-ingestion]", { event: "extraction_failed", ...extractionContext, code: error.code,
          retrySuppressedReason: error.retrySuppressedReason || null,
          classification: error.responseFailureType || error.ingestionStage, providerCallCount: aiCallCountFrom(error) || aiCallCountFrom(extraction) });
        throw error;
      }
    });
    console.info("[omnimath:image-ingestion]", { event: "extraction_response", ...value.ingestion, duplicate });
    sendJson(res, 200, value, createUsageHeaders(value.usage));
  });
}

export async function handleSolveExtractedProblemRequest(req, res) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  await runHandler(res, async () => {
    const body = requireObject(await readJson(req));
    const identity = await requireRequestIdentity(req, "solve-extracted-problem");
    const submittedExtraction = requireObject(body.extraction || {}, "Extraction");
    const receipt = body.extractionReceipt || submittedExtraction.extractionReceipt;
    const ingestion = submittedExtraction.ingestion;
    const record = await imageIngestionRegistry.get({ owner: identity.key, receipt, ingestion });
    // All extraction findings and image provenance come from the selected
    // server record. Client-authored confidence/validation cannot bypass review.
    const extraction = record.extraction;
    const solveDecision = ["direct", "confirmed", "edited"].includes(body.solveDecision) ? body.solveDecision : "direct";
    const reviewAction = body.reviewAction && typeof body.reviewAction === "object" ? body.reviewAction : null;
    const requestId = optionalShortText(body.debugRequestId || body.clientRequestId || "", "Debug request id", 120) || createDebugRequestId("solve-extracted");
    const reviewRevision = body.reviewRevision ?? submittedExtraction.reviewRevision;
    const reviewRevisionId = optionalShortText(body.reviewRevisionId || submittedExtraction.reviewRevisionId || "", "Review revision id", 120);
    const extractionValidation = extraction.extractionValidation;
    const trustedOcrSource = solveDecision === "direct" ? "ocr-direct" : "ocr-reviewed";
    const canonicalProblem = normalizeCanonicalProblem({
      ...body,
      canonicalProblem: {
        canonicalText: body.canonicalProblem?.canonicalText || body.problem || body.problemText || "",
        canonicalLatex: body.canonicalProblem?.canonicalLatex ?? "",
        source: trustedOcrSource,
        extractionWarnings: extraction.issues || extractionValidation.issues || [],
        extractionConfidence: extraction.confidence ?? extractionValidation.confidence,
      },
    }, { forceSource: trustedOcrSource });
    const canonicalText = getCanonicalSolverInput(canonicalProblem);
    for (const value of [body.problem, body.problemText, body.problemInput?.problemText]) {
      if (value !== undefined && getCanonicalSolverInput({ canonicalText: value }) !== canonicalText) {
        throw Object.assign(createBadInputError("The reviewed text and canonical solve input disagree."), { code: "OCR_CANONICAL_INPUT_MISMATCH", ingestionStage: "canonicalization" });
      }
    }
    if (solveDecision !== "edited" && canonicalText !== extraction.extractedProblemText) {
      throw Object.assign(createBadInputError("Changed OCR text must be submitted as an edited review."), { code: "OCR_REVIEW_TEXT_CHANGED", ingestionStage: "review" });
    }
    if (solveDecision === "edited" && canonicalText !== extraction.extractedProblemText && canonicalProblem.canonicalLatex
      && canonicalProblem.canonicalLatex !== canonicalText) {
      throw Object.assign(createBadInputError("The edited input still contains a preview from the previous extraction."), { code: "OCR_CANONICAL_INPUT_MISMATCH", ingestionStage: "canonicalization" });
    }
    let ocrDecision;
    try {
      ocrDecision = assertOcrSolveAllowed({
        solveDecision,
        extractionValidation,
        reviewAction,
        canonicalInputHash: canonicalProblem.hash,
        extractionId: record.ingestion.extractionId, reviewRevision, reviewRevisionId,
      });
    } catch (error) {
      error.omniDebugContext = { requestId, endpoint: "/api/solve-extracted-problem" };
      logImageUploadDebug("solve-review-required", {
        requestId,
        imageHash: extraction.imageSource?.imageHash || extraction.imageHash || null,
        decision: error.ocrSolveDecision,
      });
      throw error;
    }
    const acceptedReviewAction = ocrDecision.reviewActionValid ? reviewAction : null;
    const problem = requireTextProblem(getCanonicalSolverInput(canonicalProblem));
    const imageSource = {
      ...(extraction.imageSource || {}),
      imageHash: extraction.imageSource?.imageHash || extraction.imageHash || null,
      filename: extraction.imageSource?.filename || null,
      contentType: extraction.imageSource?.contentType || null,
      bytes: extraction.imageSource?.bytes || null,
      rawExtractedText: extraction.rawExtractedText || extraction.extractedProblemText || extraction.imageSource?.rawExtractedText || "",
      cleanedExtractedText: extraction.extractedProblemText || extraction.imageSource?.cleanedExtractedText || "",
      rawExtractedLatex: extraction.rawExtractedLatex || extraction.extractedProblemLatex || extraction.imageSource?.rawExtractedLatex || "",
      rawText: extraction.rawText || extraction.imageSource?.rawText || extraction.rawExtractedText || "",
      displayText: extraction.displayText || extraction.imageSource?.displayText || problem,
      normalizedText: extraction.normalizedText || extraction.imageSource?.normalizedText || problem,
      validationText: extraction.validationText || extraction.imageSource?.validationText || extraction.normalizedText || problem,
      finalProblemText: problem,
      finalProblemLatex: canonicalProblem.canonicalLatex || problem,
      confidence: Number(extractionValidation.confidence ?? 0),
      ocrConfidence: Number(extractionValidation.ocrConfidence ?? 0),
      mathIntegrityScore: Number(extractionValidation.mathIntegrityScore ?? extractionValidation.confidence ?? 0),
      confidenceTier: extractionValidation.tier || "",
      issues: extractionValidation.issues || [],
      solveDecision,
      reviewAction: acceptedReviewAction,
      editedBeforeSolving: solveDecision === "edited",
      canonicalProblem,
      canonicalInputHash: canonicalProblem.hash,
      ingestion: { ...record.ingestion, reviewRevision, reviewRevisionId, state: "solving" },
      canonicalProblemId: ingestionDigest({ text: canonicalProblem.canonicalText, latex: canonicalProblem.canonicalLatex }),
      canonicalSolveRequestId: requestId,
    };

    logImageUploadDebug("solve-extracted-canonicalized", {
      requestId,
      imageHash: imageSource.imageHash,
      reviewEvidencePath: extraction.extractionValidation ? "extraction.extractionValidation" : "legacy-extraction-summary",
      ocrSolveDecision: ocrDecision,
      inputSource: canonicalProblem.source,
      canonicalInputHash: canonicalProblem.hash,
      solveDecision,
      reviewActionKind: acceptedReviewAction?.kind || null,
    });

    const sharedRequest = copyInternalRequest(req, {
      url: "/api/explain",
      body: {
        problemInput: {
          problemText: problem,
          source: "ocr",
        },
        problem,
        canonicalProblem,
        history: body.history || [],
        debugRequestId: requestId,
        clientRequestId: body.clientRequestId,
        progressiveMode: body.progressiveMode,
        progressiveIdentity: body.progressiveIdentity,
        reference: body.reference || [
          "ocr",
          imageSource.imageHash || "no-image-hash",
          solveDecision,
        ].join(":"),
        depth: body.depth || "intermediate",
      },
    });
    canonicalSolveRequestContexts.set(sharedRequest, {
      endpoint: "/api/solve-extracted-problem",
      identityOperation: "solve-extracted-problem",
      inputSource: canonicalProblem.source,
      usageKind: "image",
      persistenceSource: "image",
      originalRequest: req,
      originalResponse: res,
      sourceMetadata: {
        ingestion: imageSource.ingestion,
        canonicalProblemId: imageSource.canonicalProblemId,
        canonicalSolveRequestId: requestId,
        imageSource,
        extractedProblemText: imageSource.finalProblemText || imageSource.cleanedExtractedText || imageSource.rawExtractedText,
        extractedProblemLatex: imageSource.rawExtractedLatex,
        extractionValidation,
        reviewAction: acceptedReviewAction,
        ocrSolveDecision: ocrDecision,
        confidence: extractionValidation.confidence,
        ocrConfidence: extractionValidation.ocrConfidence,
        mathIntegrityScore: extractionValidation.mathIntegrityScore,
        confidenceTier: extractionValidation.tier,
      },
    });

    const solveSignature = ingestionDigest({ canonicalProblemId: imageSource.canonicalProblemId,
      history: parseHistory(body.history), depth: body.depth || "intermediate", reference: body.reference || "", progressive: body.progressiveMode || "" });
    const executeSolve = async () => {
      const claim = await imageIngestionRegistry.review({ owner: identity.key, receipt, ingestion, revision: reviewRevision,
        revisionId: reviewRevisionId, canonicalProblem, solveSignature, requestId });
      if (claim.kind === "completed") {
        if (claim.response?.progressive) throw Object.assign(new Error("This streamed solve already completed. Submit a new reviewed revision to solve again."), { code: "OCR_SOLVE_ALREADY_COMPLETED", statusCode: 409 });
        return claim.response;
      }
      console.info("[omnimath:image-ingestion]", { event: "canonical_solve_started", ...imageSource.ingestion,
        selectedExtractionId: record.ingestion.extractionId, reviewRevisionId, canonicalProblemId: imageSource.canonicalProblemId,
        canonicalSolveRequestId: requestId, canonicalInputHash: canonicalProblem.hash });
      const progressive = body.progressiveMode === "provider-stream";
      const captured = { statusCode: 200, headers: {}, body: "", progressive: false };
      let terminalEvent = null;
      const response = progressive ? {
        writeHead(status, headers) { captured.statusCode = status; captured.headers = headers; captured.progressive = String(headers?.["Content-Type"] || headers?.["content-type"] || "").includes("text/event-stream"); if (captured.progressive) res.writeHead(status, headers); },
        write(chunk) {
          const text = String(chunk);
          const matches = [...text.matchAll(/^data: (.+)$/gm)];
          for (const match of matches) { try { const event = JSON.parse(match[1]); if (event.type === "solve_completed" || event.type === "solve_failed") terminalEvent = event; } catch { /* framing belongs to canonical stream contract */ } }
          if (captured.progressive) return res.write(chunk);
          captured.body += text;
          return true;
        },
        end(chunk = "") { if (captured.progressive) { if (chunk) this.write(chunk); } else captured.body += String(chunk); },
        on: (...args) => res.on?.(...args), once: (...args) => res.once?.(...args), off: (...args) => res.off?.(...args),
        flushHeaders: () => res.flushHeaders?.(),
        get headersSent() { return captured.progressive && res.headersSent; },
        get writableEnded() { return res.writableEnded; },
        get destroyed() { return res.destroyed; },
      } : {
        writeHead(status, headers) { captured.statusCode = status; captured.headers = headers; },
        end(chunk = "") { captured.body += String(chunk); },
      };
      await handleExplainRequest(sharedRequest, response);
      if (captured.progressive) {
        captured.statusCode = terminalEvent?.type === "solve_completed" ? 200 : 502;
        captured.body = JSON.stringify({ code: terminalEvent?.code || "OCR_STREAM_TERMINAL", ingestionStage: "canonical_solve" });
      } else {
        const parsed = JSON.parse(captured.body || "{}");
        parsed.ingestionStage = captured.statusCode === 200 ? "solved" : "canonical_solve";
        if (captured.statusCode !== 200) parsed.extractionSucceeded = true;
        parsed.ingestion = { ...imageSource.ingestion, state: captured.statusCode === 200 ? "solved" : "solve_failed" };
        if (parsed.imageSource) parsed.imageSource = { ...parsed.imageSource, ingestion: parsed.ingestion };
        captured.body = JSON.stringify(parsed);
      }
      await imageIngestionRegistry.finish({ owner: identity.key, receipt, ingestion, revision: reviewRevision,
        revisionId: reviewRevisionId, requestId, response: captured });
      console.info("[omnimath:image-ingestion]", { event: "canonical_solve_completed", ...imageSource.ingestion,
        state: captured.statusCode === 200 ? "solved" : "solve_failed", selectedExtractionId: record.ingestion.extractionId,
        reviewRevisionId, canonicalProblemId: imageSource.canonicalProblemId, canonicalSolveRequestId: requestId, responseStatus: captured.statusCode });
      return captured;
    };
    if (body.progressiveMode === "provider-stream") {
      try {
        const response = await executeSolve();
        if (response.progressive) res.end();
        else { res.writeHead(response.statusCode, response.headers); res.end(response.body); }
      } catch (error) {
        if (res.headersSent) { res.end(); return; }
        throw error;
      }
    } else {
      const solveKey = ingestionDigest({ owner: identity.key, receipt, reviewRevision, reviewRevisionId, solveSignature });
      const { value: response, duplicate } = await runDeduplicatedRequest(`ocr-solve:${solveKey}`, executeSolve);
      // Joining/replaying a semantic operation preserves the submitter's HTTP
      // correlation id; it never substitutes another upload's provenance.
      const parsed = JSON.parse(response.body || "{}");
      parsed.requestId = requestId;
      parsed.canonicalSolveRequestId = requestId;
      if (parsed.imageSource) parsed.imageSource.canonicalSolveRequestId = requestId;
      console.info("[omnimath:image-ingestion]", { event: "canonical_solve_response", ...imageSource.ingestion,
        reviewRevisionId, canonicalProblemId: imageSource.canonicalProblemId, canonicalSolveRequestId: requestId, duplicate });
      res.writeHead(response.statusCode, response.headers);
      res.end(JSON.stringify(parsed));
    }
  });
}

export async function handleExplainImageRequest(req, res) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  await runHandler(res, async () => {
    // Compatibility endpoint: preserve the multipart contract while enforcing
    // the same OCR -> canonical ProblemInput -> shared solve boundary as the UI.
    const requestBody = await readBody(req, MAX_IMAGE_BYTES + MAX_JSON_BYTES);
    const extractionRequest = copyInternalRequest(req, {
      url: "/api/extract-image-problem",
      body: requestBody,
    });
    const extractionResponse = {
      statusCode: 200,
      headers: {},
      body: "",
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(chunk = "") {
        this.body += chunk;
      },
    };
    await handleExtractImageProblemRequest(extractionRequest, extractionResponse);
    if (extractionResponse.statusCode !== 200) {
      res.writeHead(extractionResponse.statusCode, extractionResponse.headers);
      res.end(extractionResponse.body);
      return;
    }

    const extraction = requireObject(JSON.parse(extractionResponse.body || "{}"), "Extraction");
    const canonicalProblem = normalizeCanonicalProblem({
      problem: extraction.extractedProblemText || extraction.rawExtractedText || "",
      problemLatex: extraction.extractedProblemLatex || "",
    }, {
      source: "ocr-direct",
      extractionWarnings: extraction.issues || extraction.extractionValidation?.issues || [],
      extractionConfidence: extraction.confidence ?? extraction.extractionValidation?.confidence,
    });
    const { fields } = parseMultipartForm(requestBody, req.headers["content-type"]);
    const solveRequest = copyInternalRequest(req, {
      url: "/api/solve-extracted-problem",
      headers: { ...req.headers, "content-type": "application/json" },
      body: {
        problemInput: {
          problemText: getCanonicalSolverInput(canonicalProblem),
          source: "ocr",
          sourceMetadata: { extraction, solveDecision: "direct" },
        },
        problem: getCanonicalSolverInput(canonicalProblem),
        problemText: canonicalProblem.canonicalText,
        canonicalProblem,
        extraction,
        solveDecision: "direct",
        extractionReceipt: extraction.extractionReceipt,
        reviewRevision: 0,
        reviewRevisionId: `${extraction.ingestion.extractionId}:review:0`,
        debugRequestId: fields.debugRequestId || fields.clientRequestId || "",
      },
    });
    await handleSolveExtractedProblemRequest(solveRequest, res);
  });
}
async function handleLazyExplanationRequest(req, res, mode) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  await runHandler(res, async () => {
    const identity = await requireClerkIdentity(req);
    throttleRequest(req, identity, "ai");
    assertAiEnabled();
    const body = requireObject(await readJson(req));
    const requestId = optionalShortText(body.debugRequestId || body.clientRequestId || "", "Debug request id", 120)
      || createDebugRequestId(mode === "pin" ? "pin" : "hover");
    const problemContext = optionalShortText(
      body.problemContext || body.problemId || body.problemLatex || body.problem,
      "Problem context",
      MAX_PROBLEM_CONTEXT_CHARS
    );
    const stepLatex = requireShortText(body.stepLatex, "Step LaTeX", MAX_STEP_LATEX_CHARS);
    const selectedLatex = requireShortText(
      body.selectedLatex || body.selectedText,
      "Selected LaTeX",
      MAX_SELECTED_LATEX_CHARS
    );
    const parentExpression = optionalShortText(
      body.parentExpression,
      "Parent expression",
      MAX_STEP_LATEX_CHARS
    );
    const semanticId = optionalShortText(
      body.semanticId || body.targetId || body.selectedTokenId || body.anchorId,
      "Semantic target id",
      500
    );
    const targetLabel = optionalShortText(
      body.targetLabel || body.semanticSourceText || selectedLatex,
      "Semantic target label",
      MAX_SELECTED_LATEX_CHARS
    );
    const stepHeading = typeof body.stepHeading === "string" ? body.stepHeading.slice(0, 300) : "";
    const cacheKey = buildLazyCacheKey(identity, {
      ...body,
      problemContext,
      stepLatex,
      selectedLatex,
      parentExpression,
      stepHeading,
    }, mode);
    logHoverDebug("request_received", {
      requestId,
      endpoint: mode === "pin" ? "/api/explain-pin" : "/api/explain-token",
      mode,
      semanticNodeId: semanticId,
      cacheKey,
      selectedText: selectedLatex,
      sourceRange: body.targetSourceRange || body.semanticSourceRange || body.selectedNode?.sourceRange || null,
      selectedNode: body.selectedNode || null,
      targetLabel,
    });
    const cached = getCachedExplanation(cacheKey);
    if (cached) {
      const usage = await getUsageForKind(req, "explanation", identity);
      logHoverDebug("cache_hit", {
        requestId,
        mode,
        semanticNodeId: semanticId,
        cacheKey,
        responseSemanticId: cached.semanticId || semanticId,
      });
      sendJson(res, 200, {
        ...cached,
        semanticId: cached.semanticId || semanticId,
        targetId: cached.targetId || semanticId,
        targetLabel: cached.targetLabel || targetLabel,
        usage,
        cached: true,
      }, createUsageHeaders(usage));
      return;
    }

    const { duplicate, value } = await runDeduplicatedRequest(cacheKey, async () => {
      const prompt = buildTokenExplanationPrompt({
        problemContext,
        stepLatex,
        selectedLatex,
        parentExpression,
        stepHeading,
        mode,
      });
      const estimatedTokens = estimateOpenAiTokenBudget({ prompt, maxOutputTokens: getLazyMaxOutputTokens() });
      const estimatedCostMicros = dollarsToMicros(estimateOpenAiCostBudget({ prompt, maxOutputTokens: getLazyMaxOutputTokens() }));
      const { reservation } = await checkAndReserveUsage({
        req,
        identity,
        kind: "explanation",
        estimatedTokens: isOpenAiConfigured() ? estimatedTokens : 0,
        estimatedCostMicros: isOpenAiConfigured() ? estimatedCostMicros : 0,
      });
      let result;
      let usage;

      try {
        if (!isOpenAiConfigured()) {
          result = {
            title: mode === "pin" ? "Pinned explanation" : "Token explanation",
            explanation: mode === "pin"
              ? `${selectedLatex} matters in this step because it is part of ${stepHeading || "the displayed transformation"}. Configure OPENAI_API_KEY for deeper live explanations.`
              : `${selectedLatex} is the selected part of this step. Configure OPENAI_API_KEY for live hover explanations.`,
            usage: null,
          };
        } else {
          result = await createLazyTokenExplanation({
            prompt,
            mode,
            debugContext: {
              requestId,
              endpoint: mode === "pin" ? "/api/explain-pin" : "/api/explain-token",
              semanticId,
              cacheKey,
              promptHash: hashDebugText(prompt),
            },
          });
        }
        logHoverDebug("request_finish", {
          requestId,
          mode,
          semanticNodeId: semanticId,
          cacheKey,
          promptHash: hashDebugText(prompt),
          responseTitle: result.title || "",
          responseChars: String(result.explanation || "").length,
        });
        const normalizedUsage = normalizeOpenAiUsage(result.usage, isOpenAiConfigured() ? estimateTokens(prompt) : 0);
        usage = await settleTokenUsage(
          reservation,
          normalizedUsage.totalTokens,
          dollarsToMicros(estimateOpenAiCost(result.usage))
        );
      } catch (error) {
        try {
          await releaseTokenReservation(reservation);
        } catch (releaseError) {
          console.warn("Could not release token reservation:", releaseError.message);
        }
        throw error;
      }

      const payload = {
        title: result.title,
        explanation: result.explanation,
        semanticId,
        targetId: semanticId,
        targetLabel,
        responseTextLength: String(result.explanation || "").length,
      };
      setCachedExplanation(cacheKey, payload);
      logHoverDebug("cache_write", {
        requestId,
        mode,
        semanticNodeId: semanticId,
        cacheKey,
        targetId: payload.targetId,
      });
      logExplanationSource({
        source: isOpenAiConfigured() ? "live AI call" : "local fallback",
        kind: mode,
        endpoint: mode === "pin" ? "/api/explain-pin" : "/api/explain-token",
        identity,
        requestId,
        prompt,
        aiUsage: result.usage,
        execution: result?._omniOpenAiDiagnostics || null,
      });
      return { payload, usage };
    });

    const responseUsage = duplicate ? await getUsageForKind(req, "explanation", identity) : value.usage;
    logHoverDebug("http_response", {
      requestId,
      endpoint: mode === "pin" ? "/api/explain-pin" : "/api/explain-token",
      statusCode: 200,
      mode,
      semanticNodeId: semanticId,
      cacheKey,
      duplicate,
      responseSemanticId: value.payload.semanticId || semanticId,
    });
    sendJson(res, 200, {
      ...value.payload,
      semanticId: value.payload.semanticId || semanticId,
      targetId: value.payload.targetId || semanticId,
      targetLabel: value.payload.targetLabel || targetLabel,
      usage: responseUsage,
      cached: duplicate,
    }, createUsageHeaders(responseUsage));
  });
}

export async function handleExplainTokenRequest(req, res) {
  return handleLazyExplanationRequest(req, res, "hover");
}

export async function handleExplainPinRequest(req, res) {
  return handleLazyExplanationRequest(req, res, "pin");
}

export async function handleCompareMethodsRequest(req, res) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  await runHandler(res, async () => {
    const identity = await requireClerkIdentity(req);
    throttleRequest(req, identity, "ai");
    assertAiEnabled();
    const body = requireObject(await readJson(req));
    const requestId = optionalShortText(body.debugRequestId || body.clientRequestId || "", "Debug request id", 120)
      || createDebugRequestId("compare");
    const canonicalProblem = normalizeCanonicalProblem(body, {
      canonicalText: body.problemLatex || body.problem || "",
      canonicalLatex: body.problemLatex || "",
      source: body.canonicalProblem?.source || "typed",
    });
    const problemLatex = requireShortText(
      getCanonicalSolverInput(canonicalProblem),
      "Problem LaTeX",
      MAX_PROBLEM_CHARS
    );
    logCanonicalProblem("compare request", canonicalProblem, { endpoint: "/api/compare-methods" });
    const finalAnswerLatex = typeof body.finalAnswerLatex === "string" ? body.finalAnswerLatex.slice(0, 1200) : "";
    const steps = Array.isArray(body.steps) ? body.steps.slice(0, 12) : [];
    const cacheKey = buildLazyCacheKey(identity, {
      problemLatex,
      stepLatex: finalAnswerLatex,
      selectedLatex: "compare-methods",
      stepHeading: "compare-methods",
    }, "compare");
    const cached = getCachedExplanation(cacheKey);
    if (cached) {
      const usage = await getUsageForKind(req, "explanation", identity);
      sendJson(res, 200, { ...cached, usage, cached: true, canonicalProblem, canonicalInputHash: canonicalProblem.hash }, createUsageHeaders(usage));
      return;
    }

    const prompt = buildCompareMethodsPrompt({ problemLatex, finalAnswerLatex, steps });
    const estimatedTokens = estimateOpenAiTokenBudget({ prompt, maxOutputTokens: getSolveMaxOutputTokens() });
    const estimatedCostMicros = dollarsToMicros(estimateOpenAiCostBudget({ prompt, maxOutputTokens: getSolveMaxOutputTokens() }));
    const { reservation } = await checkAndReserveUsage({
      req,
      identity,
      kind: "explanation",
      estimatedTokens: isOpenAiConfigured() ? estimatedTokens : 0,
      estimatedCostMicros: isOpenAiConfigured() ? estimatedCostMicros : 0,
    });
    let result;
    let usage;

    try {
      if (!isOpenAiConfigured()) {
        result = {
          methods: [{
            title: "Alternative method",
            summary: "Live Compare Methods needs OPENAI_API_KEY to be configured.",
            points: ["Configure the backend API key to generate alternative solution paths on demand."],
          }],
          usage: null,
        };
      } else {
        result = await createCompareMethods({
          prompt,
          debugContext: { requestId, recoveryPurpose: "compare_methods" },
        });
      }
      const normalizedUsage = normalizeOpenAiUsage(result.usage, isOpenAiConfigured() ? estimateTokens(prompt) : 0);
      usage = await settleTokenUsage(
        reservation,
        normalizedUsage.totalTokens,
        dollarsToMicros(estimateOpenAiCost(result.usage))
      );
    } catch (error) {
      try {
        await releaseTokenReservation(reservation);
      } catch (releaseError) {
        console.warn("Could not release token reservation:", releaseError.message);
      }
      throw error;
    }

    const payload = {
      methods: result.methods,
      canonicalProblem,
      canonicalInputHash: canonicalProblem.hash,
    };
    setCachedExplanation(cacheKey, payload);
    logExplanationSource({
      source: isOpenAiConfigured() ? "live AI call" : "local fallback",
      kind: "compare",
      endpoint: "/api/compare-methods",
      identity,
      requestId,
      prompt,
      aiUsage: result.usage,
      execution: result?._omniOpenAiDiagnostics || null,
    });
    sendJson(res, 200, { ...payload, usage, cached: false }, createUsageHeaders(usage));
  });
}

function followupStreamRequested(req, body = {}) {
  return body.stream === true || String(req.headers?.accept || "").includes("text/event-stream");
}

function requireFollowupStreamCorrelation(correlation = {}) {
  if (!correlation.requestId || !correlation.conversationId
    || correlation.targetRevision === null || correlation.targetRevision === undefined
    || correlation.targetRevision === "") {
    throw createBadInputError(
      "Streaming follow-up requires requestId, conversationId, and targetRevision."
    );
  }
  return correlation;
}

function followupStreamKey(identity, correlation) {
  return JSON.stringify([
    identity?.key || identity?.subject || "anonymous",
    correlation.requestId,
    correlation.conversationId,
    correlation.targetRevision,
  ]);
}

function followupStreamConflict() {
  return Object.assign(new Error("This follow-up request is already streaming."), {
    statusCode: 409,
    code: "FOLLOWUP_STREAM_IN_PROGRESS",
    publicMessage: "This follow-up is already being generated.",
  });
}

async function handleStreamingFollowup({
  req, res, body, correlation, identity, identityResult, history, prompt, snapshot,
  scope, presentationDepth, reservation, reservedUsage, fallbackReason, deadlineAt, startedAt,
}) {
  const abortController = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) {
      abortController.abort(new DOMException("Follow-up client disconnected.", "AbortError"));
    }
  };
  const onRequestAborted = () => {
    abortController.abort(new DOMException("Follow-up request aborted.", "AbortError"));
  };
  const onRequestError = (error) => {
    if (error?.code === "ECONNRESET" || error?.message === "aborted") onRequestAborted();
  };
  res.on?.("close", onClose);
  req.on?.("aborted", onRequestAborted);
  req.on?.("error", onRequestError);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let sequence = 0;
  let terminal = false;
  let publishedDelta = false;
  let answer = "";
  let providerResult = null;
  let usage = reservedUsage;
  let settlementAttempted = false;
  const emit = (type, fields = {}) => {
    if (terminal || res.destroyed || res.writableEnded) return false;
    const event = {
      type,
      requestId: correlation.requestId,
      conversationId: correlation.conversationId,
      targetRevision: correlation.targetRevision,
      sequence: sequence++,
      ...fields,
    };
    res.write(`event: followup\ndata: ${JSON.stringify(event)}\n\n`);
    if (type === "complete" || type === "error") terminal = true;
    return true;
  };
  const emitFallback = async (reason) => {
    const fallbackAnswer = createGeneralFollowupFallback(body, history, reason);
    answer = fallbackAnswer;
    publishedDelta = Boolean(fallbackAnswer);
    if (fallbackAnswer) emit("delta", { status: "streaming", delta: fallbackAnswer, fallback: true });
    const normalizedUsage = normalizeOpenAiUsage(null, estimateTokens(prompt));
    settlementAttempted = true;
    try {
      usage = await settleTokenUsage(
        reservation,
        normalizedUsage.totalTokens,
        0,
        { providerCalls: 0, settlementReason: "local-fallback" },
      );
    } catch (error) {
      if (!isProductionRuntime() && isLocalPersistenceError(error)) {
        console.warn("[omnimath:followup-usage-warning]", {
          requestId: correlation.requestId,
          code: error.code || null,
        });
        usage = reservedUsage;
      } else {
        emit("error", {
          status: "partial_error",
          code: error.code || "USAGE_STORE_UNAVAILABLE",
          message: error.publicMessage || "Usage accounting could not complete this follow-up.",
          partial: publishedDelta,
          usage,
          scope,
        });
        return;
      }
    }
    emit("complete", {
      status: "complete",
      answer: fallbackAnswer,
      usage,
      fallback: true,
      fallbackReason: fallbackReason || identityResult.fallbackReason || reason,
      scope,
    });
  };

  emit("generating", { status: "generating", scope, presentationDepth });
  try {
    if (!isOpenAiConfigured()) {
      await emitFallback("OPENAI_API_KEY is not configured on the server.");
    } else {
      try {
        providerResult = await streamFollowupAnswer({
          prompt,
          scope,
          deadlineAt,
          signal: abortController.signal,
          debugContext: {
            requestId: correlation.requestId,
            recoveryPurpose: "followup_stream",
          },
          onTextDelta(delta) {
            if (abortController.signal.aborted) throw abortController.signal.reason;
            answer += delta;
            if (!emit("delta", { status: "streaming", delta, fallback: false })) {
              throw abortController.signal.reason || new DOMException("Follow-up stream closed.", "AbortError");
            }
            publishedDelta = true;
          },
        });
        answer = String(providerResult.text || answer).trim();
        const normalizedUsage = normalizeOpenAiUsage(providerResult.usage, estimateTokens(prompt));
        settlementAttempted = true;
        usage = await settleTokenUsage(
          reservation,
          normalizedUsage.totalTokens,
          dollarsToMicros(estimateOpenAiCost(providerResult.usage)),
          {
            actualInputTokens: normalizedUsage.inputTokens,
            actualOutputTokens: normalizedUsage.outputTokens,
            actualReasoningTokens: normalizedUsage.reasoningTokens,
            providerCalls: providerResult.providerCallCount || 1,
            settlementReason: "success",
          },
        );
        logExplanationSource({
          source: "live AI call",
          kind: "text",
          endpoint: "/api/explain-followup",
          identity,
          requestId: correlation.requestId,
          prompt,
          aiUsage: providerResult.usage,
          execution: providerResult._omniOpenAiDiagnostics || providerResult,
        });
        emit("complete", {
          status: "complete",
          answer,
          usage,
          fallback: false,
          scope,
        });
      } catch (error) {
        logHoverDebug("followup_error", {
          ...correlation,
          semanticId: snapshot.target.semanticId || snapshot.target.targetId || null,
          code: error.code || null,
          statusCode: error.statusCode || null,
          partial: publishedDelta,
          elapsedMs: Date.now() - startedAt,
        });
        if (!publishedDelta && !abortController.signal.aborted && !isProductionRuntime()) {
          console.warn("[omnimath:followup-fallback]", {
            reason: "OpenAI streaming request failed before output",
            code: error.code,
            message: error.message,
            statusCode: error.statusCode || null,
          });
          if (!settlementAttempted) {
            settlementAttempted = true;
            try {
              usage = await settleFailureUsageOrRelease(reservation, error, providerResult);
            } catch (settlementError) {
              console.warn("[omnimath:followup-usage-warning]", {
                requestId: correlation.requestId,
                code: settlementError?.code || null,
              });
              emit("error", {
                status: "error",
                code: settlementError?.code || "USAGE_STORE_UNAVAILABLE",
                message: settlementError?.publicMessage || "Usage accounting could not complete this follow-up.",
                partial: false,
                usage,
                scope,
              });
              return;
            }
          }
          // The failed provider attempt has already been accounted. Local
          // fallback is emitted without a second provider request or another
          // reservation settlement.
          const fallbackAnswer = createGeneralFollowupFallback(
            body, history, "local context after AI failure"
          );
          answer = fallbackAnswer;
          if (fallbackAnswer) emit("delta", {
            status: "streaming", delta: fallbackAnswer, fallback: true,
          });
          emit("complete", {
            status: "complete", answer: fallbackAnswer, usage,
            fallback: true, fallbackReason: error.publicMessage || error.message, scope,
          });
        } else {
          if (!settlementAttempted) {
            try {
              usage = await settleFailureUsageOrRelease(reservation, error, providerResult);
              settlementAttempted = true;
            } catch (settlementError) {
              settlementAttempted = true;
              console.warn("[omnimath:followup-usage-warning]", {
                requestId: correlation.requestId,
                code: settlementError?.code || null,
              });
            }
          }
          const cancelled = abortController.signal.aborted || error?.name === "AbortError";
          emit("error", {
            status: cancelled ? "cancelled" : publishedDelta ? "partial_error" : "error",
            code: cancelled ? "FOLLOWUP_CANCELLED" : error.code || "AI_SERVICE_UNAVAILABLE",
            message: cancelled
              ? "Follow-up generation was cancelled."
              : error.publicMessage || "The AI service could not complete this follow-up.",
            partial: publishedDelta,
            usage,
            scope,
          });
        }
      }
    }
    logHoverDebug("followup_finish", {
      ...correlation,
      semanticId: snapshot.target.semanticId || snapshot.target.targetId || null,
      fallback: !providerResult?.usage,
      partial: publishedDelta && !terminal,
      elapsedMs: Date.now() - startedAt,
    });
  } finally {
    res.off?.("close", onClose);
    req.off?.("aborted", onRequestAborted);
    req.off?.("error", onRequestError);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

export async function handleExplainFollowupRequest(req, res) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  await runHandler(res, async () => {
    const startedAt = Date.now();
    const timeout = resolveOpenAiRequestTimeout("pinned");
    const deadlineAt = startedAt + timeout.timeoutMs;
    const body = requireObject(await readJson(req));
    const correlation = followupCorrelation(body);
    logHoverDebug("followup_dispatch", {
      route: "/api/explain-followup",
      ...correlation,
      semanticId: body.provenanceSnapshot?.target?.semanticId || body.semanticSelection?.id || null,
      stepId: body.provenanceSnapshot?.origin?.stepId || body.stepId || null,
      timeoutMs: timeout.timeoutMs,
    });
    const identityResult = await resolveFollowupIdentity(req);
    const identity = identityResult.identity || identityResult;
    throttleRequest(req, identity, "ai");
    assertAiEnabled();
    const history = parseFollowupHistory(body.history);
    requireFollowupQuestion(body.question);
    const { prompt, snapshot, scope, presentationDepth } = buildProvenanceFollowupPrompt(body, history);
    const streaming = followupStreamRequested(req, body);
    let streamClaim = null;
    if (streaming) {
      requireFollowupStreamCorrelation(correlation);
      streamClaim = followupStreamKey(identity, correlation);
      if (activeFollowupStreams.has(streamClaim)) throw followupStreamConflict();
      activeFollowupStreams.add(streamClaim);
    }
    let reservationResult;
    try {
      reservationResult = await reserveFollowupUsage(req, identity, prompt);
    } catch (error) {
      if (streamClaim) activeFollowupStreams.delete(streamClaim);
      throw error;
    }
    const { reservation, usage: reservedUsage, fallbackReason } = reservationResult;
    if (streaming) {
      try {
        await handleStreamingFollowup({
          req, res, body, correlation, identity, identityResult, history, prompt, snapshot,
          scope, presentationDepth, reservation, reservedUsage, fallbackReason, deadlineAt, startedAt,
        });
      } finally {
        activeFollowupStreams.delete(streamClaim);
      }
      return;
    }
    let answer;
    let aiUsage;
    let aiExecution = null;
    let usage = reservedUsage;

    try {
      if (!isOpenAiConfigured()) {
        const configError = createOpenAiRequiredError();
        console.warn("[omnimath:followup-fallback]", {
          reason: "OpenAI unavailable",
          code: configError.code,
          message: configError.message,
        });
        answer = createGeneralFollowupFallback(body, history, "local pinned context");
      } else {
        try {
          const result = await createFollowupAnswer({
            prompt,
            scope,
            deadlineAt,
            debugContext: {
              requestId: correlation.requestId,
              recoveryPurpose: "followup",
            },
          });
          answer = String(result.text || "").trim();
          if (!answer) {
            throw Object.assign(new Error("The AI service returned an empty follow-up answer."), {
              statusCode: 502,
              code: "INVALID_AI_RESPONSE",
              publicMessage: "The AI service returned an incomplete explanation. Please try again.",
            });
          }
          aiUsage = result.usage;
          aiExecution = result._omniOpenAiDiagnostics || null;
        } catch (openAiError) {
          logHoverDebug("followup_error", {
            ...correlation,
            semanticId: snapshot.target.semanticId || snapshot.target.targetId || null,
            code: openAiError.code || null,
            statusCode: openAiError.statusCode || null,
            elapsedMs: Date.now() - startedAt,
          });
          if (!isProductionRuntime()) {
            console.warn("[omnimath:followup-fallback]", {
              reason: "OpenAI request failed",
              code: openAiError.code,
              message: openAiError.message,
              statusCode: openAiError.statusCode || null,
            });
            answer = createGeneralFollowupFallback(body, history, "local pinned context after AI failure");
          } else {
            throw openAiError;
          }
        }
      }
      const normalizedUsage = normalizeOpenAiUsage(aiUsage, estimateTokens(prompt));
      try {
        usage = await settleTokenUsage(
          reservation,
          normalizedUsage.totalTokens,
          dollarsToMicros(estimateOpenAiCost(aiUsage))
        );
      } catch (settleError) {
        if (!isProductionRuntime() && isLocalPersistenceError(settleError)) {
          console.warn("[omnimath:followup-fallback]", {
            reason: "usage settlement unavailable",
            code: settleError.code,
            message: settleError.message,
          });
          usage = reservedUsage;
        } else {
          throw settleError;
        }
      }
    } catch (error) {
      try {
        await releaseTokenReservation(reservation);
      } catch (releaseError) {
        console.warn("Could not release token reservation:", releaseError.message);
      }
      throw error;
    }

    logExplanationSource({
      source: isOpenAiConfigured() && aiUsage ? "live AI call" : "local fallback",
      kind: "text",
      endpoint: "/api/explain-followup",
      identity,
      requestId: correlation.requestId,
      prompt,
      aiUsage,
      execution: aiExecution,
    });
    sendJson(res, 200, {
      answer,
      usage,
      fallback: !aiUsage,
      ...correlation,
      fallbackReason: !aiUsage
        ? (fallbackReason || identityResult.fallbackReason || "OPENAI_API_KEY is not configured on the server.")
        : undefined,
    }, createUsageHeaders(usage));
    logHoverDebug("followup_finish", {
      ...correlation,
      semanticId: snapshot.target.semanticId || snapshot.target.targetId || null,
      fallback: !aiUsage,
      elapsedMs: Date.now() - startedAt,
    });
  });
}

export async function handleSessionsRequest(req, res) {
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "PUT" && req.method !== "DELETE") {
    sendMethodNotAllowed(res, ["GET", "POST", "PUT", "DELETE"]);
    return;
  }

  await runHandler(res, async () => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET") {
      const data = await getCurrentUserSessions(req);
      sendJson(res, 200, data);
      return;
    }

    const sessionId = url.searchParams.get("id");
    if (req.method === "DELETE") {
      if (!sessionId || typeof sessionId !== "string") {
        throw createBadInputError("Session id is required.");
      }
      const data = await deleteUserSessionForRequest(req, sessionId);
      sendJson(res, 200, data);
      return;
    }

    const body = await readJson(req);
    const session = validateSessionPayload(body);

    if (req.method === "POST") {
      const data = await createUserSessionForRequest(req, session);
      sendJson(res, 201, data);
      return;
    }

    const updateSessionId = sessionId || body.id || body.sessionId;
    if (!updateSessionId || typeof updateSessionId !== "string") {
      throw createBadInputError("Session id is required.");
    }

    const data = await updateUserSessionForRequest(req, updateSessionId, session);
    sendJson(res, 200, data);
  });
}

export async function handleUsageRequest(req, res) {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, ["GET"]);
    return;
  }

  await runHandler(res, async () => {
    const identity = await requireRequestIdentity(req, "usage");
    const data = await getUsageSnapshot({ req, identity });
    data.demoMode = !isOpenAiConfigured();
    data.aiEnabled = isAiEnabled();
    sendJson(res, 200, data);
  });
}

export async function handleCurrentUserRequest(req, res) {
  if (req.method !== "GET" && req.method !== "PUT") {
    sendMethodNotAllowed(res, ["GET", "PUT"]);
    return;
  }

  await runHandler(res, async () => {
    const body = req.method === "PUT" ? await readJson(req) : {};
    const data = await getCurrentUserData(req, body.profile || body);
    sendJson(res, 200, data);
  });
}

export async function handleHistoryRequest(req, res) {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, ["GET"]);
    return;
  }

  await runHandler(res, async () => {
    const data = await getCurrentUserHistory(req);
    sendJson(res, 200, data);
  });
}

export async function handleApiRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (redirectDevFrontendRequest(req, res, url)) {
    return;
  }

  if (url.pathname === "/api/health") {
    await handleHealthRequest(req, res);
    return;
  }

  if (url.pathname === "/api/debug/openai") {
    await handleOpenAiDebugRequest(req, res);
    return;
  }

  if (url.pathname === "/api/explain") {
    await handleExplainRequest(req, res);
    return;
  }

  if (url.pathname === "/api/explain-image") {
    await handleExplainImageRequest(req, res);
    return;
  }

  if (url.pathname === "/api/extract-image-problem") {
    await handleExtractImageProblemRequest(req, res);
    return;
  }

  if (url.pathname === "/api/solve-extracted-problem") {
    await handleSolveExtractedProblemRequest(req, res);
    return;
  }

  if (url.pathname === "/api/explain-token") {
    await handleExplainTokenRequest(req, res);
    return;
  }

  if (url.pathname === "/api/explain-pin") {
    await handleExplainPinRequest(req, res);
    return;
  }

  if (url.pathname === "/api/compare-methods") {
    await handleCompareMethodsRequest(req, res);
    return;
  }

  if (url.pathname === "/api/explain-followup") {
    await handleExplainFollowupRequest(req, res);
    return;
  }

  if (url.pathname === "/api/me") {
    await handleCurrentUserRequest(req, res);
    return;
  }

  if (url.pathname === "/api/history") {
    await handleHistoryRequest(req, res);
    return;
  }

  if (url.pathname === "/api/sessions") {
    await handleSessionsRequest(req, res);
    return;
  }

  if (url.pathname === "/api/usage") {
    await handleUsageRequest(req, res);
    return;
  }

  sendJson(res, 404, { code: "NOT_FOUND", error: "Not found", message: "Not found" });
}
