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
  createFollowupAnswer,
  createCompareMethods,
  createLazyTokenExplanation,
  debugOpenAiConnection,
  estimateOpenAiCost,
  estimateOpenAiCostBudget,
  estimateOpenAiTokenBudget,
  getOpenAiModel,
  getOpenAiRuntimeConfig,
  getLazyMaxOutputTokens,
  getImageExtractionMaxOutputTokens,
  isOpenAiConfigured,
  normalizeOpenAiUsage,
  getSolveMaxOutputTokens,
} from "./openai.js";
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
import { applyLocalRulesToExplanation, createLocalRuleExplanation } from "./localRules.js";
import { annotateMathExplanation } from "./mathAnnotator.js";
import { validateExtraction } from "./extractionValidation.js";
import { getOpenAiModelForPath, getOpenAiSamplingForPath } from "./openaiModels.js";
import { buildExtractedProblemDisplay, normalizeExtractedProblemText } from "./ocrTextNormalization.js";
import { validateSolutionQuality } from "./solutionValidation.js";
import { createMethodFingerprint } from "./mathValidationAnalysis.js";
import { analyzeSymbolOrigins } from "./symbolInventory.js";
import { captureFailedSolveDiagnostic } from "./failedSolveDiagnostics.js";
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
import {
  createUserSessionForRequest,
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
const MAX_FOLLOWUP_CONTEXT_CHARS = 16000;
const MAX_PROBLEM_CONTEXT_CHARS = 600;
const MAX_SELECTED_LATEX_CHARS = 1200;
const MAX_STEP_LATEX_CHARS = 2400;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function isSolveDebugEnabled() {
  return process.env.NODE_ENV !== "production" && (
    process.env.OMNIMATH_DEBUG_SOLVE === "true"
    || process.env.OMNIMATH_DEBUG_SOLVE === "1"
    || process.env.VITE_DEBUG_SOLUTION_STATE === "true"
  );
}

function createDebugRequestId(prefix = "req") {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
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

function isGenericImageProblemPrompt(value = "") {
  return /explain\s+(?:the\s+)?math\s+problem\s+in\s+this\s+image/i.test(String(value || ""));
}

function problemForSymbolDiagnostics(problem = "", result = {}) {
  if (isGenericImageProblemPrompt(problem)) {
    return result?.extractedProblemLatex || result?.expression || result?.originalProblem || problem || "";
  }
  return problem || result?.extractedProblemLatex || result?.originalProblem || result?.expression || result?.problem || "";
}

function validateSolutionQualityWithDebug(result, { problem = "", requestId = "", stage = "quality-validation" } = {}) {
  const ruleEvaluations = [];
  const symbolProblem = problemForSymbolDiagnostics(problem, result);
  const symbolDiagnostics = analyzeSymbolOrigins(symbolProblem, result);
  logSolveDebug("symbol_inventory", {
    requestId,
    stage,
    normalizedOriginalProblem: symbolProblem,
    originalSymbolInventory: symbolDiagnostics.originalSymbols,
    generatedSymbolInventory: symbolDiagnostics.generatedSymbols,
    newlyIntroducedSymbols: symbolDiagnostics.newlyIntroducedSymbols,
    explicitDefinitions: symbolDiagnostics.explicitDefinitions,
    unexplainedSymbols: symbolDiagnostics.unexplainedSymbols,
    fieldClassifications: symbolDiagnostics.fieldReports.map((field) => ({
      fieldPath: field.fieldPath,
      symbols: field.symbols,
      unexplainedSymbols: field.unexplainedSymbols,
    })),
  });
  try {
    const valid = validateSolutionQuality(result, {
      problem,
      onRuleEvaluation: (evaluation) => ruleEvaluations.push(evaluation),
    });
    for (const evaluation of ruleEvaluations) {
      logSolveDebug("validator_rule", {
        requestId,
        stage,
        validatorName: evaluation.validatorName,
        applicable: evaluation.applicable,
        applicabilityReason: evaluation.applicabilityReason,
        result: evaluation.result,
        failureEvidence: evaluation.failureEvidence,
        issue: evaluation.issue,
        domain: evaluation.domain,
        inputFields: evaluation.inputFields,
      });
    }
    logSolveDebug("validator_pass", {
      requestId,
      stage,
      validatorName: "validateSolutionQuality",
      failedRule: null,
      problem,
      stepCount: Array.isArray(result?.steps) ? result.steps.length : 0,
      finalAnswerLatex: result?.finalAnswerLatex || result?.finalAnswer || "",
    });
    return valid;
  } catch (error) {
    const evaluations = Array.isArray(error.solutionRuleEvaluations) ? error.solutionRuleEvaluations : ruleEvaluations;
    for (const evaluation of evaluations) {
      logSolveDebug("validator_rule", {
        requestId,
        stage,
        validatorName: evaluation.validatorName,
        applicable: evaluation.applicable,
        applicabilityReason: evaluation.applicabilityReason,
        result: evaluation.result,
        failureEvidence: evaluation.failureEvidence,
        issue: evaluation.issue,
        domain: evaluation.domain,
        inputFields: evaluation.inputFields,
      });
    }
    const failedRules = Array.isArray(error.solutionIssues) ? error.solutionIssues : [error.code || error.message].filter(Boolean);
    logSolveDebug("validator_fail", {
      requestId,
      stage,
      validatorName: "validateSolutionQuality",
      failedRules,
      exactFailedRule: failedRules[0] || null,
      ruleEvaluations: evaluations,
      problem,
      stepCount: Array.isArray(result?.steps) ? result.steps.length : 0,
      finalAnswerLatex: result?.finalAnswerLatex || result?.finalAnswer || "",
    });
    error.omniDebugContext = {
      ...(error.omniDebugContext || {}),
      requestId,
      stage,
      validatorName: "validateSolutionQuality",
      failedRules,
      problem,
    };
    throw error;
  }
}

function logAcceptedSolvePayload({ requestId = "", endpoint = "", problem = "", result = {}, source = "" } = {}) {
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
    finalAcceptedPayload: result,
  });
}

