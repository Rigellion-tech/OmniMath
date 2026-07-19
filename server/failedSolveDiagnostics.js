import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DIAGNOSTIC_DIR = path.join("logs", "failed-solves");
const MAX_RAW_OUTPUT_CHARS = 160000;
const MAX_PROMPT_CHARS = 100000;

function isCaptureEnabled() {
  return process.env.OMNIMATH_CAPTURE_FAILED_SOLVES === "1";
}

function safeString(value = "") {
  return typeof value === "string" ? value : String(value || "");
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function slug(value = "") {
  return safeString(value)
    .replace(/^\/api\//, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "solve";
}

function shortId(value = "") {
  const safe = slug(value).slice(0, 32);
  return safe || crypto.randomUUID().slice(0, 8);
}

function truncateString(value = "", maxChars = MAX_RAW_OUTPUT_CHARS) {
  const text = safeString(value);
  if (text.length <= maxChars) {
    return {
      text,
      truncated: false,
      chars: text.length,
    };
  }
  return {
    text: text.slice(0, maxChars),
    truncated: true,
    chars: text.length,
  };
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name || "Error",
    message: error.message || "",
    stack: error.stack || "",
    code: error.code || null,
    statusCode: error.statusCode || null,
    publicMessage: error.publicMessage || null,
    compactRetryable: error.compactRetryable ?? null,
    responseFailureType: error.responseFailureType || null,
    solutionIssues: Array.isArray(error.solutionIssues) ? error.solutionIssues : [],
    latexValidationIssues: Array.isArray(error.latexValidationIssues) ? error.latexValidationIssues : [],
    providerStatus: error.providerStatus || null,
    providerCode: error.providerCode || null,
    networkCauseCode: error.networkCauseCode || null,
    networkCauseMessage: error.networkCauseMessage || null,
  };
}

function safeJsonClone(value) {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (typeof item === "undefined") return "__undefined__";
    if (item instanceof Error) return serializeError(item);
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`;
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  }));
}

function relevantResponseMetadata(diagnostics = {}) {
  return {
    responseId: diagnostics.responseId || null,
    responseModel: diagnostics.responseModel || null,
    responseStatus: diagnostics.responseStatus || null,
    finishReason: diagnostics.finishReason || null,
    incompleteDetails: diagnostics.incompleteDetails || null,
    rawOutputHash: diagnostics.rawOutputHash || null,
    rawOutputChars: diagnostics.rawOutputChars ?? null,
    usage: diagnostics.usage || null,
  };
}

function summarizeUsageSettlement({ result = null, error = null, diagnostics = {} } = {}) {
  const usage = error?._aiUsage || result?._aiUsage || diagnostics.usage || null;
  const providerCalls = Number.isFinite(error?._aiCallCount)
    ? Math.max(0, Number(error._aiCallCount))
    : Number.isFinite(result?._aiCallCount)
      ? Math.max(0, Number(result._aiCallCount))
      : usage
        ? 1
        : 0;
  const inputTokens = Number(usage?.input_tokens || usage?.prompt_tokens || 0);
  const outputTokens = Number(usage?.output_tokens || usage?.completion_tokens || 0);
  const totalTokens = Number(usage?.total_tokens || 0) || inputTokens + outputTokens;
  if (!usage && providerCalls === 0) return null;
  return {
    providerCalls,
    actualInputTokens: Math.max(0, Math.ceil(inputTokens || 0)),
    actualOutputTokens: Math.max(0, Math.ceil(outputTokens || 0)),
    actualTotalTokens: Math.max(0, Math.ceil(totalTokens || 0)),
    settlementReason: error ? "failure" : "unknown",
  };
}

function buildArtifact({
  requestId = "",
  endpoint = "",
  stage = "initial",
  prompt = "",
  promptHash = "",
  result = null,
  error = null,
  input = {},
  validation = {},
} = {}) {
  const diagnostics = result?._omniOpenAiDiagnostics || error?._omniOpenAiDiagnostics || {};
  const rawOutput = truncateString(diagnostics.rawOutput || diagnostics.rawOutputText || error?.invalidOutputText || "", MAX_RAW_OUTPUT_CHARS);
  const promptText = truncateString(prompt || diagnostics.promptText || "", MAX_PROMPT_CHARS);
  const solutionIssues = Array.isArray(error?.solutionIssues)
    ? error.solutionIssues
    : Array.isArray(validation.solutionIssues)
      ? validation.solutionIssues
      : [];
  const latexValidationIssues = Array.isArray(error?.latexValidationIssues)
    ? error.latexValidationIssues
    : Array.isArray(validation.latexValidationIssues)
      ? validation.latexValidationIssues
      : [];
  const exactFailedRule = solutionIssues[0] || error?.code || error?.message || null;
  const responseFailureType = error?.responseFailureType || validation.responseFailureType || diagnostics.responseFailureType || null;
  const validationContext = error?.solutionValidationContext || validation.validationContext || {};
  const usageSettlement = validation.usageSettlement || summarizeUsageSettlement({ result, error, diagnostics });
  const validationIssueCodes = [
    ...(Array.isArray(validation.repairFeedback?.issueCodes) ? validation.repairFeedback.issueCodes : []),
    ...(Array.isArray(validation.issueCodes) ? validation.issueCodes : []),
    ...solutionIssues,
    ...(exactFailedRule ? [exactFailedRule] : []),
  ].filter(Boolean);
  const issueCodes = [...new Set(validationIssueCodes)];
  const promotedDiagnostics = {
    numericFinalAnswerAnalysis: safeJsonClone(validation.numericFinalAnswerAnalysis || validationContext.numericFinalAnswerAnalysis || null),
    signAnalysisResult: safeJsonClone(validation.signAnalysisResult || validationContext.signAnalysisResult || null),
    finalAnswerConsistencyResult: safeJsonClone(validation.finalAnswerConsistencyResult || validationContext.finalAnswerConsistencyResult || null),
    identityVerificationResult: safeJsonClone(validation.identityVerificationResult || validationContext.identityVerificationResult || null),
    substitutionConsistencyResult: safeJsonClone(validation.substitutionConsistencyResult || validationContext.substitutionConsistencyResult || null),
    numericalCrossCheckResult: safeJsonClone(validation.numericalCrossCheckResult || validationContext.numericalCrossCheckResult || null),
  };

  return safeJsonClone({
    metadata: {
      timestamp: new Date().toISOString(),
      requestId,
      endpoint,
      failureStage: stage,
      purpose: diagnostics.purpose || validation.purpose || null,
      model: diagnostics.model || validation.model || null,
      responseModel: diagnostics.responseModel || null,
      temperature: diagnostics.temperature ?? validation.temperature ?? null,
      top_p: diagnostics.topP ?? diagnostics.top_p ?? validation.top_p ?? null,
      promptHash: promptHash || diagnostics.promptHash || null,
      attemptType: diagnostics.attemptType || validation.attemptType || stage || null,
      attempt: diagnostics.attempt ?? null,
      maxAttempts: diagnostics.maxAttempts ?? null,
      retryCount: diagnostics.retryCount ?? null,
      aiCallCount: result?._aiCallCount ?? null,
      usageSettlement,
      errorCode: error?.code || null,
      responseFailureType,
      compactRetryable: error?.compactRetryable ?? null,
      publicMessage: error?.publicMessage || null,
      internalMessage: error?.message || null,
    },
    input: {
      originalReviewedOcrText: input.originalReviewedOcrText || "",
      canonicalNormalizedSolverInput: input.canonicalNormalizedSolverInput || "",
      extractionConfidence: input.extractionConfidence ?? null,
      extractionConfidenceTier: input.extractionConfidenceTier || "",
      extractionOcrConfidence: input.extractionOcrConfidence ?? null,
      extractionMathIntegrityScore: input.extractionMathIntegrityScore ?? null,
      extractionIssues: input.extractionIssues || [],
      canonicalProblem: input.canonicalProblem || null,
      generatedPrompt: promptText.text,
      generatedPromptTruncated: promptText.truncated,
      generatedPromptChars: promptText.chars,
      modelInputMessages: diagnostics.modelInputMessages || [],
    },
    modelResult: {
      rawResponsesOutputText: rawOutput.text,
      rawResponsesOutputTextTruncated: rawOutput.truncated,
      rawResponsesOutputTextChars: rawOutput.chars,
      parsedJsonBeforeSchemaNormalization: diagnostics.parsedJson || null,
      schemaSanitizedJson: diagnostics.sanitizedJson || null,
      sanitizedNormalizedSolutionJson: result || null,
      ...relevantResponseMetadata(diagnostics),
    },
    validation: {
      solutionIssues,
      exactFailedRule,
      allIssueCodes: solutionIssues,
      latexValidationIssues,
      responseFailureType,
      issueDetails: error?.solutionRuleEvaluations || validation.ruleEvaluations || [],
      validationContext: validationContext || null,
      firstFailingStepId: validation.firstFailingStepId || validation.earliestFailingStepId || validationContext.firstFailingStepId || null,
      earliestFailingStepId: validation.earliestFailingStepId || validation.firstFailingStepId || validationContext.firstFailingStepId || null,
      relevantStepLatex: validation.relevantStepLatex || validationContext.relevantStepLatex || "",
      numericFinalAnswerAnalysis: promotedDiagnostics.numericFinalAnswerAnalysis,
      signAnalysisResult: promotedDiagnostics.signAnalysisResult,
      finalAnswerConsistencyResult: promotedDiagnostics.finalAnswerConsistencyResult,
      identityVerificationResult: promotedDiagnostics.identityVerificationResult,
      substitutionConsistencyResult: promotedDiagnostics.substitutionConsistencyResult,
      numericalCrossCheckResult: promotedDiagnostics.numericalCrossCheckResult,
      repairFeedback: validation.repairFeedback || null,
      issueCodes,
      evidenceExcerpts: validation.repairFeedback?.evidenceExcerpts || [],
      requestedCorrectionStrategy: validation.repairFeedback?.requestedCorrectionStrategy || "",
      previousMethodFingerprint: validation.repairFeedback?.previousMethodFingerprint || null,
      currentMethodFingerprint: validation.repairFeedback?.currentMethodFingerprint || null,
      repeatedMethodDetected: validation.repairFeedback?.repeatedMethodDetected ?? false,
      initialValidationPassed: validation.initialValidationPassed ?? null,
      repairAttempted: validation.repairAttempted ?? null,
      repairValidationPassed: validation.repairValidationPassed ?? null,
    },
    errors: serializeError(error),
  });
}

export async function captureFailedSolveDiagnostic(details = {}) {
  if (!isCaptureEnabled()) return null;

  const requestId = details.requestId || details.error?.omniDebugContext?.requestId || "";
  const endpoint = details.endpoint || "";
  const stage = details.stage || "initial";
  const rule = details.error?.solutionIssues?.[0] || details.error?.code || details.error?.message || "unknown";
  const directory = path.join(process.cwd(), DIAGNOSTIC_DIR);
  const fileName = [
    safeTimestamp(),
    slug(endpoint),
    shortId(requestId),
    slug(stage),
  ].join("_") + ".json";
  const filePath = path.join(directory, fileName);

  try {
    const artifact = buildArtifact({
      ...details,
      requestId,
      endpoint,
      stage,
    });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    console.info(`[omnimath:failed-solve-captured] requestId=${requestId || "unknown"} stage=${stage} rule=${rule} file=${filePath}`);
    return filePath;
  } catch (captureError) {
    console.warn("[omnimath:failed-solve-capture-error]", {
      requestId: requestId || null,
      stage,
      rule,
      message: captureError.message,
      code: captureError.code || null,
    });
    return null;
  }
}
