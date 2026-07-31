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
import {
  analyzeNumericExpression,
  createMethodFingerprint,
  finalValueExpression,
  numericalFinalAnswerCheck,
} from "./mathValidationAnalysis.js";
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
  getCanonicalDisplayText,
  getCanonicalDisplayTextSource,
  getCanonicalMathInput,
  getCanonicalMathInputSource,
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

function validateSolutionQualityWithDebug(result, { problem = "", requestId = "", stage = "quality-validation" } = {}) {
  const ruleEvaluations = [];
  const symbolProblem = problemForSymbolDiagnostics(problem, result);
  const symbolDiagnostics = analyzeSymbolOrigins(symbolProblem, result);
  if (isSolveDebugEnabled()) {
    const rawFinalAnswerLatex = result?.finalAnswerLatex || result?.finalAnswer || "";
    const extractedRhsExpression = finalValueExpression(rawFinalAnswerLatex);
    const numericParserOutput = analyzeNumericExpression(rawFinalAnswerLatex);
    const numericalCrossCheckTrace = numericalFinalAnswerCheck(problem, result);
    logSolveDebug("numeric_final_answer_trace", {
      requestId,
      stage,
      rawFinalAnswerLatex,
      extractedRhsExpression,
      normalizedExpression: numericParserOutput.normalized || "",
      numericParserOutput,
      numericEvaluatorOutput: numericParserOutput.status === "evaluable" ? numericParserOutput.value : null,
      numericFinalAnswerAnalysis: numericParserOutput,
      numericFinalAnswerAnalysisValue: numericParserOutput.value ?? null,
      valuePassedIntoNumericalFinalAnswerCrossCheck: rawFinalAnswerLatex,
      proposedValueInsideNumericalFinalAnswerCrossCheck: numericalCrossCheckTrace.proposedValue,
      finalComparisonValues: {
        numericalEstimate: numericalCrossCheckTrace.numericalEstimate,
        proposedValue: numericalCrossCheckTrace.proposedValue,
        absoluteDifference: numericalCrossCheckTrace.absoluteDifference,
        relativeDifference: numericalCrossCheckTrace.relativeDifference,
        tolerance: numericalCrossCheckTrace.tolerance,
        issue: numericalCrossCheckTrace.issue,
        diagnosticIssue: numericalCrossCheckTrace.diagnosticIssue,
      },
    });
  }
  logSolveDebug("symbol_inventory", {
    requestId,
    stage,
    normalizedOriginalProblem: symbolProblem,
    originalSymbolInventory: symbolDiagnostics.originalSymbols,
    generatedSymbolInventory: symbolDiagnostics.generatedSymbols,
    newlyIntroducedSymbols: symbolDiagnostics.newlyIntroducedSymbols,
    explicitDefinitions: symbolDiagnostics.explicitDefinitions,
    unexplainedSymbols: symbolDiagnostics.unexplainedSymbols,
    boundSymbolProvenance: symbolDiagnostics.boundSymbolProvenance,
    fieldClassifications: symbolDiagnostics.fieldReports.map((field) => ({
      fieldPath: field.fieldPath,
      symbols: field.symbols,
      unexplainedSymbols: field.unexplainedSymbols,
      boundSymbolProvenance: field.boundSymbolProvenance,
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
    boundSymbolProvenance: symbolDiagnostics.boundSymbolProvenance,
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

function isStructuralRepairIssue(issue = "") {
  const normalized = String(issue || "").trim();
  return STRUCTURAL_REPAIR_ISSUES.has(normalized)
    || normalized.startsWith("unexplained_generated_symbol:")
    || normalized.startsWith("invalid_latex:")
    || normalized.startsWith("strict_generated_latex:");
}

export function categorizeRepairIssues(issues = []) {
  const normalizedIssues = normalizeRepairIssueList(issues);
  if (normalizedIssues.length === 0) {
    return {
      category: "mathematical",
      structuralIssues: [],
      mathematicalIssues: [],
      unknownIssues: [],
    };
  }
  const structuralIssues = normalizedIssues.filter(isStructuralRepairIssue);
  const nonStructuralIssues = normalizedIssues.filter((issue) => !isStructuralRepairIssue(issue));
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

function numberOrNull(value) {
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

export function buildFreshEscalationSolvePrompt({
  problem = "",
  canonicalLatex = "",
  canonicalText = "",
  issues = [],
  error = null,
  previousResult = null,
} = {}) {
  const originalProblem = sanitizeRepairPromptText(problem || canonicalLatex || canonicalText, 2400)
    || "Use the canonical problem below.";
  const trustedLatex = sanitizeRepairPromptText(canonicalLatex || problem, 2400);
  const trustedText = sanitizeRepairPromptText(canonicalText || "", 2000);
  const failureSummary = compactEscalationFailureSummary(error || {}, issues, previousResult);

  return `You are OmniMath, a careful AI math tutor solving an escalated problem independently.

Fresh escalation task:
- Solve the canonical original problem from scratch.
- Do not repair or continue the previous derivation.
- Do not preserve previous constants, substitutions, final answers, special functions, or numerical claims unless you rederive them from the original problem.
- Use the validator findings only to avoid repeating known invalid reasoning.
- Treat any trusted numerical estimate as a validation constraint, not as a derivation.
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
    repairCategory: categorizeRepairIssues(issueCodes).category,
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
  const repairCategorization = categorizeRepairIssues(failedRules);
  if (repairCategorization.category === "structural") {
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
- Keep finalAnswerLatex structurally valid as one standalone final expression.

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

// Only provider content-generation failures permit a retained candidate fallback.
// Transport, availability, rate-limit, authentication, and server-configuration errors
// continue through the existing failure and accounting paths unchanged.
const FALLBACK_PERMITTED_LATER_ERROR_CODES = new Set([
  "AI_RESPONSE_INVALID",
  "AI_RESPONSE_TRUNCATED",
  "AI_REQUEST_REFUSED",
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

function candidateSource(baseSource = "initial", result = {}) {
  const compact = Boolean(result?._omniOpenAiDiagnostics?.compactFallback);
  if (!compact || baseSource === "initial") return baseSource;
  return `${baseSource}-compact`;
}

function failedCandidateStage(baseSource = "initial", error = {}) {
  const attemptType = String(error?._omniOpenAiDiagnostics?.attemptType || "").toLowerCase();
  return attemptType.includes("compact") && baseSource !== "initial"
    ? `${baseSource}-compact`
    : baseSource;
}

export function classifySolveCandidate({
  source = "initial",
  result = null,
  error = null,
  parseSchemaSuccess = Boolean(result),
  accepted = !error,
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
  const fallbackEligible = Boolean(
    parseSchemaSuccess
    && result
    && completeness.hasFinalAnswer
    && issueCodes.length > 0
    && issueClassifications.every((issue) => issue.fallbackEligible)
    && !affirmativeMathematicalFailure
    && !numericalMismatch
    && !knownIncorrectFinalAnswer
  );
  return {
    source,
    result,
    parseSchemaSuccess: Boolean(parseSchemaSuccess),
    qualityIssueCodes: issueCodes,
    issueClassifications,
    affirmativeMathematicalFailure,
    numericalMismatch,
    numericalAgreement,
    numericalStatus: numericalMismatch ? "mismatch" : numericalAgreement ? "agreement" : "no_contradiction",
    structuralRecovery,
    completeness,
    accepted: Boolean(accepted),
    rejectionReason: accepted
      ? null
      : !parseSchemaSuccess
        ? "parse_or_schema_failed"
        : affirmativeMathematicalFailure
          ? "affirmative_mathematical_failure"
          : numericalMismatch
            ? "numerical_mismatch"
            : knownIncorrectFinalAnswer
              ? "known_incorrect_final_answer"
              : fallbackEligible
                ? "quality_rejected_fallback_safe"
                : "quality_rejected_not_fallback_safe",
    fallbackEligible,
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

function canUseSafeFallbackForError(error = {}) {
  return FALLBACK_PERMITTED_LATER_ERROR_CODES.has(error?.code);
}

function candidateDiagnostic(candidate = {}) {
  return {
    source: candidate.source || null,
    parseSchemaSuccess: Boolean(candidate.parseSchemaSuccess),
    qualityIssueCodes: candidate.qualityIssueCodes || [],
    issueClassifications: (candidate.issueClassifications || []).map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      fallbackEligible: issue.fallbackEligible,
    })),
    affirmativeMathematicalFailure: Boolean(candidate.affirmativeMathematicalFailure),
    knownIncorrectFinalAnswer: Boolean(candidate.knownIncorrectFinalAnswer),
    numericalStatus: candidate.numericalStatus || null,
    structuralRecovery: Boolean(candidate.structuralRecovery),
    completenessScore: Number(candidate.completeness?.score || 0),
    accepted: Boolean(candidate.accepted),
    rejectionReason: candidate.rejectionReason || null,
    fallbackEligible: Boolean(candidate.fallbackEligible),
  };
}

function recordSolveCandidate(ledger, candidate, { requestId = "", endpoint = "" } = {}) {
  if (!candidate?.result || !candidate.parseSchemaSuccess) return null;
  ledger.push(candidate);
  const diagnostic = candidateDiagnostic(candidate);
  logSolveDebug("solve_candidate_recorded", { requestId, endpoint, ...diagnostic });
  logSolveDebug(candidate.accepted ? "solve_candidate_accepted" : "solve_candidate_rejected", {
    requestId,
    endpoint,
    ...diagnostic,
  });
  logSolveDebug("solve_candidate_fallback_eligibility", {
    requestId,
    endpoint,
    source: candidate.source,
    fallbackEligible: candidate.fallbackEligible,
    reason: candidate.fallbackEligible ? "safe_fallback_floor_passed" : candidate.rejectionReason,
    qualityIssueCodes: candidate.qualityIssueCodes,
  });
  return candidate;
}

function selectSafeFallbackAfterFailure(ledger, error, {
  requestId = "",
  endpoint = "",
  failedStage = "",
} = {}) {
  const permittedError = canUseSafeFallbackForError(error);
  const selected = permittedError ? selectBestSafeSolveCandidate(ledger) : null;
  if (selected) {
    logSolveDebug("solve_fallback_selected", {
      requestId,
      endpoint,
      laterFailedStage: failedStage,
      laterErrorCode: error?.code || null,
      selectedCandidateSource: selected.source,
      qualityIssueCodes: selected.qualityIssueCodes,
    });
    return selected;
  }
  logSolveDebug("solve_fallback_rejected", {
    requestId,
    endpoint,
    laterFailedStage: failedStage,
    laterErrorCode: error?.code || null,
    reason: permittedError ? "no_safe_candidate" : "later_error_category_not_permitted",
    candidateSources: ledger.map((candidate) => candidate.source),
  });
  return null;
}

function attachDegradedFallbackMetadata(result, metadata = {}) {
  if (!result || typeof result !== "object") return result;
  Object.defineProperty(result, "_omniDegradedFallback", {
    enumerable: false,
    configurable: true,
    value: {
      selected: true,
      source: metadata.source || null,
      failedLaterStage: metadata.failedLaterStage || null,
      laterErrorCode: metadata.laterErrorCode || null,
    },
  });
  return result;
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

function buildCanonicalSolvePromptProblem({ displayText = "", mathInput = "" } = {}) {
  const display = typeof displayText === "string" ? displayText.trim() : "";
  const math = typeof mathInput === "string" ? mathInput.trim() : "";
  if (display && math && display !== math) {
    return `Human-readable problem:\n${display}\n\nCanonical mathematical form:\n${math}`;
  }
  return math || display;
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
      actualReasoningTokens: normalizedUsage.reasoningTokens,
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
  const degradedFallback = result?._omniDegradedFallback || null;
  return {
    ...result,
    canonicalProblem: canonicalProblem || result.canonicalProblem || null,
    canonicalInputHash: canonicalProblem?.hash || result.canonicalProblem?.hash || null,
    usage,
    savedExplanationId: saved?.id,
    runtime: {
      source,
      demoMode,
      saveWarning: saved?.warning || null,
      ...(degradedFallback?.selected ? {
        degradedFallback: true,
        degradedFallbackSource: degradedFallback.source || null,
        failedLaterStage: degradedFallback.failedLaterStage || null,
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
    id: typeof session.id === "string" ? session.id.trim().slice(0, 80) : "",
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
    const saved = await saveExplanationForRequest(req, details);
    if (!saved && requestHasExpiredBearerToken(req)) {
      console.warn("[omnimath:save-auth-warning]", {
        operation: "saveExplanationBestEffort",
        reason: "token-expired",
      });
      return createExpiredSaveWarning();
    }
    return saved;
  } catch (error) {
    if (isClerkTokenExpiredError(error) || requestHasExpiredBearerToken(req)) {
      console.warn("[omnimath:save-auth-warning]", {
        operation: "saveExplanationBestEffort",
        reason: "token-expired",
        code: error.code,
        message: error.message,
      });
      return createExpiredSaveWarning();
    }
    console.warn("[omnimath:save-warning]", {
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
      const saved = await saveExplanationBestEffort(req, { source: "text", problem, result, identity });
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
    const canonicalMathInput = requireTextProblem(getCanonicalMathInput(canonicalProblem));
    const reviewedProblemText = optionalShortText(body.problemText || body.extractedProblemText || "", "Problem text", MAX_PROBLEM_CHARS);
    const canonicalDisplayText = getCanonicalDisplayText(canonicalProblem, reviewedProblemText);
    const canonicalMathInputSource = getCanonicalMathInputSource(canonicalProblem);
    const canonicalDisplaySource = getCanonicalDisplayTextSource(canonicalProblem, reviewedProblemText);
    const problemLatex = canonicalMathInput;
    const problemText = reviewedProblemText;
    const solveDecision = ["direct", "anyway", "edited"].includes(body.solveDecision)
      ? body.solveDecision
      : "direct";
    logCanonicalProblem("solve request", canonicalProblem, {
      endpoint: "/api/solve-extracted-problem",
      solveDecision,
      canonicalDisplaySource,
      canonicalMathInputSource,
    });
    const promptProblem = buildCanonicalSolvePromptProblem({
      displayText: canonicalDisplayText,
      mathInput: canonicalMathInput,
    });
    const prompt = buildMathExplanationPrompt({ problem: promptProblem });
    const promptHash = hashDebugText(prompt);
    logImageUploadDebug("solve-extracted-input", {
      problemChars: problemLatex.length,
      problemPreview: problemLatex.slice(0, 240),
      problemTextChars: problemText.length,
      problemTextPreview: problemText.slice(0, 240),
      canonicalTextChars: (canonicalProblem.canonicalText || "").length,
      canonicalLatexChars: (canonicalProblem.canonicalLatex || "").length,
      canonicalDisplaySource,
      canonicalMathInputSource,
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
      canonicalText: canonicalProblem.canonicalText || "",
      canonicalLatex: canonicalProblem.canonicalLatex || "",
      canonicalDisplaySource,
      canonicalMathInputSource,
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
      const solveMetrics = {
        initialSuccess: false,
        repairSuccess: false,
        escalationAttempted: false,
        escalationSuccess: false,
        finalFailure: false,
      };
      const candidateLedger = [];
      let degradedFallbackMetadata = null;
      const candidateContext = {
        requestId,
        endpoint: "/api/solve-extracted-problem",
      };
      const retainCandidate = ({
        resolvedSource,
        candidateResult,
        error = null,
        accepted = !error,
      }) => recordSolveCandidate(candidateLedger, classifySolveCandidate({
        source: resolvedSource,
        result: candidateResult,
        error,
        parseSchemaSuccess: Boolean(candidateResult),
        accepted,
      }), candidateContext);
      const adoptSafeFallback = (selected, laterError, failedLaterStage, totalUsage, totalCallCount) => {
        if (!selected) return false;
        result = selected.result;
        accumulatedAiUsage = totalUsage;
        accumulatedAiCallCount = totalCallCount;
        degradedFallbackMetadata = {
          source: selected.source,
          failedLaterStage,
          laterErrorCode: laterError?.code || null,
        };
        attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
        attachDegradedFallbackMetadata(result, degradedFallbackMetadata);
        source = `live AI ${selected.source} degraded fallback`;
        solveMetrics.finalFailure = false;
        return true;
      };

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
          let initialCandidateResult = null;
          let initialResolvedSource = "initial";
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
                canonicalDisplayText,
                canonicalDisplaySource,
                canonicalMathInput,
                canonicalMathInputSource,
                extraction,
                repairAttempted: true,
              }),
            });
            accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(result));
            accumulatedAiCallCount += aiCallCountFrom(result);
            attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
            initialResolvedSource = candidateSource("initial", result);
            traceMathStage("Explanation generation", problemLatex, result.expression || result.problem || "", "LLM solve response");
            result = applyLocalRulesToExplanation(result);
            initialCandidateResult = result;
            validateSolutionQualityWithDebug(result, { problem: problemLatex, requestId, stage: "live-ai-initial" });
            retainCandidate({
              resolvedSource: initialResolvedSource,
              candidateResult: initialCandidateResult,
              accepted: true,
            });
            solveMetrics.initialSuccess = true;
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
            if (isSolutionQualityValidationError(firstError) && initialCandidateResult) {
              retainCandidate({
                resolvedSource: initialResolvedSource,
                candidateResult: initialCandidateResult,
                error: firstError,
                accepted: false,
              });
            }
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
              canonicalDisplayText,
              canonicalDisplaySource,
              canonicalMathInput,
              canonicalMathInputSource,
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
            let repairCandidateResult = null;
            let repairResolvedSource = "repair";
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
                  canonicalDisplayText,
                  canonicalDisplaySource,
                  canonicalMathInput,
                  canonicalMathInputSource,
                  extraction,
                  repairAttempted: true,
                }),
              });
              accumulatedAiUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(result));
              accumulatedAiCallCount += aiCallCountFrom(result);
              attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
              repairResolvedSource = candidateSource("repair", result);
              traceMathStage("Explanation generation", problemLatex, result.expression || result.problem || "", "LLM repair solve response");
              result = applyLocalRulesToExplanation(result);
              repairCandidateResult = result;
              validateSolutionQualityWithDebug(result, { problem: problemLatex, requestId, stage: "live-ai-repair" });
              retainCandidate({
                resolvedSource: repairResolvedSource,
                candidateResult: repairCandidateResult,
                accepted: true,
              });
              solveMetrics.repairSuccess = true;
              source = "live AI repair call";
            } catch (repairError) {
              if (isSolutionQualityValidationError(repairError) && repairCandidateResult) {
                retainCandidate({
                  resolvedSource: repairResolvedSource,
                  candidateResult: repairCandidateResult,
                  error: repairError,
                  accepted: false,
                });
              }
              const failureUsage = mergeOpenAiUsageValues(accumulatedAiUsage, aiUsageFrom(repairError));
              const failureCallCount = accumulatedAiCallCount + aiCallCountFrom(repairError);
              attachAccumulatedAiUsage(repairError, failureUsage, failureCallCount);
              const escalationDecision = decideSolveEscalation(repairError, { afterRepairAttempt: true });
              if (escalationDecision.shouldEscalate) {
                solveMetrics.escalationAttempted = true;
                const escalationModel = getOpenAiModelForPath("escalation");
                const escalationStartedAt = Date.now();
                const escalationRepairFeedback = {
                  ...buildRepairFeedbackDetails(repairError.solutionIssues || [repairError.code || repairError.message], {
                    error: repairError,
                    previousResult: initialInvalidResult,
                    currentResult: result,
                  }),
                  escalation: {
                    attempted: true,
                    reason: escalationDecision.reason,
                    triggeringValidatorIssues: escalationDecision.triggeringValidatorIssues,
                    model: escalationModel,
                    elapsedMs: 0,
                    success: null,
                  },
                  metrics: { ...solveMetrics },
                };
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
                  canonicalDisplayText,
                  canonicalDisplaySource,
                  canonicalMathInput,
                  canonicalMathInputSource,
                  extraction,
                  repairAttempted: true,
                  repairFeedback: escalationRepairFeedback,
                  previousResult: initialInvalidResult,
                });
                const escalationPrompt = buildFreshEscalationSolvePrompt({
                  problem: problemLatex,
                  canonicalLatex: canonicalMathInput || canonicalProblem.canonicalLatex || problemLatex,
                  canonicalText: canonicalDisplayText || canonicalProblem.canonicalText || problemText,
                  issues: escalationDecision.triggeringValidatorIssues,
                  previousResult: result,
                  error: repairError,
                });
                const escalationPromptHash = hashDebugText(escalationPrompt);
                let escalationAttemptUsage = null;
                let escalationAttemptCallCount = 0;
                let escalationCandidateResult = null;
                let escalationResolvedSource = "escalation";
                logSolveDebug(escalationDecision.reason === "structural_recovery_after_failed_repair" ? "structural_recovery_retry" : "escalation_retry", {
                  requestId,
                  endpoint: "/api/solve-extracted-problem",
                  reason: escalationDecision.reason,
                  triggeringValidatorIssues: escalationDecision.triggeringValidatorIssues,
                  model: escalationModel,
                  escalationPromptHash,
                });
                try {
                  result = await createMathExplanation({
                    prompt: escalationPrompt,
                    originalProblem: problemLatex,
                    modelPath: "escalation",
                    debugContext: {
                      requestId,
                      endpoint: "/api/solve-extracted-problem",
                      normalizedProblem: problemLatex,
                      promptHash: escalationPromptHash,
                      retryPurpose: escalationDecision.reason === "structural_recovery_after_failed_repair"
                        ? "quality-structural-recovery"
                        : "quality-escalation",
                      attemptType: "escalation",
                    },
                    onGeneratedResponseFailure: createGeneratedResponseFailureCapture({
                      requestId,
                      endpoint: "/api/solve-extracted-problem",
                      prompt: escalationPrompt,
                      promptHash: escalationPromptHash,
                      problem: problemLatex,
                      problemText,
                      canonicalProblem,
                      canonicalDisplayText,
                      canonicalDisplaySource,
                      canonicalMathInput,
                      canonicalMathInputSource,
                      extraction,
                      repairAttempted: true,
                    }),
                  });
                  escalationAttemptUsage = aiUsageFrom(result);
                  escalationAttemptCallCount = aiCallCountFrom(result);
                  accumulatedAiUsage = mergeOpenAiUsageValues(failureUsage, escalationAttemptUsage);
                  accumulatedAiCallCount = failureCallCount + escalationAttemptCallCount;
                  attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
                  escalationResolvedSource = candidateSource("escalation", result);
                  traceMathStage(
                    "Explanation generation",
                    problemLatex,
                    result.expression || result.problem || "",
                    escalationDecision.reason === "structural_recovery_after_failed_repair"
                      ? "LLM structural recovery solve response"
                      : "LLM escalated solve response"
                  );
                  result = applyLocalRulesToExplanation(result);
                  escalationCandidateResult = result;
                  validateSolutionQualityWithDebug(result, { problem: problemLatex, requestId, stage: "live-ai-escalation" });
                  retainCandidate({
                    resolvedSource: escalationResolvedSource,
                    candidateResult: escalationCandidateResult,
                    accepted: true,
                  });
                  solveMetrics.escalationSuccess = true;
                  logSolveDebug("solve_metrics", {
                    requestId,
                    endpoint: "/api/solve-extracted-problem",
                    ...solveMetrics,
                    finalFailure: false,
                    escalationReason: escalationDecision.reason,
                    triggeringValidatorIssues: escalationDecision.triggeringValidatorIssues,
                    escalationModel,
                    escalationElapsedMs: Date.now() - escalationStartedAt,
                  });
                  source = escalationDecision.reason === "structural_recovery_after_failed_repair"
                    ? "live AI structural recovery call"
                    : "live AI escalation call";
                } catch (escalationError) {
                  if (isSolutionQualityValidationError(escalationError) && escalationCandidateResult) {
                    retainCandidate({
                      resolvedSource: escalationResolvedSource,
                      candidateResult: escalationCandidateResult,
                      error: escalationError,
                      accepted: false,
                    });
                  }
                  const failedAttemptUsage = aiUsageFrom(escalationError) || escalationAttemptUsage;
                  const failedAttemptCallCount = aiCallCountFrom(escalationError) || escalationAttemptCallCount;
                  const escalationUsage = mergeOpenAiUsageValues(failureUsage, failedAttemptUsage);
                  const escalationCallCount = failureCallCount + failedAttemptCallCount;
                  attachAccumulatedAiUsage(escalationError, escalationUsage, escalationCallCount);
                  const failedEscalationStage = failedCandidateStage("escalation", escalationError);
                  const selectedFallback = selectSafeFallbackAfterFailure(candidateLedger, escalationError, {
                    ...candidateContext,
                    failedStage: failedEscalationStage,
                  });
                  const fallbackAdopted = adoptSafeFallback(
                    selectedFallback,
                    escalationError,
                    failedEscalationStage,
                    escalationUsage,
                    escalationCallCount,
                  );
                  solveMetrics.finalFailure = !fallbackAdopted;
                  const escalationElapsedMs = Date.now() - escalationStartedAt;
                  logSolveDebug("solve_metrics", {
                    requestId,
                    endpoint: "/api/solve-extracted-problem",
                    ...solveMetrics,
                    escalationReason: escalationDecision.reason,
                    triggeringValidatorIssues: escalationDecision.triggeringValidatorIssues,
                    escalationModel,
                    escalationElapsedMs,
                  });
                  await captureSolveQualityFailure({
                    error: escalationError,
                    result,
                    stage: "escalation",
                    requestId,
                    endpoint: "/api/solve-extracted-problem",
                    prompt: escalationPrompt,
                    promptHash: escalationPromptHash,
                    problem: problemLatex,
                    problemText,
                    canonicalProblem,
                    canonicalDisplayText,
                    canonicalDisplaySource,
                    canonicalMathInput,
                    canonicalMathInputSource,
                    extraction,
                    repairAttempted: true,
                    repairFeedback: {
                      ...buildRepairFeedbackDetails(escalationError.solutionIssues || [escalationError.code || escalationError.message], {
                        error: escalationError,
                        previousResult: initialInvalidResult,
                        currentResult: result,
                      }),
                      escalation: {
                        attempted: true,
                        reason: escalationDecision.reason,
                        triggeringValidatorIssues: escalationDecision.triggeringValidatorIssues,
                        model: escalationModel,
                        tokenUsage: failedAttemptUsage || null,
                        elapsedMs: escalationElapsedMs,
                        success: false,
                      },
                      metrics: { ...solveMetrics },
                    },
                    previousResult: initialInvalidResult,
                  });
                  if (!fallbackAdopted) throw escalationError;
                }
              } else {
                const failedRepairStage = failedCandidateStage("repair", repairError);
                const selectedFallback = selectSafeFallbackAfterFailure(candidateLedger, repairError, {
                  ...candidateContext,
                  failedStage: failedRepairStage,
                });
                const fallbackAdopted = adoptSafeFallback(
                  selectedFallback,
                  repairError,
                  failedRepairStage,
                  failureUsage,
                  failureCallCount,
                );
                solveMetrics.finalFailure = !fallbackAdopted;
                logSolveDebug("solve_metrics", {
                  requestId,
                  endpoint: "/api/solve-extracted-problem",
                  ...solveMetrics,
                  escalationReason: escalationDecision.reason,
                  triggeringValidatorIssues: escalationDecision.triggeringValidatorIssues,
                });
              }
              if (escalationDecision.shouldEscalate) {
                // Escalation succeeded and result/source have been updated.
              } else {
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
                  canonicalDisplayText,
                  canonicalDisplaySource,
                  canonicalMathInput,
                  canonicalMathInputSource,
                  extraction,
                  repairAttempted: true,
                  repairFeedback: buildRepairFeedbackDetails(repairError.solutionIssues || [repairError.code || repairError.message], {
                    error: repairError,
                    previousResult: initialInvalidResult,
                    currentResult: result,
                  }),
                  previousResult: initialInvalidResult,
                });
                if (!degradedFallbackMetadata) throw repairError;
              }
            }
          }
        }
        if (!degradedFallbackMetadata) {
          validateSolutionQualityWithDebug(result, { problem: problemLatex, requestId, stage: "pre-annotation-final" });
        }
        const beforeAnnotation = result.expression || result.problem || problemLatex;
        result = annotateMathExplanation(result);
        attachAccumulatedAiUsage(result, accumulatedAiUsage, accumulatedAiCallCount);
        if (degradedFallbackMetadata) {
          attachDegradedFallbackMetadata(result, degradedFallbackMetadata);
        }
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
      const saved = await saveExplanationBestEffort(req, { source: "image", problem: problemLatex, result, identity });
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
      const saved = await saveExplanationBestEffort(req, { source: "image", problem, result, identity });
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
        prompt,
        aiUsage: result.usage,
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