function logExtractionReviewDebug(validation) {
  if (process.env.NODE_ENV === "production") return;
  console.info("[omnimath:ocr-review]", {
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
    "- Rewrite the final answer using standard evaluable LaTeX such as \\frac, \\pi, \\ln, powers, and ordinary numbers.",
    "- Do not change only formatting if the derivation or value is mathematically wrong.",
  ],
};

function normalizeRepairIssueList(issues = []) {
  return [...new Set((Array.isArray(issues) ? issues : [issues])
    .map((issue) => String(issue || "").trim())
    .filter(Boolean))];
}

function sanitizeRepairPromptText(value = "", maxChars = MAX_REPAIR_EVIDENCE_ITEM_CHARS) {
  const sanitized = String(value || "")
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

function buildRuleSpecificRepairInstructions(issues = []) {
  const normalizedIssues = normalizeRepairIssueList(issues);
  return normalizedIssues
    .flatMap((issue) => RULE_SPECIFIC_REPAIR_INSTRUCTIONS[issue] || [])
    .join("\n") || "No rule-specific instructions.";
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
    evidenceExcerpts,
    earliestFailingStepId,
    requestedCorrectionStrategy,
    previousMethodFingerprint,
    currentMethodFingerprint,
    repeatedMethodDetected,
  };
}

export function buildRepairSolvePrompt(prompt, issues = [], {
  problem = "",
  previousResult = null,
  error = null,
} = {}) {
  const failedRules = normalizeRepairIssueList(issues);
  const rulesText = failedRules.join(", ") || "generic_invalid_solution";
  const evidenceText = collectRepairFailureEvidence(error || {}, failedRules);
  const ruleSpecificInstructions = buildRuleSpecificRepairInstructions(failedRules);
  const originalProblem = sanitizeRepairPromptText(problem, 2000) || "Use the original problem from the prompt above.";
  const previousSolution = compactPreviousInvalidSolution(previousResult || {});

  return `${prompt}

Quality repair context:

Original problem:
${originalProblem}

Previous invalid solution:
${previousSolution}

Failed validation rules:
${rulesText}

Exact failure evidence:
${evidenceText}

Rule-specific corrective instructions:
${ruleSpecificInstructions}

General repair requirements:
- Solve the actual extracted math problem, not a generic rule example.
- Do not output placeholders such as "Recognized rule", "f g x", or a one-step rule summary.
- Do not use undefined placeholder functions such as G(r,\theta), H(x), "symmetric function", or "defined above"; write the actual integral/formula or a numeric value.
- For curl surface integrals with an oriented boundary, use Stokes' theorem when applicable.
- For the paraboloid z = 9 - x^2 - y^2 above z = 0, identify C as x^2 + y^2 = 9, z = 0 with counterclockwise orientation viewed from above.
- Include a complete chain: OCR/problem review if relevant, theorem choice, boundary or parameterization, integral setup, simplification, coordinate change with Jacobian if used, then final answer.
- If changing to polar/elliptic variables, explicitly show the variables, bounds, and Jacobian.
- If Green's theorem reduces the answer to a non-elementary disk integral, state that instead of inventing a simple closed form.
- If the final answer is a non-elementary integral, leave it as an integral and say no elementary closed form is expected.
- For perfect-square trinomials, preserve grouping: write (x + n)^2 = 0, never x + n^2 = 0.
- For mathematical validation failures, rebuild the derivation from the earliest failing step; do not preserve invalid identities or alter only finalAnswerLatex.
- Verify substitutions, derivatives, signs, and special-function simplifications before using them.
- Keep finalAnswerLatex structurally valid as one standalone final expression.

Required response schema:
- Return only valid JSON matching the requested schema.`;
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
  purpose = null,
  attemptType = null,
  repairFeedback = null,
  previousResult = null,
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
} = {}) {
  return async ({
    error,
    stage,
    attemptType,
    prompt: attemptPrompt,
    promptHash: attemptPromptHash,
    purpose,
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
    purpose,
    attemptType,
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

  if (error.usage) {
    payload.usage = error.usage;
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
      throw Object.assign(new Error("Request body is too large."), {
        statusCode: 413,
        code: "BAD_INPUT",
      });
    }
    return req.body;
  }

  if (typeof req.body === "string") {
    const body = Buffer.from(req.body);
    if (body.length > maxBytes) {
      throw Object.assign(new Error("Request body is too large."), {
        statusCode: 413,
        code: "BAD_INPUT",
      });
    }
    return body;
  }

  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("Request body is too large."), {
        statusCode: 413,
        code: "BAD_INPUT",
      });
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJson(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
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

function safeCompactJson(value, maxChars = MAX_FOLLOWUP_CONTEXT_CHARS) {
  try {
    return JSON.stringify(value, (key, item) => {
      if (key === "_aiUsage" || key === "runtime" || key === "usage") return undefined;
      return item;
    }).slice(0, maxChars);
  } catch {
    return String(value || "").slice(0, maxChars);
  }
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

function buildFollowupPrompt(body, history) {
  const problem = String(body.problem || body.solution?.originalProblem || body.solution?.problem || body.solution?.expression || "").slice(0, MAX_PROBLEM_CHARS);
  const question = requireFollowupQuestion(body.question);
  const pinnedExplanation = String(body.pinnedExplanation || "").slice(0, 2400);
  const selectedText = String(body.selectedText || "").slice(0, 1600);
  const stepTitle = String(body.stepTitle || "").slice(0, 300);
  const selectedTokens = Array.isArray(body.selectedTokens) ? body.selectedTokens.slice(0, 40) : [];

  return `You are OmniMath, a careful AI math tutor. Answer a follow-up question about one pinned solution selection.

Rules:
- Use the provided problem and solution context.
- Answer only the user's follow-up question.
- Be concise, mathematically correct, and helpful.
- Use LaTeX for formulas when useful.
- Do not invent missing solution steps. Say what context is missing if necessary.

Original problem:
${problem}

Current step:
${stepTitle || body.stepId || "Unknown step"}

Selected text:
${selectedText || "No selected text provided."}

Pinned explanation:
${pinnedExplanation || "No pinned explanation provided."}

Selected tokens:
${safeCompactJson(selectedTokens, 5000)}

Full solution context:
${safeCompactJson(body.solution || {}, MAX_FOLLOWUP_CONTEXT_CHARS)}

Conversation history:
${history.map((item) => `${item.role}: ${item.text}`).join("\n") || "None"}

User question:
${question}`;
}

function isLocalPersistenceError(error) {
  return error?.code === "USAGE_STORE_UNAVAILABLE"
    || error?.code === "DATABASE_UNAVAILABLE"
    || error?.code === "SERVER_CONFIG_ERROR";
}

function createFollowupFallbackAnswer(body, history = [], reason = "local context") {
  const question = requireFollowupQuestion(body.question);
  const selectedText = String(body.selectedText || "").trim();
  const pinnedExplanation = String(body.pinnedExplanation || "").trim();
  const stepTitle = String(body.stepTitle || body.stepId || "").trim();
  const currentStep = body.currentStep?.math || body.currentStep?.latex || body.stepLatex || "";
  const selectedTokens = Array.isArray(body.selectedTokens) ? body.selectedTokens : [];
  const tokenContext = selectedTokens
    .slice(0, 6)
    .map((token) => token?.display || token?.latex || token?.text)
    .filter(Boolean)
    .join(", ");
  const lowerQuestion = question.toLowerCase();

  const contextLines = [
    selectedText ? `the pinned selection \`${selectedText}\`` : "the pinned selection",
    stepTitle ? `in "${stepTitle}"` : "",
    currentStep ? `from the step \`${currentStep}\`` : "",
  ].filter(Boolean).join(" ");

  if (/where did .*3|where.*3.*from|3 from/.test(lowerQuestion)) {
    const source = selectedText && /3/.test(selectedText)
      ? `The 3 is part of the pinned expression \`${selectedText}\`.`
      : currentStep && /3/.test(currentStep)
      ? `The 3 appears in the current step \`${currentStep}\`.`
      : "The available pinned context does not show a separate source for 3.";
    return `${source} ${pinnedExplanation ? `From the pinned explanation: ${pinnedExplanation}` : "Use the surrounding step and selected expression to trace it back to the prior simplification."}`;
  }

  return [
    `Using the saved pinned context (${reason}), I can answer from ${contextLines || "the current pinned math context"}.`,
    pinnedExplanation ? `Pinned explanation: ${pinnedExplanation}` : "",
    tokenContext ? `Related selected tokens: ${tokenContext}.` : "",
    history.length > 0 ? "I kept the previous chat turns in context for this answer." : "",
  ].filter(Boolean).join(" ");
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
  const estimatedTokens = estimateOpenAiTokenBudget({ prompt });
  const estimatedCostMicros = dollarsToMicros(estimateOpenAiCostBudget({ prompt }));
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

function mergeOpenAiUsageValues(...usages) {
  const present = usages.filter(Boolean);
  if (present.length === 0) return null;
  return present.reduce((merged, usage) => {
    const normalized = normalizeOpenAiUsage(usage, 0);
    return {
      input_tokens: (merged.input_tokens || 0) + normalized.inputTokens,
      output_tokens: (merged.output_tokens || 0) + normalized.outputTokens,
      total_tokens: (merged.total_tokens || 0) + normalized.totalTokens,
    };
  }, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
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
} = {}) {
  if (!reservation) return null;
  const normalizedUsage = normalizeOpenAiUsage(usage, 0);
  return settleTokenUsage(
    reservation,
    normalizedUsage.totalTokens,
    dollarsToMicros(estimateOpenAiCost(usage)),
    {
      actualInputTokens: normalizedUsage.inputTokens,
      actualOutputTokens: normalizedUsage.outputTokens,
      providerCalls,
      settlementReason,
    }
  );
}

async function settleFailureUsageOrRelease(reservation, error = null, result = null) {
  if (!reservation) return null;
  const errorUsage = aiUsageFrom(error);
  const resultUsage = aiUsageFrom(result);
  const usage = errorUsage || resultUsage || null;
  const providerCalls = aiCallCountFrom(error) || aiCallCountFrom(result);
  if (usage || providerCalls > 0) {
    return settleAiUsageReservation(reservation, usage, {
      providerCalls: Math.max(providerCalls, usage ? 1 : 0),
      settlementReason: "failure",
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

function logExplanationSource({ source, kind, endpoint, identity, prompt = "", aiUsage = null }) {
  const normalizedUsage = normalizeOpenAiUsage(aiUsage, estimateTokens(prompt));
  const tokenUsage = aiUsage
    ? normalizedUsage
    : {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        approximateInputTokens: estimateTokens(prompt),
      };

  console.info("[omnimath:ai-request]", {
    userId: identity?.clerkUserId,
    endpoint,
    source,
    kind,
    model: getOpenAiModel(),
    tokens: tokenUsage,
    estimatedCostUsd: Number(estimateOpenAiCost(aiUsage).toFixed(6)),
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

function buildResponse(result, { usage, saved, source, demoMode, canonicalProblem = null }) {
  return {
    ...result,
    canonicalProblem: canonicalProblem || result.canonicalProblem || null,
    canonicalInputHash: canonicalProblem?.hash || result.canonicalProblem?.hash || null,
    usage,
    savedExplanationId: saved?.id,
    runtime: {
      source,
      demoMode,
    },
  };
}

async function runHandler(res, handler) {
  try {
    await handler();
  } catch (error) {
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

  return {
    title,
    demoKey: typeof session.demoKey === "string" ? session.demoKey : null,
    messages: Array.isArray(session.messages) ? parseHistory(session.messages) : [],
    problem: problem || null,
    problems: Array.isArray(problems) ? problems : problem ? [problem] : [],
    steps: Array.isArray(session.steps) ? session.steps : problem?.steps || [],
    pinnedWindows: Array.isArray(pinnedWindows) ? pinnedWindows : [],
  };
}

async function saveExplanationBestEffort(req, details) {
  try {
    return await saveExplanationForRequest(req, details);
  } catch (error) {
    console.warn("Could not save user explanation:", error.message);
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

export async function handleExplainRequest(req, res) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  await runHandler(res, async () => {
    const startedAt = Date.now();
    const identity = await requireRequestIdentity(req, "explain");
    throttleRequest(req, identity, "ai");
    assertAiEnabled();
    const body = await readJson(req);
    requireObject(body);
    const requestId = optionalShortText(body.debugRequestId || body.clientRequestId || "", "Debug request id", 120)
      || createDebugRequestId("solve-text");
    const canonicalProblem = normalizeCanonicalProblem(body, { source: "typed" });
    const problem = requireTextProblem(getCanonicalSolverInput(canonicalProblem));
    logCanonicalProblem("solve request", canonicalProblem, { endpoint: "/api/explain" });
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
      reference,
      depth,
      type: "text",
    });
    const cached = getCachedExplanation(cacheKey);
    if (cached) {
      const usage = await getUsageForKind(req, "explanation", identity);
      logExplanationSource({
        source: "cached",
        kind: "text",
        endpoint: "/api/explain",
        identity,
      });
      sendJson(
        res,
        200,
        buildResponse(cached, { usage, source: "cached", demoMode: !isOpenAiConfigured(), canonicalProblem }),
        createUsageHeaders(usage)
      );
      return;
    }

    const prompt = buildMathExplanationPrompt({ problem, history });
    const promptHash = hashDebugText(prompt);
    const solverSampling = getOpenAiSamplingForPath("solver");
    logSolveDebug("request_received", {
      requestId,
      endpoint: "/api/explain",
      normalizedProblem: problem,
      normalizedProblemHash: hashDebugText(problem),
      promptHash,
      model: getOpenAiModelForPath("solver"),
      temperature: solverSampling.temperature ?? null,
      topP: solverSampling.top_p ?? null,
      temperatureSource: solverSampling.temperature === undefined ? "provider_default" : "payload",
      topPSource: solverSampling.top_p === undefined ? "provider_default" : "payload",
      cacheKey,
      historyCount: history.length,
    });
    logSolutionStateDebug("server prompt problem", {
      promptProblemText: problem,
      promptChars: prompt.length,
    });
    const estimatedTokens = estimateOpenAiTokenBudget({ prompt, maxOutputTokens: getSolveMaxOutputTokens() });
    const estimatedCostMicros = dollarsToMicros(estimateOpenAiCostBudget({ prompt, maxOutputTokens: getSolveMaxOutputTokens() }));
    const { duplicate, value } = await runDeduplicatedRequest(cacheKey, async () => {
      let result = createLocalRuleExplanation(problem, { source: "text" });
      let source = "local rule";
      const willCallOpenAi = !result && isOpenAiConfigured();
      const { reservation } = willCallOpenAi
        ? await checkAndReserveUsage({
            req,
            identity,
            kind: "explanation",
            estimatedTokens,
            estimatedCostMicros,
          })
        : { reservation: null };
      if (!willCallOpenAi && !isProductionRuntime()) {
        console.info("[omnimath:usage]", {
          event: "allowed",
          route: "/api/explain",
          reason: result ? "local-rule-no-ai-reservation" : "no-openai-configured-no-reservation",
          subject: identity.subject,
          tier: identity.tier,
        });
      }
      let usage;
      let accumulatedAiUsage = null;
      let accumulatedAiCallCount = 0;

      try {
        if (result) {
          try {
            validateSolutionQualityWithDebug(result, { problem, requestId, stage: "local-rule-initial" });
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
              result = await createMathExplanation({
                prompt,
                originalProblem: problem,
                debugContext: {
                  requestId,
                  endpoint: "/api/explain",
                  normalizedProblem: problem,
                  promptHash,
                },
                onGeneratedResponseFailure: createGeneratedResponseFailureCapture({
                  requestId,
                  endpoint: "/api/explain",
                  prompt,
                  promptHash,
                  problem,
                  problemText: "",
                  canonicalProblem,
                  repairAttempted: true,
                }),
              });
              accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(result));
              accumulatedAiCallCount += aiCallCountFrom(result);
              attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
              result = applyLocalRulesToExplanation(result);
              validateSolutionQualityWithDebug(result, { problem, requestId, stage: "live-ai-initial" });
              source = "live AI call";
            } catch (firstError) {
              if ([
                "AI_SERVICE_UNAVAILABLE",
                "AI_PROVIDER_RATE_LIMITED",
                "AI_SERVICE_ERROR",
                "SERVER_CONFIG_ERROR",
              ].includes(firstError.code)) {
                throw firstError;
              }
              accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(firstError));
              accumulatedAiCallCount += aiCallCountFrom(firstError);
              const initialInvalidResult = result;
              const repairIssues = firstError.solutionIssues || [firstError.code || firstError.message];
              const repairFeedback = buildRepairFeedbackDetails(repairIssues, {
                error: firstError,
                currentResult: initialInvalidResult,
              });
              await captureSolveQualityFailure({
                error: firstError,
                result,
                stage: "initial",
                requestId,
                endpoint: "/api/explain",
                prompt,
                promptHash,
                problem,
                problemText: "",
                canonicalProblem,
                repairAttempted: true,
                repairFeedback,
              });
              const repairPrompt = buildRepairSolvePrompt(prompt, repairIssues, {
                problem,
                previousResult: initialInvalidResult,
                error: firstError,
              });
              logSolveDebug("repair_retry", {
                requestId,
                endpoint: "/api/explain",
                retryCount: 1,
                failedRules: firstError.solutionIssues || [firstError.code || firstError.message].filter(Boolean),
                repairPromptHash: hashDebugText(repairPrompt),
              });
              const repairPromptHash = hashDebugText(repairPrompt);
              try {
                result = await createMathExplanation({
                  prompt: repairPrompt,
                  originalProblem: problem,
                  debugContext: {
                    requestId,
                    endpoint: "/api/explain",
                    normalizedProblem: problem,
                    promptHash: repairPromptHash,
                    retryPurpose: "quality-repair",
                  },
                  onGeneratedResponseFailure: createGeneratedResponseFailureCapture({
                    requestId,
                    endpoint: "/api/explain",
                    prompt: repairPrompt,
                    promptHash: repairPromptHash,
                    problem,
                    problemText: "",
                    canonicalProblem,
                    repairAttempted: true,
                  }),
                });
                accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(result));
                accumulatedAiCallCount += aiCallCountFrom(result);
                attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
                result = applyLocalRulesToExplanation(result);
                validateSolutionQualityWithDebug(result, { problem, requestId, stage: "live-ai-repair" });
                source = "live AI repair call";
              } catch (repairError) {
                const failureUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(repairError));
                const failureCallCount = accumulatedAiCallCount + aiCallCountFrom(repairError);
                attachAccumulatedAiUsage(repairError, failureUsage, failureCallCount);
                await captureSolveQualityFailure({
                  error: repairError,
                  result,
                  stage: "repair",
                  requestId,
                  endpoint: "/api/explain",
                  prompt: repairPrompt,
                  promptHash: repairPromptHash,
                  problem,
                  problemText: "",
                  canonicalProblem,
                  repairAttempted: true,
                  repairFeedback: buildRepairFeedbackDetails(repairError.solutionIssues || [repairError.code || repairError.message], {
                    error: repairError,
                    previousResult: initialInvalidResult,
                    currentResult: result,
                  }),
                  previousResult: initialInvalidResult,
                });
                throw repairError;
              }
            }
          }
        }
        validateSolutionQualityWithDebug(result, { problem, requestId, stage: "pre-annotation-final" });
        result = annotateMathExplanation(result);
        attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
        logSolutionStateDebug("server model response", {
          problemText: problem,
          responseTitle: result.title || "",
          responseProblem: result.problem || result.originalProblem || result.expression || "",
          normalizedStepCount: getSolutionStepsForDebug(result),
          source,
        });

        usage = reservation
          ? await settleAiUsageReservation(reservation, result._aiUsage, {
              providerCalls: result._aiCallCount || 0,
              settlementReason: "success",
            })
          : await getUsageForKind(req, "explanation", identity);
      } catch (error) {
        try {
          usage = await settleFailureUsageOrRelease(reservation, error, result);
          if (usage) error.usage = usage;
        } catch (releaseError) {
          console.warn("Could not settle failed token reservation:", releaseError.message);
        }
        throw error;
      }

      setCachedExplanation(cacheKey, result);
      logAcceptedSolvePayload({
        requestId,
        endpoint: "/api/explain",
        problem,
        result,
        source,
      });
      logSolveTiming({
        endpoint: "/api/explain",
        startedAt,
        source,
        identity,
        prompt,
        aiUsage: result._aiUsage,
        apiCallCount: result._aiCallCount || (willCallOpenAi ? 1 : 0),
      });
      logExplanationSource({
        source,
        kind: "text",
        endpoint: "/api/explain",
        identity,
        prompt,
        aiUsage: result._aiUsage,
      });
      result.canonicalProblem = canonicalProblem;
      const saved = await saveExplanationBestEffort(req, { source: "text", problem, result });
      return { result, usage, saved, source };
    });

    const { result, usage, saved, source } = value;
    sendJson(
      res,
      200,
      buildResponse(result, {
        usage,
        saved,
        source: duplicate ? `${source} (deduplicated)` : source,
        demoMode: !isOpenAiConfigured(),
        canonicalProblem,
      }),
      createUsageHeaders(usage)
    );
    logSolveDebug("http_response", {
      requestId,
      endpoint: "/api/explain",
      statusCode: 200,
      source,
      finalUiState: "success-response-sent",
      stepCount: Array.isArray(result?.steps) ? result.steps.length : 0,
    });
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
    const estimatedTokens = estimateOpenAiTokenBudget({
      prompt,
      image,
      maxOutputTokens: getImageExtractionMaxOutputTokens(),
    });
    const estimatedCostMicros = dollarsToMicros(estimateOpenAiCostBudget({
      prompt,
      image,
      maxOutputTokens: getImageExtractionMaxOutputTokens(),
    }));

    logImageUploadDebug("extract-input", {
      filename: image.filename || null,
      contentType: image.contentType,
      bytes: image.buffer.length,
      promptChars: prompt.length,
      imageHash,
    });

    const { reservation } = await checkAndReserveUsage({
      req,
      identity,
      kind: "image",
      estimatedTokens: isOpenAiConfigured() ? estimatedTokens : 0,
      estimatedCostMicros: isOpenAiConfigured() ? estimatedCostMicros : 0,
    });
    let extraction;
    let usage;

    try {
      if (!isOpenAiConfigured()) {
        throw createOpenAiRequiredError();
      }
      extraction = await createImageProblemExtraction({ prompt, image });
      const rawExtractedText = extraction.extractedProblemText;
      traceMathStage("OCR output", "", extraction.extractedProblemLatex, "model image extraction", {
        extractedProblemText: rawExtractedText,
      });
      const textCleanup = normalizeExtractedProblemText(rawExtractedText);
      traceMathStage("OCR normalization", rawExtractedText, textCleanup.text || rawExtractedText, "plain OCR text spacing cleanup");
      extraction.rawExtractedText = rawExtractedText;
      extraction.extractedProblemText = textCleanup.text || rawExtractedText;
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
      logExtractionReviewDebug(extraction.extractionValidation);
      extraction.confidence = extraction.extractionValidation.confidence;
      extraction.ocrConfidence = extraction.extractionValidation.ocrConfidence;
      extraction.mathIntegrityScore = extraction.extractionValidation.mathIntegrityScore;
      extraction.confidenceTier = extraction.extractionValidation.tier;
      extraction.issues = extraction.extractionValidation.issues;
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

      const normalizedUsage = normalizeOpenAiUsage(extraction._aiUsage, estimatedTokens);
      usage = await settleTokenUsage(
        reservation,
        normalizedUsage.totalTokens,
        dollarsToMicros(estimateOpenAiCost(extraction._aiUsage))
      );
    } catch (error) {
      try {
        await releaseTokenReservation(reservation);
      } catch (releaseError) {
        console.warn("Could not release token reservation:", releaseError.message);
      }
      throw error;
    }

    logSolveTiming({
      endpoint: "/api/extract-image-problem",
      startedAt,
      source: "live AI extraction",
      identity,
      prompt,
      aiUsage: extraction._aiUsage,
      apiCallCount: extraction._aiCallCount || 1,
    });

    sendJson(res, 200, {
      ...extraction,
      usage,
      runtime: {
        source: "live AI extraction",
        demoMode: !isOpenAiConfigured(),
      },
    }, createUsageHeaders(usage));
  });
}

export async function handleSolveExtractedProblemRequest(req, res) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  await runHandler(res, async () => {
    const startedAt = Date.now();
    const identity = await requireRequestIdentity(req, "solve-extracted-problem");
    throttleRequest(req, identity, "ai");
    assertAiEnabled();
    const body = requireObject(await readJson(req));
    const requestId = optionalShortText(body.debugRequestId || body.clientRequestId || "", "Debug request id", 120)
      || createDebugRequestId("solve-extracted");
    const requestBodyChars = JSON.stringify(body).length;
    const extraction = requireObject(body.extraction || {}, "Extraction");
    const canonicalProblem = normalizeCanonicalProblem(body, {
      canonicalText: body.problem || body.problemText || body.extractedProblemText || extraction.normalizedText || extraction.validationText || "",
      canonicalLatex: body.problemLatex || body.extractedProblemLatex || extraction.extractedProblemLatex || "",
      source: extraction?.canonicalProblem?.source || (body.solveDecision === "direct" ? "ocr-direct" : "ocr-reviewed"),
      extractionWarnings: extraction.issues || extraction.extractionValidation?.issues || [],
      extractionConfidence: extraction.confidence ?? extraction.extractionValidation?.confidence,
    });
    const problemLatex = requireTextProblem(getCanonicalSolverInput(canonicalProblem));
    const problemText = optionalShortText(body.problemText || body.extractedProblemText || "", "Problem text", MAX_PROBLEM_CHARS);
    const solveDecision = ["direct", "anyway", "edited"].includes(body.solveDecision)
      ? body.solveDecision
      : "direct";
    logCanonicalProblem("solve request", canonicalProblem, { endpoint: "/api/solve-extracted-problem", solveDecision });
    const prompt = buildMathExplanationPrompt({ problem: problemLatex });
    const promptHash = hashDebugText(prompt);
    logImageUploadDebug("solve-extracted-input", {
      problemChars: problemLatex.length,
      problemPreview: problemLatex.slice(0, 240),
      problemTextChars: problemText.length,
      problemTextPreview: problemText.slice(0, 240),
      promptChars: prompt.length,
      requestBodyChars,
      submittedProblemSource: extraction.submittedProblemSource || "",
      hasPreviewMath: Array.isArray(extraction.previewMath) && extraction.previewMath.length > 0,
    });
    traceMathStage("Prompt construction", problemLatex, prompt, "insert confirmed image LaTeX into solve prompt");
    const estimatedTokens = estimateOpenAiTokenBudget({ prompt, maxOutputTokens: getSolveMaxOutputTokens() });
    const estimatedCostMicros = dollarsToMicros(estimateOpenAiCostBudget({ prompt, maxOutputTokens: getSolveMaxOutputTokens() }));
    const cacheKey = createExplanationCacheKey({
      userId: identity.clerkUserId,
      problem: problemLatex,
      reference: [
        "solve-extracted",
        extraction.imageSource?.imageHash || extraction.imageHash || "",
        solveDecision,
      ].join(":"),
      depth: "intermediate",
      type: "image-confirmed",
    });
    const solverSampling = getOpenAiSamplingForPath("solver");
    logSolveDebug("request_received", {
      requestId,
      endpoint: "/api/solve-extracted-problem",
      normalizedExtractedProblem: problemLatex,
      normalizedProblemHash: hashDebugText(problemLatex),
      extractedProblemText: problemText,
      promptHash,
      model: getOpenAiModelForPath("solver"),
      temperature: solverSampling.temperature ?? null,
      topP: solverSampling.top_p ?? null,
      temperatureSource: solverSampling.temperature === undefined ? "provider_default" : "payload",
      topPSource: solverSampling.top_p === undefined ? "provider_default" : "payload",
      cacheKey,
      solveDecision,
      canonicalInputHash: canonicalProblem.hash,
    });

    const { duplicate, value } = await runDeduplicatedRequest(cacheKey, async () => {
      let result = createLocalRuleExplanation(problemLatex, { source: "image" });
      let source = "local rule";
      const willCallOpenAi = isOpenAiConfigured();
      const { reservation } = await checkAndReserveUsage({
        req,
        identity,
        kind: "image",
        estimatedTokens: willCallOpenAi ? estimatedTokens : 0,
        estimatedCostMicros: willCallOpenAi ? estimatedCostMicros : 0,
      });
      let usage;
      let accumulatedAiUsage = null;
      let accumulatedAiCallCount = 0;

      try {
        if (result) {
          try {
            validateSolutionQualityWithDebug(result, { problem: problemLatex, requestId, stage: "local-rule-initial" });
          } catch (error) {
            if (!isOpenAiConfigured()) throw error;
            result = null;
          }
        }

        if (!result) {
          if (!isOpenAiConfigured()) {
            throw createOpenAiRequiredError();
          }
          try {
            result = await createMathExplanation({
              prompt,
              originalProblem: problemLatex,
              debugContext: {
                requestId,
                endpoint: "/api/solve-extracted-problem",
                normalizedProblem: problemLatex,
                promptHash,
              },
              onGeneratedResponseFailure: createGeneratedResponseFailureCapture({
                requestId,
                endpoint: "/api/solve-extracted-problem",
                prompt,
                promptHash,
                problem: problemLatex,
                problemText,
                canonicalProblem,
                extraction,
                repairAttempted: true,
              }),
            });
            accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(result));
            accumulatedAiCallCount += aiCallCountFrom(result);
            attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
            traceMathStage("Explanation generation", problemLatex, result.expression || result.problem || "", "LLM solve response");
            result = applyLocalRulesToExplanation(result);
            validateSolutionQualityWithDebug(result, { problem: problemLatex, requestId, stage: "live-ai-initial" });
            source = "live AI call";
          } catch (firstError) {
            if ([
              "AI_SERVICE_UNAVAILABLE",
              "AI_PROVIDER_RATE_LIMITED",
              "AI_SERVICE_ERROR",
              "SERVER_CONFIG_ERROR",
            ].includes(firstError.code)) {
              throw firstError;
            }
            accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(firstError));
            accumulatedAiCallCount += aiCallCountFrom(firstError);
            const initialInvalidResult = result;
            const repairIssues = firstError.solutionIssues || [firstError.code || firstError.message];
            const repairFeedback = buildRepairFeedbackDetails(repairIssues, {
              error: firstError,
              currentResult: initialInvalidResult,
            });
            await captureSolveQualityFailure({
              error: firstError,
              result,
              stage: "initial",
              requestId,
              endpoint: "/api/solve-extracted-problem",
              prompt,
              promptHash,
              problem: problemLatex,
              problemText,
              canonicalProblem,
              extraction,
              repairAttempted: true,
              repairFeedback,
            });
            const repairPrompt = buildRepairSolvePrompt(prompt, repairIssues, {
              problem: problemLatex,
              previousResult: initialInvalidResult,
              error: firstError,
            });
            logSolveDebug("repair_retry", {
              requestId,
              endpoint: "/api/solve-extracted-problem",
              retryCount: 1,
              failedRules: firstError.solutionIssues || [firstError.code || firstError.message].filter(Boolean),
              repairPromptHash: hashDebugText(repairPrompt),
            });
            const repairPromptHash = hashDebugText(repairPrompt);
            try {
              result = await createMathExplanation({
                prompt: repairPrompt,
                originalProblem: problemLatex,
                debugContext: {
                  requestId,
                  endpoint: "/api/solve-extracted-problem",
                  normalizedProblem: problemLatex,
                  promptHash: repairPromptHash,
                  retryPurpose: "quality-repair",
                },
                onGeneratedResponseFailure: createGeneratedResponseFailureCapture({
                  requestId,
                  endpoint: "/api/solve-extracted-problem",
                  prompt: repairPrompt,
                  promptHash: repairPromptHash,
                  problem: problemLatex,
                  problemText,
                  canonicalProblem,
                  extraction,
                  repairAttempted: true,
                }),
              });
              accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(result));
              accumulatedAiCallCount += aiCallCountFrom(result);
              attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
              traceMathStage("Explanation generation", problemLatex, result.expression || result.problem || "", "LLM repair solve response");
              result = applyLocalRulesToExplanation(result);
              validateSolutionQualityWithDebug(result, { problem: problemLatex, requestId, stage: "live-ai-repair" });
              source = "live AI repair call";
            } catch (repairError) {
              const failureUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(repairError));
              const failureCallCount = accumulatedAiCallCount + aiCallCountFrom(repairError);
              attachAccumulatedAiUsage(repairError, failureUsage, failureCallCount);
              await captureSolveQualityFailure({
                error: repairError,
                result,
                stage: "repair",
                requestId,
                endpoint: "/api/solve-extracted-problem",
                prompt: repairPrompt,
                promptHash: repairPromptHash,
                problem: problemLatex,
                problemText,
                canonicalProblem,
                extraction,
                repairAttempted: true,
                repairFeedback: buildRepairFeedbackDetails(repairError.solutionIssues || [repairError.code || repairError.message], {
                  error: repairError,
                  previousResult: initialInvalidResult,
                  currentResult: result,
                }),
                previousResult: initialInvalidResult,
              });
              throw repairError;
            }
          }
        }
        validateSolutionQualityWithDebug(result, { problem: problemLatex, requestId, stage: "pre-annotation-final" });
        const beforeAnnotation = result.expression || result.problem || problemLatex;
        result = annotateMathExplanation(result);
        attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
        traceMathStage("Tokenization", beforeAnnotation, result.expression || result.problem || "", "annotate explanation tokens/chunks");
        result.imageSource = {
          ...(extraction.imageSource || {}),
          imageHash: extraction.imageSource?.imageHash || extraction.imageHash || null,
          filename: extraction.imageSource?.filename || null,
          contentType: extraction.imageSource?.contentType || null,
          bytes: extraction.imageSource?.bytes || null,
          rawExtractedText: extraction.rawExtractedText || extraction.extractedProblemText || extraction.imageSource?.rawExtractedText || "",
          cleanedExtractedText: extraction.extractedProblemText || extraction.imageSource?.cleanedExtractedText || "",
          rawExtractedLatex: extraction.rawExtractedLatex || extraction.extractedProblemLatex || extraction.imageSource?.rawExtractedLatex || "",
          rawText: extraction.rawText || extraction.imageSource?.rawText || extraction.rawExtractedText || "",
          displayText: extraction.displayText || extraction.imageSource?.displayText || problemText,
          normalizedText: extraction.normalizedText || extraction.imageSource?.normalizedText || problemLatex,
          validationText: extraction.validationText || extraction.imageSource?.validationText || extraction.normalizedText || problemLatex,
          finalProblemText: problemText,
          finalProblemLatex: problemLatex,
          confidence: Number(extraction.confidence ?? extraction.extractionValidation?.confidence ?? extraction.imageSource?.confidence ?? 0),
          ocrConfidence: Number(extraction.ocrConfidence ?? extraction.extractionValidation?.ocrConfidence ?? extraction.imageSource?.ocrConfidence ?? 0),
          mathIntegrityScore: Number(extraction.mathIntegrityScore ?? extraction.extractionValidation?.mathIntegrityScore ?? extraction.imageSource?.mathIntegrityScore ?? extraction.confidence ?? 0),
          confidenceTier: extraction.confidenceTier || extraction.extractionValidation?.tier || extraction.imageSource?.confidenceTier || "",
          issues: Array.isArray(extraction.issues)
            ? extraction.issues
            : extraction.extractionValidation?.issues || extraction.imageSource?.issues || [],
          solveDecision,
          editedBeforeSolving: solveDecision === "edited",
          canonicalProblem,
          canonicalInputHash: canonicalProblem.hash,
        };
        result.canonicalProblem = canonicalProblem;
        result.canonicalInputHash = canonicalProblem.hash;
        result.extractedProblemText = result.imageSource.finalProblemText || result.imageSource.cleanedExtractedText || result.imageSource.rawExtractedText;
        result.extractedProblemLatex = result.imageSource.rawExtractedLatex;
        result.extractionValidation = extraction.extractionValidation || {
          confidence: result.imageSource.confidence,
          ocrConfidence: result.imageSource.ocrConfidence,
          mathIntegrityScore: result.imageSource.mathIntegrityScore,
          tier: result.imageSource.confidenceTier,
          issues: result.imageSource.issues,
        };
        result.confidence = result.extractionValidation.confidence;
        result.ocrConfidence = result.extractionValidation.ocrConfidence;
        result.mathIntegrityScore = result.extractionValidation.mathIntegrityScore;
        result.confidenceTier = result.extractionValidation.tier;

        usage = await settleAiUsageReservation(reservation, result._aiUsage, {
          providerCalls: result._aiCallCount || 0,
          settlementReason: "success",
        });
      } catch (error) {
        try {
          usage = await settleFailureUsageOrRelease(reservation, error, result);
          if (usage) error.usage = usage;
        } catch (releaseError) {
          console.warn("Could not settle failed token reservation:", releaseError.message);
        }
        throw error;
      }

      setCachedExplanation(cacheKey, result);
      logAcceptedSolvePayload({
        requestId,
        endpoint: "/api/solve-extracted-problem",
        problem: problemLatex,
        result,
        source,
      });
      result.canonicalProblem = canonicalProblem;
      result.canonicalInputHash = canonicalProblem.hash;
      const saved = await saveExplanationBestEffort(req, { source: "image", problem: problemLatex, result });
      return { result, usage, saved, source };
    });

    const { result, usage, saved, source } = value;
    logSolveTiming({
      endpoint: "/api/solve-extracted-problem",
      startedAt,
      source,
      identity,
      prompt,
      requestBodyChars,
      aiUsage: result._aiUsage,
      apiCallCount: result._aiCallCount || 0,
    });
    sendJson(
      res,
      200,
      buildResponse(result, {
        usage,
        saved,
        source: duplicate ? `${source} (deduplicated)` : source,
        demoMode: !isOpenAiConfigured(),
        canonicalProblem,
      }),
      createUsageHeaders(usage)
    );
    logSolveDebug("http_response", {
      requestId,
      endpoint: "/api/solve-extracted-problem",
      statusCode: 200,
      source,
      finalUiState: "success-response-sent",
      stepCount: Array.isArray(result?.steps) ? result.steps.length : 0,
    });
  });
}

export async function handleExplainImageRequest(req, res) {
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
    const requestId = optionalShortText(fields.debugRequestId || fields.clientRequestId || "", "Debug request id", 120)
      || createDebugRequestId("solve-image");
    const problem = requireTextProblem(fields.prompt || "Explain the math problem in this image.");
    const image = requireImage(files.file);
    logImageUploadDebug("received", {
      received: Boolean(image),
      filename: image.filename || null,
      contentType: image.contentType,
      bytes: image.buffer.length,
      prompt: problem,
    });
    const imageHash = createImageHash(image);
    const cacheKey = createExplanationCacheKey({
      userId: identity.clerkUserId,
      problem,
      reference: fields.selectedTokenId || fields.selectedStepId || fields.reference || imageHash,
      depth: fields.depth || "intermediate",
      type: "image",
      imageHash,
    });
    const cached = getCachedExplanation(cacheKey);
    if (cached) {
      const usage = await getUsageForKind(req, "image", identity);
      logExplanationSource({
        source: "cached",
        kind: "image",
        endpoint: "/api/explain-image",
        identity,
      });
      sendJson(
        res,
        200,
        buildResponse(cached, { usage, source: "cached", demoMode: !isOpenAiConfigured() }),
        createUsageHeaders(usage)
      );
      return;
    }

    const prompt = buildMathExplanationPrompt({ problem, image: true });
    const promptHash = hashDebugText(prompt);
    const solverSampling = getOpenAiSamplingForPath("solver");
    logSolveDebug("request_received", {
      requestId,
      endpoint: "/api/explain-image",
      normalizedProblem: problem,
      normalizedProblemHash: hashDebugText(problem),
      promptHash,
      model: getOpenAiModelForPath("solver"),
      temperature: solverSampling.temperature ?? null,
      topP: solverSampling.top_p ?? null,
      temperatureSource: solverSampling.temperature === undefined ? "provider_default" : "payload",
      topPSource: solverSampling.top_p === undefined ? "provider_default" : "payload",
      cacheKey,
      imageHash,
    });
    traceMathStage("Prompt construction", problem, prompt, "insert image-upload context into image solve prompt");
    logImageUploadDebug("openai-input", {
      forwardedToOpenAI: true,
      filename: image.filename || null,
      contentType: image.contentType,
      bytes: image.buffer.length,
      promptChars: prompt.length,
      imageHash,
    });
    const estimatedTokens = estimateOpenAiTokenBudget({ prompt, image, maxOutputTokens: getSolveMaxOutputTokens() });
    const estimatedCostMicros = dollarsToMicros(estimateOpenAiCostBudget({ prompt, image, maxOutputTokens: getSolveMaxOutputTokens() }));
    const { duplicate, value } = await runDeduplicatedRequest(cacheKey, async () => {
      let result = createLocalRuleExplanation(problem, { source: "image" });
      let source = "local rule";
      const willCallOpenAi = !result && isOpenAiConfigured();
      const { reservation } = await checkAndReserveUsage({
        req,
        identity,
        kind: "image",
        estimatedTokens: willCallOpenAi ? estimatedTokens : 0,
        estimatedCostMicros: willCallOpenAi ? estimatedCostMicros : 0,
      });
      let usage;
      let accumulatedAiUsage = null;
      let accumulatedAiCallCount = 0;

      try {
        if (result) {
          try {
            validateSolutionQualityWithDebug(result, { problem, requestId, stage: "local-rule-initial" });
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
              result = await createMathExplanation({
                prompt,
                image,
                originalProblem: problem,
                debugContext: {
                  requestId,
                  endpoint: "/api/explain-image",
                  normalizedProblem: problem,
                  promptHash,
                },
                onGeneratedResponseFailure: createGeneratedResponseFailureCapture({
                  requestId,
                  endpoint: "/api/explain-image",
                  prompt,
                  promptHash,
                  problem,
                  problemText: "",
                  repairAttempted: true,
                }),
              });
              accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(result));
              accumulatedAiCallCount += aiCallCountFrom(result);
              attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
              traceMathStage("Explanation generation", problem, result.extractedProblemLatex || result.expression || "", "LLM image solve response");
              result = applyLocalRulesToExplanation(result);
              validateSolutionQualityWithDebug(result, { problem, requestId, stage: "live-ai-initial" });
              source = "live AI call";
            } catch (firstError) {
              if ([
                "AI_SERVICE_UNAVAILABLE",
                "AI_PROVIDER_RATE_LIMITED",
                "AI_SERVICE_ERROR",
                "SERVER_CONFIG_ERROR",
              ].includes(firstError.code)) {
                throw firstError;
              }
              accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(firstError));
              accumulatedAiCallCount += aiCallCountFrom(firstError);
              const initialInvalidResult = result;
              const repairIssues = firstError.solutionIssues || [firstError.code || firstError.message];
              const repairFeedback = buildRepairFeedbackDetails(repairIssues, {
                error: firstError,
                currentResult: initialInvalidResult,
              });
              await captureSolveQualityFailure({
                error: firstError,
                result,
                stage: "initial",
                requestId,
                endpoint: "/api/explain-image",
                prompt,
                promptHash,
                problem: result?.extractedProblemLatex || result?.expression || problem,
                problemText: result?.extractedProblemText || "",
                repairAttempted: true,
                repairFeedback,
              });
              const repairPrompt = buildRepairSolvePrompt(prompt, repairIssues, {
                problem: result?.extractedProblemLatex || result?.expression || problem,
                previousResult: initialInvalidResult,
                error: firstError,
              });
              logSolveDebug("repair_retry", {
                requestId,
                endpoint: "/api/explain-image",
                retryCount: 1,
                failedRules: firstError.solutionIssues || [firstError.code || firstError.message].filter(Boolean),
                repairPromptHash: hashDebugText(repairPrompt),
              });
              const repairPromptHash = hashDebugText(repairPrompt);
              try {
                result = await createMathExplanation({
                  prompt: repairPrompt,
                  originalProblem: problem,
                  debugContext: {
                    requestId,
                    endpoint: "/api/explain-image",
                    normalizedProblem: problem,
                    promptHash: repairPromptHash,
                    retryPurpose: "quality-repair",
                  },
                  onGeneratedResponseFailure: createGeneratedResponseFailureCapture({
                    requestId,
                    endpoint: "/api/explain-image",
                    prompt: repairPrompt,
                    promptHash: repairPromptHash,
                    problem: result?.extractedProblemLatex || result?.expression || problem,
                    problemText: result?.extractedProblemText || "",
                    repairAttempted: true,
                  }),
                });
                accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(result));
                accumulatedAiCallCount += aiCallCountFrom(result);
                attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
                traceMathStage("Explanation generation", problem, result.extractedProblemLatex || result.expression || "", "LLM image repair solve response");
                result = applyLocalRulesToExplanation(result);
                validateSolutionQualityWithDebug(result, { problem, requestId, stage: "live-ai-repair" });
                source = "live AI repair call";
              } catch (repairError) {
                const failureUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(repairError));
                const failureCallCount = accumulatedAiCallCount + aiCallCountFrom(repairError);
                attachAccumulatedAiUsage(repairError, failureUsage, failureCallCount);
                await captureSolveQualityFailure({
                  error: repairError,
                  result,
                  stage: "repair",
                  requestId,
                  endpoint: "/api/explain-image",
                  prompt: repairPrompt,
                  promptHash: repairPromptHash,
                  problem: result?.extractedProblemLatex || result?.expression || problem,
                  problemText: result?.extractedProblemText || "",
                  repairAttempted: true,
                  repairFeedback: buildRepairFeedbackDetails(repairError.solutionIssues || [repairError.code || repairError.message], {
                    error: repairError,
                    previousResult: initialInvalidResult,
                    currentResult: result,
                  }),
                  previousResult: initialInvalidResult,
                });
                throw repairError;
              }
            }
          }
        }
        validateSolutionQualityWithDebug(result, { problem, requestId, stage: "pre-annotation-final" });
        const beforeAnnotation = result.extractedProblemLatex || result.expression || "";
        result = annotateMathExplanation(result);
        attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
        traceMathStage("Tokenization", beforeAnnotation, result.extractedProblemLatex || result.expression || "", "annotate image solution tokens/chunks");
        result.extractionValidation = validateExtraction({
          extractedProblemText: result.extractedProblemText,
          extractedProblemLatex: result.extractedProblemLatex || result.expression,
          ocrConfidence: fields.ocrConfidence,
        });
        result.confidence = result.extractionValidation.confidence;
        result.ocrConfidence = result.extractionValidation.ocrConfidence;
        result.mathIntegrityScore = result.extractionValidation.mathIntegrityScore;
        result.confidenceTier = result.extractionValidation.tier;
        logExtractionReviewDebug(result.extractionValidation);
        logImageUploadDebug("extracted", {
          extractedProblemText: result.extractedProblemText || "",
          extractedProblemLatex: result.extractedProblemLatex || result.expression || "",
          generatedProblemLatex: result.expression || "",
          firstStepLatex: result.steps?.[0]?.math || "",
          finalAnswerLatex: result.finalAnswerLatex || result.finalAnswer || "",
          extractionValidation: result.extractionValidation,
        });

        usage = await settleAiUsageReservation(reservation, result._aiUsage, {
          providerCalls: result._aiCallCount || 0,
          settlementReason: "success",
        });
      } catch (error) {
        try {
          usage = await settleFailureUsageOrRelease(reservation, error, result);
          if (usage) error.usage = usage;
        } catch (releaseError) {
          console.warn("Could not settle failed token reservation:", releaseError.message);
        }
        throw error;
      }

      setCachedExplanation(cacheKey, result);
      logAcceptedSolvePayload({
        requestId,
        endpoint: "/api/explain-image",
        problem,
        result,
        source,
      });
      logSolveTiming({
        endpoint: "/api/explain-image",
        startedAt,
        source,
        identity,
        prompt,
        aiUsage: result._aiUsage,
        apiCallCount: result._aiCallCount || (willCallOpenAi ? 1 : 0),
      });
      logExplanationSource({
        source,
        kind: "image",
        endpoint: "/api/explain-image",
        identity,
        prompt,
        aiUsage: result._aiUsage,
      });
      const saved = await saveExplanationBestEffort(req, { source: "image", problem, result });
      return { result, usage, saved, source };
    });

    const { result, usage, saved, source } = value;
    sendJson(
      res,
      200,
      buildResponse(result, {
        usage,
        saved,
        source: duplicate ? `${source} (deduplicated)` : source,
        demoMode: !isOpenAiConfigured(),
      }),
      createUsageHeaders(usage)
    );
    logSolveDebug("http_response", {
      requestId,
      endpoint: "/api/explain-image",
      statusCode: 200,
      source,
      finalUiState: "success-response-sent",
      stepCount: Array.isArray(result?.steps) ? result.steps.length : 0,
    });
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
    const stepHeading = typeof body.stepHeading === "string" ? body.stepHeading.slice(0, 300) : "";
    const cacheKey = buildLazyCacheKey(identity, {
      ...body,
      problemContext,
      stepLatex,
      selectedLatex,
      parentExpression,
      stepHeading,
    }, mode);
    const cached = getCachedExplanation(cacheKey);
    if (cached) {
      const usage = await getUsageForKind(req, "explanation", identity);
      sendJson(res, 200, { ...cached, usage, cached: true }, createUsageHeaders(usage));
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
          result = await createLazyTokenExplanation({ prompt, mode });
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
        title: result.title,
        explanation: result.explanation,
      };
      setCachedExplanation(cacheKey, payload);
      logExplanationSource({
        source: isOpenAiConfigured() ? "live AI call" : "local fallback",
        kind: mode,
        endpoint: mode === "pin" ? "/api/explain-pin" : "/api/explain-token",
        identity,
        prompt,
        aiUsage: result.usage,
      });
      return { payload, usage };
    });

    const responseUsage = duplicate ? await getUsageForKind(req, "explanation", identity) : value.usage;
    sendJson(res, 200, { ...value.payload, usage: responseUsage, cached: duplicate }, createUsageHeaders(responseUsage));
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
    const canonicalProblem = normalizeCanonicalProblem(body, { source: "typed" });
    const problemLatex = requireShortText(
      getCanonicalSolverInput(canonicalProblem, body.problemLatex || body.problem),
      "Problem LaTeX",
      MAX_PROBLEM_CHARS
    );
    logCanonicalProblem("solve request", canonicalProblem, { endpoint: "/api/compare-methods" });
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
      sendJson(res, 200, {
        ...cached,
        canonicalProblem,
        canonicalInputHash: canonicalProblem.hash,
        usage,
        cached: true,
      }, createUsageHeaders(usage));
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
        result = await createCompareMethods({ prompt });
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
      prompt,
      aiUsage: result.usage,
    });
    sendJson(res, 200, { ...payload, usage, cached: false }, createUsageHeaders(usage));
  });
}

export async function handleExplainFollowupRequest(req, res) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  await runHandler(res, async () => {
    const body = requireObject(await readJson(req));
    console.info("[omnimath:followup-request]", {
      route: "/api/explain-followup",
      bodyKeys: Object.keys(body),
      selectedLatex: body.selectedLatex || body.selectedText || "",
      selectedText: body.selectedText || "",
      hasPinnedExplanation: Boolean(body.pinnedExplanation),
      hasSolutionContext: Boolean(body.solution),
      hasCurrentStep: Boolean(body.currentStep),
      historyCount: Array.isArray(body.history) ? body.history.length : 0,
    });
    const identityResult = await resolveFollowupIdentity(req);
    const identity = identityResult.identity || identityResult;
    throttleRequest(req, identity, "ai");
    assertAiEnabled();
    const history = parseFollowupHistory(body.history);
    const prompt = buildFollowupPrompt(body, history);
    const { reservation, usage: reservedUsage, fallbackReason } = await reserveFollowupUsage(req, identity, prompt);
    let answer;
    let aiUsage;
    let usage = reservedUsage;

    try {
      if (!isOpenAiConfigured()) {
        const configError = createOpenAiRequiredError();
        console.warn("[omnimath:followup-fallback]", {
          reason: "OpenAI unavailable",
          code: configError.code,
          message: configError.message,
        });
        answer = createFollowupFallbackAnswer(body, history, "local pinned context");
      } else {
        try {
          const result = await createFollowupAnswer({ prompt });
          answer = result.text;
          aiUsage = result.usage;
        } catch (openAiError) {
          if (!isProductionRuntime()) {
            console.warn("[omnimath:followup-fallback]", {
              reason: "OpenAI request failed",
              code: openAiError.code,
              message: openAiError.message,
              statusCode: openAiError.statusCode || null,
            });
            answer = createFollowupFallbackAnswer(body, history, "local pinned context after AI failure");
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
      prompt,
      aiUsage,
    });
    sendJson(res, 200, {
      answer,
      usage,
      fallback: !aiUsage,
      fallbackReason: !aiUsage
        ? (fallbackReason || identityResult.fallbackReason || "OPENAI_API_KEY is not configured on the server.")
        : undefined,
    }, createUsageHeaders(usage));
  });
}

export async function handleSessionsRequest(req, res) {
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "PUT") {
    sendMethodNotAllowed(res, ["GET", "POST", "PUT"]);
    return;
  }

  await runHandler(res, async () => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET") {
      const data = await getCurrentUserSessions(req);
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

    const sessionId = url.searchParams.get("id") || body.id || body.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      throw createBadInputError("Session id is required.");
    }

    const data = await updateUserSessionForRequest(req, sessionId, session);
    sendJson(res, 200, data);
  });
}

export async function handleUsageRequest(req, res) {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, ["GET"]);
    return;
  }

  await runHandler(res, async () => {
    const identity = await requireClerkIdentity(req);
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
