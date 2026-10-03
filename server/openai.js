import { loadEnvFiles } from "./env.js";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Agent } from "undici";
import {
  assertCompareMethods,
  assertCompactSolveResponse,
  assertFastSolveResponse,
  assertImageExtractionResponse,
  assertImageSolveResponse,
  assertLazyTokenExplanation,
  compareMethodsSchema,
  compactSolveSchema,
  convertFastSolveToMathExplanation,
  convertImageSolveToMathExplanation,
  fastSolveSchema,
  imageExtractionSchema,
  imageSolveSchema,
  lazyTokenExplanationSchema,
  RESPONSE_FAILURE_TYPES,
} from "./mathExplanationSchema.js";
import { sanitizeStringValues } from "../src/lib/textSanitization.js";
import { assertSolveCandidateStructure, inspectSolveCandidateStructure } from "./solveCandidateStructure.js";
import { inspectLatexControlCharacterStage } from "./latexControlCharacterRecovery.js";
import { logBackendReasoningLatexStage } from "./reasoningLatexDiagnostics.js";
import { createSolveBudget, createSolveTimeoutError } from "./solveBudget.js";
import {
  buildResponsesModelParameters,
  DEFAULT_CANONICAL_SOLVE_TIMEOUT_MS,
  estimateModelCostUsd,
  getOpenAiModelForPath,
  getOpenAiModelResolutions,
  getOpenAiModels,
  getOpenAiSamplingForPath,
  getOpenAiTimeoutPolicy,
  logOpenAiModelSelection,
  resolveImageExtractionOutputTokenBudget,
  resolveOpenAiRequestTimeout,
  selectOpenAiModel,
} from "./openaiModels.js";

loadEnvFiles();

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_RESPONSES_HOSTNAME = new URL(OPENAI_RESPONSES_URL).hostname;

function getStreamingResponsesUrl() {
  const override = process.env.OPENAI_RESPONSES_URL;
  if (!override || process.env.NODE_ENV === "production") return OPENAI_RESPONSES_URL;
  let parsed;
  try { parsed = new URL(override); }
  catch { throw new Error("OPENAI_RESPONSES_URL must be a valid local URL."); }
  if (!(["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    && ["http:", "https:"].includes(parsed.protocol)
    && !parsed.username && !parsed.password)) {
    throw new Error("OPENAI_RESPONSES_URL must target local loopback outside production.");
  }
  return parsed.href;
}
const DEFAULT_MAX_OUTPUT_TOKENS = 8000;
const DEFAULT_SOLVE_MAX_OUTPUT_TOKENS = 6500;
const DEFAULT_LAZY_MAX_OUTPUT_TOKENS = 700;
const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1700;
const DEFAULT_OPENAI_RETRY_BASE_DELAY_MS = 500;
const MIN_IMAGE_EXTRACTION_COMPACT_RETRY_MS = 5000;
const DEFAULT_SOLVE_OUTPUT_BUDGETS = Object.freeze({
  solver: Object.freeze({ full: 6500, compact: 3200 }),
  repair: Object.freeze({ full: 16000, compact: 8000 }),
  escalation: Object.freeze({ full: 24000, compact: 12000 }),
  premiumEscalation: Object.freeze({ full: 24000, compact: 12000 }),
});
const SOLVE_OUTPUT_BUDGET_ENV = Object.freeze({
  solver: Object.freeze({
    full: "OMNIMATH_SOLVER_MAX_OUTPUT_TOKENS",
    compact: "OMNIMATH_SOLVER_COMPACT_MAX_OUTPUT_TOKENS",
  }),
  repair: Object.freeze({
    full: "OMNIMATH_REPAIR_MAX_OUTPUT_TOKENS",
    compact: "OMNIMATH_REPAIR_COMPACT_MAX_OUTPUT_TOKENS",
  }),
  escalation: Object.freeze({
    full: "OMNIMATH_ESCALATION_MAX_OUTPUT_TOKENS",
    compact: "OMNIMATH_ESCALATION_COMPACT_MAX_OUTPUT_TOKENS",
  }),
  premiumEscalation: Object.freeze({
    full: "OMNIMATH_PREMIUM_ESCALATION_MAX_OUTPUT_TOKENS",
    compact: "OMNIMATH_PREMIUM_ESCALATION_COMPACT_MAX_OUTPUT_TOKENS",
  }),
});
const DEFAULT_INPUT_COST_PER_1M_TOKENS = 5;
const DEFAULT_OUTPUT_COST_PER_1M_TOKENS = 30;

function isOpenAiDebugEnabled() {
  return process.env.NODE_ENV !== "production" && (
    process.env.OMNIMATH_DEBUG_SOLVE === "true"
    || process.env.OMNIMATH_DEBUG_SOLVE === "1"
    || process.env.VITE_DEBUG_SOLUTION_STATE === "true"
    || process.env.VITE_DEBUG_MATH_HOVER === "true"
    || process.env.VITE_DEBUG_MATH_HOVER === "1"
  );
}

function hashDebugText(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function logOpenAiDebug(event, details = {}) {
  if (!isOpenAiDebugEnabled()) return;
  console.info("[omnimath:openai-debug]", {
    event,
    ...details,
  });
}

const ACCEPTANCE_TELEMETRY_MAX_ISSUES = 40;
const ACCEPTANCE_TELEMETRY_MAX_ISSUE_CHARS = 160;
const CANONICAL_INPUT_PROBE_MAX_CHARS = 4000;

function boundedTelemetryIssues(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .flatMap((value) => typeof value === "string" ? [value] : [])
    .map((value) => value.trim().slice(0, ACCEPTANCE_TELEMETRY_MAX_ISSUE_CHARS))
    .filter(Boolean))]
    .slice(0, ACCEPTANCE_TELEMETRY_MAX_ISSUES);
}

function acceptanceTelemetryEnabled() {
  const value = String(process.env.OMNIMATH_SOLVE_ACCEPTANCE_TELEMETRY ?? "true").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Emit only bounded candidate metadata. This is intentionally independent of
 * the verbose solve debug flag so production can reconstruct acceptance
 * decisions without writing prompts, history, or generated LaTeX to logs.
 */
export function logSolveCandidateOutcome({
  requestId = null,
  attemptId = null,
  candidateId = null,
  solveMode = null,
  model = null,
  providerCompletionStatus = null,
  truncationState = null,
  normalizationActions = [],
  fatalFindings = [],
  recoverableFindings = [],
  warnings = [],
  retryReason = null,
  previousUsableCandidate = false,
  selectedForUi = false,
  outcome = null,
} = {}) {
  if (!acceptanceTelemetryEnabled()) return;
  console.info("[omnimath:solve-candidate-outcome]", {
    requestId,
    attemptId,
    candidateId,
    solveMode,
    model,
    providerCompletionStatus,
    truncationState,
    normalizationActions: boundedTelemetryIssues(normalizationActions),
    fatalFindings: boundedTelemetryIssues(fatalFindings),
    recoverableFindings: boundedTelemetryIssues(recoverableFindings),
    warnings: boundedTelemetryIssues(warnings),
    retryReason: typeof retryReason === "string" ? retryReason.slice(0, ACCEPTANCE_TELEMETRY_MAX_ISSUE_CHARS) : null,
    previousUsableCandidate: Boolean(previousUsableCandidate),
    selectedForUi: Boolean(selectedForUi),
    outcome: typeof outcome === "string" ? outcome : null,
  });
}

function logCanonicalInputProbe({ requestId = null, model = null, solveMode = null, inputSource = null, canonicalInput = "", providerInput = [] } = {}) {
  const enabled = process.env.NODE_ENV !== "production"
    && ["1", "true", "yes"].includes(String(process.env.OMNIMATH_DEBUG_CANONICAL_INPUT || "").toLowerCase());
  if (!enabled) return;
  const bounded = String(canonicalInput || "").slice(0, CANONICAL_INPUT_PROBE_MAX_CHARS);
  const promptText = providerInput?.[0]?.content?.find((item) => item?.type === "input_text")?.text || "";
  const occurrenceCount = canonicalInput ? promptText.split(String(canonicalInput)).length - 1 : 0;
  console.info("[omnimath:canonical-input-probe]", {
    requestId,
    model,
    solveMode,
    canonicalInputChars: String(canonicalInput || "").length,
    truncated: bounded.length < String(canonicalInput || "").length,
    canonicalProblemInput: { problemText: bounded, source: inputSource },
    providerInputHash: hashDebugText(JSON.stringify(providerInput)),
    canonicalTextOccurrencesInProviderInput: occurrenceCount,
  });
}

function attachOpenAiDiagnostics(target, diagnostics = {}) {
  if (!target || typeof target !== "object") return target;
  Object.defineProperty(target, "_omniOpenAiDiagnostics", {
    enumerable: false,
    configurable: true,
    value: diagnostics,
  });
  return target;
}

function attachOpenAiDiagnosticsToError(error, diagnostics = {}) {
  if (!error || typeof error !== "object") return error;
  Object.defineProperty(error, "_omniOpenAiDiagnostics", {
    enumerable: false,
    configurable: true,
    value: diagnostics,
  });
  return error;
}

function attachOpenAiUsageToError(error, usage = null, aiCallCount = 0) {
  if (!error || typeof error !== "object") return error;
  Object.defineProperty(error, "_aiUsage", {
    enumerable: false,
    configurable: true,
    value: usage,
  });
  Object.defineProperty(error, "_aiCallCount", {
    enumerable: false,
    configurable: true,
    value: aiCallCount,
  });
  return error;
}

function tagUsageWithModel(usage = null, model = "") {
  if (!usage || typeof usage !== "object") return usage;
  const normalized = normalizeOpenAiUsage(usage, 0);
  return {
    ...usage,
    _omni_model_usage: [
      {
        model,
        accountingModel: model,
        input_tokens: normalized.inputTokens,
        output_tokens: normalized.outputTokens,
        total_tokens: normalized.totalTokens,
        output_tokens_details: {
          reasoning_tokens: normalized.reasoningTokens,
        },
      },
    ],
  };
}

function providerCallCountFromError(error) {
  const dispatchedAttempts = error?._omniOpenAiDiagnostics?.providerAttempts
    || error?.openAiTransportDiagnostics?.providerAttempts;
  if (Array.isArray(dispatchedAttempts) && dispatchedAttempts.length > 0) {
    return dispatchedAttempts.length;
  }
  const diagnosticAttempts = Array.isArray(error?.openAiTransportDiagnostics?.attempts)
    ? error.openAiTransportDiagnostics.attempts
    : [];
  const providerResponses = diagnosticAttempts.filter((attempt) => (
    attempt?.stage === "provider_response" || attempt?.stage === "provider_error"
  )).length;
  if (providerResponses > 0) return providerResponses;
  return error?.providerStatus !== null
    && error?.providerStatus !== undefined
    && Number.isFinite(Number(error.providerStatus))
    ? 1
    : 0;
}

function providerCallCountFromResponse(responseBody) {
  const dispatchedAttempts = responseBody?._omniOpenAiMeta?.providerAttempts;
  if (Array.isArray(dispatchedAttempts) && dispatchedAttempts.length > 0) {
    return dispatchedAttempts.length;
  }
  const attempts = responseBody?._omniOpenAiMeta?.transportDiagnostics?.attempts;
  if (Array.isArray(attempts)) {
    const providerResponses = attempts.filter((attempt) => (
      attempt?.stage === "provider_response" || attempt?.stage === "provider_error"
    )).length;
    if (providerResponses > 0) return providerResponses;
  }
  return Number(responseBody?._omniOpenAiMeta?.providerCallCount) || 1;
}

function debugAttemptType(debugContext = {}) {
  if (debugContext.attemptType) return debugContext.attemptType;
  if (debugContext.retryPurpose === "quality-repair") return "repair";
  if (debugContext.retryPurpose) return debugContext.retryPurpose;
  return "initial";
}

function debugContentText(content = []) {
  return Array.isArray(content)
    ? content.map((item) => item?.text || "").join("\n")
    : "";
}

function summarizeDiagnosticContentItem(item) {
  if (!item || typeof item !== "object") return { type: typeof item };
  if (item.type === "input_text") {
    return {
      type: item.type,
      text: item.text || "",
    };
  }
  if (item.type === "input_image") {
    return {
      type: item.type,
      detail: item.detail || null,
      imageUrlKind: typeof item.image_url === "string" && item.image_url.startsWith("data:")
        ? "data-url"
        : typeof item.image_url === "string"
          ? "url"
          : typeof item.image_url,
      imageUrlChars: typeof item.image_url === "string" ? item.image_url.length : 0,
      imageUrlHash: typeof item.image_url === "string" ? hashDebugText(item.image_url) : null,
    };
  }
  return summarizeContentItem(item);
}

function createDiagnosticInputMessages(input = []) {
  return Array.isArray(input)
    ? input.map((item) => ({
        role: item.role || "",
        content: Array.isArray(item.content) ? item.content.map(summarizeDiagnosticContentItem) : [],
      }))
    : [];
}

export function isOpenAiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function getApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("OPENAI_API_KEY is not configured on the server."), {
      statusCode: 500,
      code: "SERVER_CONFIG_ERROR",
      publicMessage: "The AI backend is not configured.",
    });
  }
  return apiKey;
}

export function assertOpenAiConfigured() {
  getApiKey();
}

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getOpenAiRetryBaseDelayMs() {
  return readPositiveNumber("OPENAI_RETRY_BASE_DELAY_MS", DEFAULT_OPENAI_RETRY_BASE_DELAY_MS);
}

export function getSolveTotalTimeoutMs() {
  return readPositiveNumber("OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS", DEFAULT_CANONICAL_SOLVE_TIMEOUT_MS);
}

function getOpenAiMaxAttempts(modelPath = "solver") {
  if (modelPath === "solver" || modelPath === "canonicalSolve") return 3;
  return 2;
}

export function getOpenAiModel() {
  return getOpenAiModelForPath("solver");
}

export function getLazyOpenAiModel() {
  return getOpenAiModelForPath("hover");
}

export function getMaxOutputTokens() {
  return readPositiveNumber("OPENAI_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS);
}

export function getSolveMaxOutputTokens() {
  return readPositiveNumber("OPENAI_SOLVE_MAX_OUTPUT_TOKENS", DEFAULT_SOLVE_MAX_OUTPUT_TOKENS);
}

export function getLazyMaxOutputTokens() {
  return readPositiveNumber("OPENAI_LAZY_MAX_OUTPUT_TOKENS", DEFAULT_LAZY_MAX_OUTPUT_TOKENS);
}

export function getImageExtractionMaxOutputTokens() {
  return resolveImageExtractionOutputTokenBudget().effectiveMaxOutputTokens;
}

export function getImageExtractionOutputTokenConfig(options = {}) {
  return resolveImageExtractionOutputTokenBudget(options);
}

export function getSolveOutputTokenBudget({
  compact = false,
  modelPath = "solver",
  debugContext = {},
} = {}) {
  const selection = selectOpenAiModel({ modelPath, debugContext });
  const role = Object.hasOwn(DEFAULT_SOLVE_OUTPUT_BUDGETS, selection.role)
    ? selection.role
    : "solver";
  const stage = compact ? "compact" : "full";
  const defaultBudget = role === "solver" && stage === "full"
    ? getSolveMaxOutputTokens()
    : DEFAULT_SOLVE_OUTPUT_BUDGETS[role][stage];
  const requestedBudget = readPositiveNumber(
    SOLVE_OUTPUT_BUDGET_ENV[role][stage],
    defaultBudget,
  );
  const capabilityLimit = Number(
    selection.maxOutputTokenCapability ?? selection.maxOutputTokens,
  );
  return Math.max(1, Math.floor(
    Number.isFinite(capabilityLimit) && capabilityLimit > 0
      ? Math.min(requestedBudget, capabilityLimit)
      : requestedBudget,
  ));
}

function getOptionalOpenAiHeaders() {
  const headers = {};
  const organization = process.env.OPENAI_ORG_ID || process.env.OPENAI_ORGANIZATION;
  const project = process.env.OPENAI_PROJECT_ID || process.env.OPENAI_PROJECT;

  if (organization) headers["OpenAI-Organization"] = organization;
  if (project) headers["OpenAI-Project"] = project;

  return headers;
}

export function getOpenAiRuntimeConfig() {
  const timeoutPolicy = getOpenAiTimeoutPolicy();
  return {
    hasApiKey: isOpenAiConfigured(),
    model: getOpenAiModel(),
    models: getOpenAiModels(),
    modelResolutions: getOpenAiModelResolutions(),
    legacyModelConfigured: Boolean(process.env.OPENAI_MODEL),
    lazyModel: getLazyOpenAiModel(),
    maxOutputTokens: getMaxOutputTokens(),
    solveMaxOutputTokens: getSolveMaxOutputTokens(),
    lazyMaxOutputTokens: getLazyMaxOutputTokens(),
    imageExtractionMaxOutputTokens: getImageExtractionMaxOutputTokens(),
    requestTimeoutMs: timeoutPolicy.roles.solver.timeoutMs,
    timeoutPolicy,
    organizationConfigured: Boolean(process.env.OPENAI_ORG_ID || process.env.OPENAI_ORGANIZATION),
    projectConfigured: Boolean(process.env.OPENAI_PROJECT_ID || process.env.OPENAI_PROJECT),
  };
}

function summarizeContentItem(item) {
  if (!item || typeof item !== "object") return { type: typeof item };

  const summary = { type: item.type || "unknown" };
  if (typeof item.text === "string") summary.textChars = item.text.length;
  if (typeof item.image_url === "string") {
    summary.imageUrlKind = item.image_url.startsWith("data:") ? "data-url" : "url";
    summary.imageUrlChars = item.image_url.length;
    summary.detail = item.detail;
  }
  return summary;
}

function summarizePayload(payload) {
  return {
    model: payload.model,
    reasoning: payload.reasoning || null,
    hasTemperature: Object.hasOwn(payload, "temperature"),
    hasTopP: Object.hasOwn(payload, "top_p"),
    inputItems: Array.isArray(payload.input) ? payload.input.length : 0,
    input: Array.isArray(payload.input)
      ? payload.input.map((item) => ({
          role: item.role,
          contentItems: Array.isArray(item.content) ? item.content.length : 0,
          content: Array.isArray(item.content) ? item.content.map(summarizeContentItem) : [],
        }))
      : [],
    maxOutputTokens: payload.max_output_tokens,
    textFormat: payload.text?.format
      ? {
          type: payload.text.format.type,
          name: payload.text.format.name,
          strict: payload.text.format.strict,
        }
      : null,
  };
}

function createOpenAiHeaders() {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    "Content-Type": "application/json",
    ...getOptionalOpenAiHeaders(),
  };
}

function imageIngestionCorrelation(debugContext) {
  return Object.fromEntries(["uploadId", "extractionId", "selectedExtractionId", "reviewRevision", "reviewRevisionId", "canonicalProblemId", "canonicalSolveRequestId"]
    .filter((key) => debugContext[key] !== undefined).map((key) => [key, debugContext[key]]));
}

function logOpenAiRequest({ purpose, payload, outputTokenConfig = null, debugContext = {} }) {
  const config = getOpenAiRuntimeConfig();
  const configuredMaxOutputTokens = outputTokenConfig?.configuredMaxOutputTokens
    ?? payload.max_output_tokens;
  const effectiveMaxOutputTokens = outputTokenConfig?.effectiveMaxOutputTokens
    ?? payload.max_output_tokens;
  console.info("[omnimath:openai-request]", {
    purpose,
    hasApiKey: config.hasApiKey,
    model: payload.model,
    role: debugContext.modelRole || null,
    requestId: debugContext.requestId || null,
    logicalImageIngestionRequestId: debugContext.logicalImageIngestionRequestId
      || debugContext.ingestionRequestId
      || debugContext.requestId
      || null,
    imageHash: debugContext.imageHash || null,
    extractionAttemptId: debugContext.extractionAttemptId || null,
    ...imageIngestionCorrelation(debugContext),
    requestedModel: debugContext.requestedModel || payload.model,
    effectiveModel: debugContext.effectiveModel || payload.model,
    accountingModel: debugContext.accountingModel || payload.model,
    configuredMaxOutputTokens,
    effectiveMaxOutputTokens,
    providerPayloadMaxOutputTokens: payload.max_output_tokens,
    maxOutputTokens: payload.max_output_tokens,
    maxOutputTokensSource: outputTokenConfig?.source || "request_argument",
    maxOutputTokensConfigStatus: outputTokenConfig?.configStatus || "request_argument",
    outputContract: outputTokenConfig?.stage || null,
    organizationConfigured: config.organizationConfigured,
    projectConfigured: config.projectConfigured,
    payloadShape: summarizePayload(payload),
  });
}

function logOpenAiProviderError({
  purpose,
  response,
  responseBody,
  model,
  modelRole,
  solveMode,
  timeoutMs,
  timeoutSource,
}) {
  const providerError = responseBody?.error || {};
  const config = getOpenAiRuntimeConfig();
  console.error("[omnimath:openai-error]", {
    purpose,
    status: response.status,
    statusText: response.statusText,
    model: responseBody?.model || model || config.model,
    modelRole,
    solveMode,
    timeoutMs,
    timeoutSource,
    organizationConfigured: config.organizationConfigured,
    projectConfigured: config.projectConfigured,
    error: {
      type: providerError.type,
      code: providerError.code,
      message: providerError.message,
      param: providerError.param,
    },
  });
}

function getFinishReason(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return "";
  return responseBody.finish_reason
    || responseBody.finishReason
    || responseBody.incomplete_details?.reason
    || responseBody.output?.find((item) => item?.finish_reason)?.finish_reason
    || responseBody.output?.find((item) => item?.finishReason)?.finishReason
    || responseBody.output?.find((item) => item?.status === "incomplete")?.incomplete_details?.reason
    || "";
}

function isLengthFinishReason(responseBody) {
  const reason = String(getFinishReason(responseBody) || "").toLowerCase();
  return reason === "length" || reason === "max_output_tokens" || reason === "max_tokens";
}

function createSolveAttemptDiagnostics({
  responseBody = {},
  debugContext = {},
  purpose = "",
  model = "",
  modelRole = "",
  solveMode = "",
  payload = {},
} = {}) {
  const usage = normalizeOpenAiUsage(responseBody.usage, 0);
  const actualVisibleOutputTokens = Math.max(0, usage.outputTokens - usage.reasoningTokens);
  const responseTruncated = isLengthFinishReason(responseBody);
  const hasVisibleOutput = Boolean(findOutputText(responseBody));
  return {
    requestId: debugContext.requestId || null,
    logicalImageIngestionRequestId: debugContext.logicalImageIngestionRequestId
      || debugContext.ingestionRequestId
      || debugContext.requestId
      || null,
    imageHash: debugContext.imageHash || null,
    extractionAttemptId: debugContext.extractionAttemptId || null,
    ...imageIngestionCorrelation(debugContext),
    routeAttemptId: debugContext.routeAttemptId || null,
    routeAttemptIndex: debugContext.routeAttemptIndex ?? null,
    purpose,
    requestedModel: debugContext.requestedModel || model,
    effectiveModel: debugContext.effectiveModel || model,
    providerModel: typeof responseBody?.model === "string" ? responseBody.model : null,
    accountingModel: debugContext.accountingModel || model,
    model,
    modelRole,
    solveMode,
    reasoningEffort: payload.reasoning?.effort || null,
    maxOutputTokens: payload.max_output_tokens ?? null,
    configuredMaxOutputTokens: debugContext.configuredMaxOutputTokens
      ?? payload.max_output_tokens
      ?? null,
    effectiveMaxOutputTokens: debugContext.effectiveMaxOutputTokens
      ?? payload.max_output_tokens
      ?? null,
    providerPayloadMaxOutputTokens: payload.max_output_tokens ?? null,
    providerTransportAttempt: debugContext.providerTransportAttempt ?? null,
    providerResponseId: responseBody?.id || null,
    responseStatus: responseBody?.status || null,
    incompleteReason: getFinishReason(responseBody) || null,
    actualReasoningTokens: usage.reasoningTokens,
    actualVisibleOutputTokens,
    responseTruncated,
    truncationWithZeroVisibleOutput: responseTruncated
      && actualVisibleOutputTokens === 0
      && !hasVisibleOutput,
    compactRetryReasoningLevel: debugContext.retryPurpose === "compact"
      ? payload.reasoning?.effort || null
      : null,
  };
}

function logSolveAttemptDiagnostics(diagnostics = {}) {
  console.info("[omnimath:solve-attempt]", diagnostics);
}

function findOutputText(responseBody) {
  if (typeof responseBody?.output_text === "string") return responseBody.output_text;

  for (const item of responseBody?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") return content.text;
    }
  }

  return null;
}

function findResponseRefusal(responseBody) {
  return responseBody?.output
    ?.flatMap((item) => item?.content || [])
    ?.find((content) => content?.refusal)?.refusal || null;
}

function getIncompleteDetails(responseBody) {
  const details = responseBody?.incomplete_details
    || responseBody?.output?.find((item) => item?.incomplete_details)?.incomplete_details
    || null;
  if (!details || typeof details !== "object") return details;
  return {
    reason: typeof details.reason === "string" ? details.reason : null,
  };
}

function isExplicitlyIncompleteResponse(responseBody) {
  return responseBody?.status === "incomplete"
    || responseBody?.output?.some((item) => item?.status === "incomplete")
    || Boolean(getIncompleteDetails(responseBody)?.reason);
}

function summarizeOpenAiResponseShape(responseBody) {
  const output = Array.isArray(responseBody?.output) ? responseBody.output : [];
  const outputItems = output.map((item) => {
    const content = Array.isArray(item?.content) ? item.content : [];
    return {
      id: typeof item?.id === "string" ? item.id : null,
      type: typeof item?.type === "string" ? item.type : typeof item,
      status: typeof item?.status === "string" ? item.status : null,
      contentCount: content.length,
      content: content.map((contentItem) => ({
        id: typeof contentItem?.id === "string" ? contentItem.id : null,
        type: typeof contentItem?.type === "string" ? contentItem.type : typeof contentItem,
        status: typeof contentItem?.status === "string" ? contentItem.status : null,
        textType: Object.hasOwn(contentItem || {}, "text") ? typeof contentItem.text : null,
        refusalPresent: Boolean(contentItem?.refusal),
      })),
    };
  });
  const contentItems = outputItems.flatMap((item) => item.content);

  return {
    responseId: typeof responseBody?.id === "string" ? responseBody.id : null,
    model: typeof responseBody?.model === "string" ? responseBody.model : null,
    status: typeof responseBody?.status === "string" ? responseBody.status : null,
    incompleteDetails: getIncompleteDetails(responseBody),
    incompleteReason: getIncompleteDetails(responseBody)?.reason || null,
    outputTextPresent: Object.hasOwn(responseBody || {}, "output_text"),
    outputTextType: Object.hasOwn(responseBody || {}, "output_text")
      ? typeof responseBody.output_text
      : null,
    refusalPresent: Boolean(findResponseRefusal(responseBody)),
    outputCount: output.length,
    outputItemTypes: outputItems.map((item) => item.type),
    contentItemTypes: contentItems.map((item) => item.type),
    outputItems,
    usage: responseBody?.usage || null,
  };
}

function logOpenAiResponse({ purpose, responseBody }) {
  const outputText = findOutputText(responseBody);
  console.info("[omnimath:openai-response]", {
    purpose,
    responseId: responseBody?.id || null,
    model: responseBody?.model || null,
    finishReason: getFinishReason(responseBody) || null,
    status: responseBody?.status || null,
    outputChars: String(outputText || "").length,
    usage: responseBody?.usage || null,
    responseShape: summarizeOpenAiResponseShape(responseBody),
  });
}

function logOpenAiNonProviderError({
  purpose,
  error,
  model,
  modelRole,
  solveMode,
  timeoutMs,
  timeoutSource,
}) {
  const normalizedError = normalizeOpenAiTransportError(error);

  console.error("[omnimath:openai-exception]", {
    purpose,
    model,
    modelRole,
    solveMode,
    timeoutMs,
    timeoutSource,
    normalizedErrorCode: normalizedError.normalizedErrorCode,
    legacyNumericCode: normalizedError.legacyNumericCode,
    failureType: normalizedError.failureType,
    timeoutScope: normalizedError.timeoutScope,
    errorName: normalizedError.errorName,
    message: normalizedError.errorMessage,
    rootError: normalizedError.rootError,
    causeChain: normalizedError.causeChain,
    stack: error.stack,
  });
}

export function classifyOpenAiInfrastructureFailure({ error = null, response = null } = {}) {
  if (response?.status === 429) return "provider_rate_limit";
  if (response && RETRYABLE_PROVIDER_STATUSES.has(response.status)) return "provider_http_failure";
  return normalizeOpenAiTransportError(error).failureType;
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "UND_ERR_CONNECT_TIMEOUT",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "AbortError",
  "TimeoutError",
]);
const RETRYABLE_PROVIDER_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const NON_RETRYABLE_PROVIDER_CODES = new Set([
  "invalid_api_key",
  "insufficient_quota",
  "billing_hard_limit_reached",
  "billing_not_active",
  "context_length_exceeded",
  "invalid_request_error",
  "authentication_error",
  "permission_error",
]);
const openAiAgents = new Map();

function getOpenAiAgent(timeoutMs) {
  const key = String(timeoutMs);
  if (!openAiAgents.has(key)) {
    openAiAgents.set(key, new Agent({ connect: { timeout: timeoutMs } }));
  }
  return openAiAgents.get(key);
}

function getRetryClassificationCode(error) {
  return error?.cause?.code
    || error?.code
    || error?.cause?.name
    || error?.name
    || null;
}

function describeTransportError(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return {
      name: null,
      code: null,
      message: error == null ? "" : String(error),
    };
  }

  return {
    name: typeof error.name === "string" ? error.name : null,
    code: typeof error.code === "string" || typeof error.code === "number"
      ? error.code
      : null,
    message: typeof error.message === "string" ? error.message : "",
  };
}

function getTransportErrorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;

  while (
    current
    && (typeof current === "object" || typeof current === "function")
    && !seen.has(current)
    && chain.length < 8
  ) {
    seen.add(current);
    chain.push({
      value: current,
      details: describeTransportError(current),
    });
    current = current.cause;
  }

  return chain;
}

function isRequestTimeoutError(entry) {
  const { value, details } = entry;
  if (details.name === "TimeoutError") return true;

  return value?.constructor?.name === "DOMException"
    && details.code === 23
    && /timeout/i.test(details.message);
}

export function normalizeOpenAiTransportError(error) {
  const chain = getTransportErrorChain(error);
  const rootError = chain[0]?.details ?? describeTransportError(error);
  const requestTimeoutEntry = chain.find(isRequestTimeoutError);
  const selectedEntry = requestTimeoutEntry || chain[1] || chain[0] || null;
  const selectedDetails = selectedEntry?.details ?? {
    name: null,
    code: null,
    message: "",
  };
  const retryClassificationCode = getRetryClassificationCode(error);
  const normalizedErrorCode = requestTimeoutEntry
    ? "TimeoutError"
    : retryClassificationCode;
  const legacyNumericCode = typeof selectedDetails.code === "number"
    ? selectedDetails.code
    : (chain.find((entry) => typeof entry.details.code === "number")?.details.code ?? null);
  let failureType = "unknown_infrastructure_failure";
  let timeoutScope = null;

  if (requestTimeoutEntry) {
    failureType = "request_timeout";
    timeoutScope = "request";
  } else if (normalizedErrorCode === "EAI_AGAIN" || normalizedErrorCode === "ENOTFOUND") {
    failureType = "dns_failure";
  } else if (normalizedErrorCode === "UND_ERR_CONNECT_TIMEOUT") {
    failureType = "connection_timeout";
    timeoutScope = "connection_establishment";
  } else if (normalizedErrorCode === "AbortError" || normalizedErrorCode === "ETIMEDOUT") {
    failureType = "timeout";
  } else if (
    normalizedErrorCode === "ECONNRESET"
    || normalizedErrorCode === "ECONNREFUSED"
    || normalizedErrorCode === "EPIPE"
  ) {
    failureType = "connect_failure";
  } else if (normalizedErrorCode) {
    failureType = "connect_failure";
  }

  return {
    normalizedErrorCode: normalizedErrorCode ?? null,
    legacyNumericCode,
    failureType,
    timeoutScope,
    errorName: selectedDetails.name,
    errorMessage: selectedDetails.message,
    rootError,
    causeChain: chain.slice(1).map((entry) => entry.details),
  };
}

function isTransientNetworkError(error) {
  const code = getRetryClassificationCode(error);
  if (TRANSIENT_NETWORK_CODES.has(code)) return true;
  const message = error?.cause?.message || error?.message || "";
  if (code === "ENOTFOUND") {
    return /api\.openai\.com|getaddrinfo|dns|resolve/i.test(message);
  }
  return /connect timeout|timed out|connection.*reset|network.*temporar/i.test(message);
}

export function isRetryableOpenAiTransportError(error) {
  return isTransientNetworkError(error);
}

function isRetryableProviderError(response, responseBody) {
  if (!RETRYABLE_PROVIDER_STATUSES.has(response.status)) return false;
  const providerCode = responseBody?.error?.code || responseBody?.error?.type || null;
  if (providerCode && NON_RETRYABLE_PROVIDER_CODES.has(providerCode)) return false;
  if (response.status === 429 && /quota|billing/i.test(String(responseBody?.error?.message || ""))) return false;
  return true;
}

function createOpenAiUnavailableError(error, { statusCode = 503, transportDiagnostics = null } = {}) {
  const normalizedError = normalizeOpenAiTransportError(error);
  return Object.assign(new Error(`OpenAI request failed: ${normalizedError.errorMessage || "service unavailable"}`, { cause: error }), {
    statusCode,
    code: "AI_SERVICE_UNAVAILABLE",
    publicMessage: "The AI service is temporarily unreachable. Check your internet connection and try again.",
    providerStatus: error?.providerStatus || null,
    providerCode: error?.providerCode || null,
    networkCauseCode: normalizedError.normalizedErrorCode,
    networkCauseMessage: normalizedError.errorMessage,
    networkCauseName: normalizedError.errorName,
    networkLegacyNumericCode: normalizedError.legacyNumericCode,
    networkCauseChain: normalizedError.causeChain,
    openAiTransportDiagnostics: transportDiagnostics,
  });
}

function createProviderError(response, responseBody) {
  const providerCode = responseBody.error?.code || responseBody.error?.type || null;
  const message = responseBody.error?.message || `OpenAI request failed with status ${response.status}`;
  return Object.assign(new Error(message), {
    statusCode: response.status === 429 ? 429 : 502,
    code: response.status === 429 ? "AI_PROVIDER_RATE_LIMITED" : "AI_SERVICE_ERROR",
    providerStatus: response.status,
    providerCode,
    publicMessage: response.status === 429
      ? "The AI service is busy or rate limited. Please try again later."
      : "The AI service could not complete the request.",
  });
}

function getOpenAiRetryDelayMs(attempt) {
  const base = getOpenAiRetryBaseDelayMs();
  const planned = attempt <= 1 ? base : Math.round(base * 3 * (attempt - 1));
  const jitter = Math.round(Math.random() * Math.max(25, base * 0.25));
  return planned + jitter;
}

function logOpenAiRetry({
  purpose,
  model,
  modelRole,
  solveMode,
  timeoutMs,
  timeoutSource,
  attempt,
  maxAttempts,
  startedAt,
  error,
  response,
}) {
  const normalizedError = response ? null : normalizeOpenAiTransportError(error);
  console.warn("[omnimath:openai-retry]", {
    purpose,
    model,
    modelRole,
    solveMode,
    timeoutMs,
    timeoutSource,
    attempt,
    maxAttempts,
    causeCode: response?.status || normalizedError?.normalizedErrorCode,
    causeMessage: response
      ? response.statusText || `HTTP ${response.status}`
      : normalizedError?.errorMessage,
    failureType: response
      ? classifyOpenAiInfrastructureFailure({ response })
      : normalizedError?.failureType,
    timeoutScope: normalizedError?.timeoutScope || null,
    elapsedMs: Date.now() - startedAt,
  });
}

function logOpenAiRequestDeadline({
  purpose,
  model,
  modelRole,
  solveMode,
  timeoutMs,
  timeoutSource,
  timeoutConfigStatus,
  configuredRoleTimeoutMs = timeoutMs,
  remainingLogicalBudgetMs = null,
  remainingAttemptBudgetMs = null,
  allocatedAttemptBudgetMs = null,
  budgetLimitReason = null,
  effectiveAttemptTimeoutMs = timeoutMs,
  transportAttempt = null,
  debugContext = {},
}) {
  console.info("[omnimath:openai-timeout]", {
    purpose,
    model,
    modelRole,
    solveMode,
    timeoutMs,
    timeoutSource,
    timeoutConfigStatus,
    configuredRoleTimeoutMs,
    remainingLogicalBudgetMs,
    remainingAttemptBudgetMs,
    allocatedAttemptBudgetMs,
    budgetLimitReason,
    effectiveAttemptTimeoutMs,
    transportAttempt,
    solveBudgetStage: debugContext.solveBudgetStage === "recovery" ? "recovery" : "primary",
    requestId: debugContext.requestId || null,
    logicalImageIngestionRequestId: debugContext.logicalImageIngestionRequestId
      || debugContext.ingestionRequestId
      || debugContext.requestId
      || null,
    imageHash: debugContext.imageHash || null,
    extractionAttemptId: debugContext.extractionAttemptId || null,
    ...imageIngestionCorrelation(debugContext),
  });
}

async function readOpenAiResponseBody(response, signal = null) {
  const bodyRead = response.text();
  let onAbort;
  const responseText = signal
    ? await Promise.race([
        bodyRead,
        new Promise((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          else {
            onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
      ]).finally(() => signal.removeEventListener("abort", onAbort))
    : await bodyRead;
  logOpenAiDebug("latex_control_character_stage", inspectLatexControlCharacterStage(
    responseText,
    "provider_http_response"
  ));
  try {
    const responseBody = responseText ? JSON.parse(responseText) : {};
    logOpenAiDebug("latex_control_character_stage", inspectLatexControlCharacterStage(
      responseBody,
      "provider_response_object"
    ));
    return responseBody;
  } catch {
    return { error: { message: responseText } };
  }
}

async function fetchOpenAiWithRetry({ purpose, modelPath, payload, debugContext = {} }) {
  const model = payload.model;
  const modelRole = debugContext.modelRole || selectOpenAiModel({
    modelPath,
    model,
    debugContext,
  }).role;
  const solveMode = debugContext.solveMode || debugAttemptType(debugContext);
  const timeoutResolution = resolveOpenAiRequestTimeout(modelRole);
  const maxAttempts = getOpenAiMaxAttempts(modelRole);
  const configuredTimeoutMs = timeoutResolution.timeoutMs;
  const solveBudget = debugContext.solveBudget || null;
  const recoveryStage = debugContext.solveBudgetStage === "recovery"
    || debugContext.retryPurpose === "compact";
  const solveDeadlineAt = Number(debugContext.solveDeadlineAt) || null;
  const remainingTimeoutMs = () => solveBudget
    ? solveBudget.remainingMs({ recovery: recoveryStage })
    : solveDeadlineAt
      ? Math.max(0, Math.floor(solveDeadlineAt - Date.now()))
      : configuredTimeoutMs;
  const timeoutMs = Math.max(1, Math.min(configuredTimeoutMs, remainingTimeoutMs()));
  const startedAt = Date.now();
  const providerAttemptStartCount = solveBudget?.providerAttempts?.length || 0;
  let lastRetryableError = null;
  const transportDiagnostics = {
    apiHost: OPENAI_RESPONSES_HOSTNAME,
    model,
    modelPath,
    modelRole,
    solveMode,
    purpose,
    maxAttempts,
    timeoutMs,
    configuredRoleTimeoutMs: configuredTimeoutMs,
    logicalSolveDeadlineConfigured: Boolean(solveDeadlineAt),
    timeoutSource: timeoutResolution.timeoutSource,
    timeoutConfigStatus: timeoutResolution.timeoutConfigStatus,
    transportAttempts: 0,
    successfulProviderResponses: 0,
    providerAttempts: solveBudget?.providerAttempts || [],
    retryCount: 0,
    finalInfrastructureErrorCode: null,
    finalInfrastructureFailureType: null,
    finalNormalizedErrorCode: null,
    finalLegacyNumericCode: null,
    finalErrorName: null,
    finalErrorMessage: null,
    finalCauseChain: [],
    finalTimeoutScope: null,
    attempts: [],
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    solveBudget?.throwIfExpired();
    let response;
    let responseBody;
    let providerAttempt = null;
    transportDiagnostics.transportAttempts = attempt;
    const attemptStartedAt = Date.now();
    const allocation = solveBudget?.attemptBudget({
      configuredTimeoutMs,
      recovery: recoveryStage,
    });
    const attemptRemainingBudgetMs = allocation?.remainingMs ?? remainingTimeoutMs();
    const attemptTimeoutMs = allocation?.effectiveTimeoutMs
      ?? Math.min(configuredTimeoutMs, attemptRemainingBudgetMs);
    if (attemptTimeoutMs <= 0) {
      if (solveBudget?.signal.aborted) throw solveBudget.signal.reason;
      throw createSolveTimeoutError({
        timeoutSource: "provider_attempt_timeout",
        budgetLimitReason: recoveryStage ? "recovery_stage_budget" : "primary_stage_budget",
      });
    }
    logOpenAiRequestDeadline({
      purpose,
      model,
      modelRole,
      solveMode,
      timeoutMs: attemptTimeoutMs,
      timeoutSource: allocation?.timeoutSource || timeoutResolution.timeoutSource,
      timeoutConfigStatus: timeoutResolution.timeoutConfigStatus,
      configuredRoleTimeoutMs: configuredTimeoutMs,
      remainingLogicalBudgetMs: solveBudget
        ? Math.max(0, Math.floor(solveBudget.deadlineAt - Date.now()))
        : attemptRemainingBudgetMs,
      remainingAttemptBudgetMs: attemptRemainingBudgetMs,
      allocatedAttemptBudgetMs: attemptTimeoutMs,
      budgetLimitReason: allocation?.budgetLimitReason || null,
      effectiveAttemptTimeoutMs: attemptTimeoutMs,
      transportAttempt: attempt,
      debugContext,
    });
    const attemptController = solveBudget ? new AbortController() : null;
    const attemptTimeoutError = solveBudget ? createSolveTimeoutError({
      timeoutSource: "provider_attempt_timeout",
      budgetLimitReason: allocation?.budgetLimitReason || null,
    }) : null;
    const attemptTimer = solveBudget
      ? setTimeout(() => attemptController.abort(attemptTimeoutError), attemptTimeoutMs)
      : null;
    attemptTimer?.unref?.();
    const requestSignal = solveBudget
      ? AbortSignal.any([solveBudget.signal, attemptController.signal])
      : AbortSignal.timeout(attemptTimeoutMs);
    try {
      const headers = createOpenAiHeaders();
      const body = JSON.stringify(payload);
      providerAttempt = solveBudget?.recordProviderDispatch({
        model,
        requestId: debugContext.requestId || null,
        attemptId: debugContext.attemptId || null,
        routeAttemptId: debugContext.routeAttemptId || null,
        routeAttemptIndex: debugContext.routeAttemptIndex ?? null,
        providerAttemptIndex: attempt,
        route: modelPath,
        attempt,
        timeoutSource: "provider_attempt_timeout",
        budgetLimitReason: allocation?.budgetLimitReason || null,
        estimatedInputTokens: estimatePromptTokens(JSON.stringify(payload.input || [])),
      }) || null;
      response = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers,
        body,
        signal: requestSignal,
        dispatcher: getOpenAiAgent(attemptTimeoutMs),
      });
      solveBudget?.recordProviderOutcome(providerAttempt, {
        providerRequestId: response.headers?.get?.("x-request-id") || null,
      });
      responseBody = await readOpenAiResponseBody(response, requestSignal);
    } catch (error) {
      clearTimeout(attemptTimer);
      const ownedError = requestSignal.aborted && requestSignal.reason
        ? requestSignal.reason
        : error;
      const aborted = requestSignal.aborted;
      solveBudget?.recordProviderOutcome(providerAttempt, {
        aborted,
        timeoutSource: ownedError?.timeoutSource || null,
        usageStatus: aborted ? "unknown_due_to_abort" : "unknown_unreconciled",
      });
      if (ownedError?.code === "AI_SOLVE_TIMEOUT") {
        transportDiagnostics.finalInfrastructureErrorCode = ownedError.code;
        transportDiagnostics.finalInfrastructureFailureType = ownedError.responseFailureType;
        transportDiagnostics.finalTimeoutScope = ownedError.timeoutScope;
        transportDiagnostics.attempts.push({
          attempt,
          configuredRoleTimeoutMs: configuredTimeoutMs,
          remainingLogicalBudgetMs: attemptRemainingBudgetMs,
          effectiveAttemptTimeoutMs: attemptTimeoutMs,
          stage: "transport_error",
          elapsedMs: Date.now() - attemptStartedAt,
          retryable: false,
          errorCode: ownedError.code,
          timeoutScope: ownedError.timeoutScope,
          timeoutSource: ownedError.timeoutSource,
          budgetLimitReason: ownedError.budgetLimitReason || allocation?.budgetLimitReason || null,
          failureType: ownedError.responseFailureType,
        });
        ownedError.openAiTransportDiagnostics = transportDiagnostics;
        throw attachOpenAiDiagnosticsToError(ownedError, {
          requestId: debugContext.requestId || null,
          model,
          modelRole,
          providerAttempts: solveBudget?.providerAttempts || [],
          transportDiagnostics,
        });
      }
      if (solveBudget?.signal.aborted) {
        const cancellationError = ownedError && typeof ownedError === "object"
          ? ownedError
          : Object.assign(new Error(String(ownedError || "Solve cancelled.")), { name: "AbortError" });
        transportDiagnostics.finalInfrastructureErrorCode = cancellationError.code || cancellationError.name || "AbortError";
        transportDiagnostics.finalInfrastructureFailureType = "upstream_abort";
        transportDiagnostics.finalTimeoutScope = cancellationError.timeoutScope || "upstream";
        cancellationError.openAiTransportDiagnostics = transportDiagnostics;
        throw attachOpenAiDiagnosticsToError(cancellationError, {
          requestId: debugContext.requestId || null,
          model,
          modelRole,
          providerAttempts: solveBudget.providerAttempts,
          transportDiagnostics,
        });
      }
      const normalizedError = normalizeOpenAiTransportError(error);
      const retryable = isTransientNetworkError(error) && attempt < maxAttempts;
      transportDiagnostics.finalInfrastructureErrorCode = normalizedError.normalizedErrorCode;
      transportDiagnostics.finalInfrastructureFailureType = normalizedError.failureType;
      transportDiagnostics.finalNormalizedErrorCode = normalizedError.normalizedErrorCode;
      transportDiagnostics.finalLegacyNumericCode = normalizedError.legacyNumericCode;
      transportDiagnostics.finalErrorName = normalizedError.errorName;
      transportDiagnostics.finalErrorMessage = normalizedError.errorMessage;
      transportDiagnostics.finalCauseChain = normalizedError.causeChain;
      transportDiagnostics.finalTimeoutScope = normalizedError.timeoutScope;
      transportDiagnostics.attempts.push({
        attempt,
        configuredRoleTimeoutMs: configuredTimeoutMs,
        remainingLogicalBudgetMs: attemptRemainingBudgetMs,
        effectiveAttemptTimeoutMs: attemptTimeoutMs,
        stage: "transport_error",
        elapsedMs: Date.now() - attemptStartedAt,
        retryable,
        errorCode: normalizedError.normalizedErrorCode,
        normalizedErrorCode: normalizedError.normalizedErrorCode,
        legacyNumericCode: normalizedError.legacyNumericCode,
        errorName: normalizedError.errorName,
        errorMessage: normalizedError.errorMessage,
        causeChain: normalizedError.causeChain,
        timeoutScope: normalizedError.timeoutScope,
        failureType: normalizedError.failureType,
      });
      logOpenAiNonProviderError({
        purpose,
        error,
        model,
        modelRole,
        solveMode,
        timeoutMs,
        timeoutSource: timeoutResolution.timeoutSource,
      });
      if (error.code === "SERVER_CONFIG_ERROR") throw error;
      if (!isTransientNetworkError(error) || attempt >= maxAttempts) {
        throw createOpenAiUnavailableError(error, { transportDiagnostics });
      }

      lastRetryableError = error;
      transportDiagnostics.retryCount += 1;
      logOpenAiRetry({
        purpose,
        model,
        modelRole,
        solveMode,
        timeoutMs,
        timeoutSource: timeoutResolution.timeoutSource,
        attempt,
        maxAttempts,
        startedAt,
        error,
      });
      const retryDelayMs = Math.min(getOpenAiRetryDelayMs(attempt), remainingTimeoutMs());
      if (retryDelayMs > 0) await delay(retryDelayMs);
      continue;
    }
    clearTimeout(attemptTimer);
    if (response.ok) {
      transportDiagnostics.successfulProviderResponses += 1;
      transportDiagnostics.finalInfrastructureErrorCode = null;
      transportDiagnostics.finalInfrastructureFailureType = null;
      transportDiagnostics.finalNormalizedErrorCode = null;
      transportDiagnostics.finalLegacyNumericCode = null;
      transportDiagnostics.finalErrorName = null;
      transportDiagnostics.finalErrorMessage = null;
      transportDiagnostics.finalCauseChain = [];
      transportDiagnostics.finalTimeoutScope = null;
      transportDiagnostics.attempts.push({
        attempt,
        configuredRoleTimeoutMs: configuredTimeoutMs,
        remainingLogicalBudgetMs: attemptRemainingBudgetMs,
        effectiveAttemptTimeoutMs: attemptTimeoutMs,
        stage: "provider_response",
        elapsedMs: Date.now() - attemptStartedAt,
        status: response.status,
        retryable: false,
      });
      if (responseBody.usage) {
        responseBody.usage = tagUsageWithModel(responseBody.usage, model);
      }
      solveBudget?.recordProviderOutcome(providerAttempt, {
        providerRequestId: response.headers?.get?.("x-request-id") || null,
        providerResponseId: responseBody?.id || null,
        usage: responseBody.usage || null,
      });
      const solveAttemptDiagnostics = createSolveAttemptDiagnostics({
        responseBody,
        debugContext: { ...debugContext, providerTransportAttempt: attempt },
        purpose,
        model,
        modelRole,
        solveMode,
        payload,
      });
      logSolveAttemptDiagnostics(solveAttemptDiagnostics);
      Object.defineProperty(responseBody, "_omniOpenAiMeta", {
        enumerable: false,
        configurable: true,
        value: {
          requestId: debugContext.requestId || null,
          routeAttemptId: debugContext.routeAttemptId || null,
          routeAttemptIndex: debugContext.routeAttemptIndex ?? null,
          purpose,
          requestedModel: debugContext.requestedModel || model,
          effectiveModel: debugContext.effectiveModel || model,
          providerModel: typeof responseBody?.model === "string" ? responseBody.model : null,
          accountingModel: debugContext.accountingModel || model,
          model,
          modelPath,
          modelRole,
          solveMode,
          attempt,
          maxAttempts,
          retryCount: attempt - 1,
          providerHttpStatus: response.status,
          timeoutMs,
          timeoutSource: timeoutResolution.timeoutSource,
          timeoutConfigStatus: timeoutResolution.timeoutConfigStatus,
          temperature: payload.temperature ?? null,
          topP: payload.top_p ?? null,
          temperatureSource: payload.temperature === undefined ? "provider_default" : "payload",
          topPSource: payload.top_p === undefined ? "provider_default" : "payload",
          reasoningEffort: payload.reasoning?.effort || null,
          reasoning: payload.reasoning || null,
          samplingOmitted: Boolean(debugContext.samplingOmitted),
          reasoningOmittedReason: debugContext.reasoningOmittedReason || null,
          recoveryPurpose: debugContext.recoveryPurpose || null,
          normalizedProblemHash: debugContext.normalizedProblem ? hashDebugText(debugContext.normalizedProblem) : null,
          promptHash: debugContext.promptHash || null,
          attemptType: debugAttemptType(debugContext),
          initialRouting: debugContext.initialRouting || null,
          promptText: debugContentText(payload.input?.[0]?.content || []),
          modelInputMessages: createDiagnosticInputMessages(payload.input),
          maxOutputTokens: payload.max_output_tokens ?? null,
          configuredMaxOutputTokens: debugContext.configuredMaxOutputTokens
            ?? payload.max_output_tokens
            ?? null,
          effectiveMaxOutputTokens: debugContext.effectiveMaxOutputTokens
            ?? payload.max_output_tokens
            ?? null,
          providerPayloadMaxOutputTokens: payload.max_output_tokens ?? null,
          maxOutputTokensSource: debugContext.maxOutputTokensSource || "request_argument",
          maxOutputTokensConfigStatus: debugContext.maxOutputTokensConfigStatus || "request_argument",
          outputContract: debugContext.outputContract || null,
          schemaName: payload.text?.format?.name || null,
          providerCallCount: solveBudget
            ? solveBudget.providerAttempts.length - providerAttemptStartCount
            : transportDiagnostics.transportAttempts,
          providerAttempts: solveBudget?.providerAttempts || [],
          durationMs: Date.now() - startedAt,
          transportDiagnostics,
          ...solveAttemptDiagnostics,
        },
      });
      logOpenAiDebug("http_response", {
        requestId: debugContext.requestId || null,
        purpose,
        model,
        modelPath,
        modelRole,
        solveMode,
        timeoutMs,
        timeoutSource: timeoutResolution.timeoutSource,
        temperature: payload.temperature ?? null,
        topP: payload.top_p ?? null,
        reasoningEffort: payload.reasoning?.effort || null,
        samplingOmitted: Boolean(debugContext.samplingOmitted),
        reasoningOmittedReason: debugContext.reasoningOmittedReason || null,
        promptHash: debugContext.promptHash || null,
        normalizedProblemHash: debugContext.normalizedProblem ? hashDebugText(debugContext.normalizedProblem) : null,
        attemptType: debugAttemptType(debugContext),
        attempt,
        retryCount: attempt - 1,
        status: response.status,
        finishReason: getFinishReason(responseBody) || null,
      });
      return responseBody;
    }

    solveBudget?.recordProviderOutcome(providerAttempt, {
      providerRequestId: response.headers?.get?.("x-request-id") || null,
      providerResponseId: responseBody?.id || null,
      usage: responseBody?.usage || null,
    });

    logOpenAiProviderError({
      purpose,
      response,
      responseBody,
      model,
      modelRole,
      solveMode,
      timeoutMs,
      timeoutSource: timeoutResolution.timeoutSource,
    });
    if (!isRetryableProviderError(response, responseBody)) {
      transportDiagnostics.finalInfrastructureErrorCode = responseBody?.error?.code || responseBody?.error?.type || `HTTP_${response.status}`;
      transportDiagnostics.finalInfrastructureFailureType = "provider_http_failure";
      transportDiagnostics.finalNormalizedErrorCode = transportDiagnostics.finalInfrastructureErrorCode;
      transportDiagnostics.finalLegacyNumericCode = null;
      transportDiagnostics.finalErrorName = "OpenAIProviderError";
      transportDiagnostics.finalErrorMessage = responseBody?.error?.message || response.statusText || `HTTP ${response.status}`;
      transportDiagnostics.finalCauseChain = [];
      transportDiagnostics.finalTimeoutScope = null;
      transportDiagnostics.attempts.push({
        attempt,
        configuredRoleTimeoutMs: configuredTimeoutMs,
        remainingLogicalBudgetMs: attemptRemainingBudgetMs,
        effectiveAttemptTimeoutMs: attemptTimeoutMs,
        stage: "provider_error",
        elapsedMs: Date.now() - attemptStartedAt,
        status: response.status,
        retryable: false,
        errorCode: transportDiagnostics.finalInfrastructureErrorCode,
        failureType: transportDiagnostics.finalInfrastructureFailureType,
      });
      throw createProviderError(response, responseBody);
    }

    const providerError = Object.assign(
      new Error(responseBody.error?.message || `OpenAI request failed with status ${response.status}`),
      {
        providerStatus: response.status,
        providerCode: responseBody.error?.code || responseBody.error?.type || null,
        code: `HTTP_${response.status}`,
      }
    );

    if (attempt >= maxAttempts) {
      transportDiagnostics.finalInfrastructureErrorCode = providerError.providerCode || `HTTP_${response.status}`;
      transportDiagnostics.finalInfrastructureFailureType = classifyOpenAiInfrastructureFailure({ response });
      transportDiagnostics.finalNormalizedErrorCode = transportDiagnostics.finalInfrastructureErrorCode;
      transportDiagnostics.finalLegacyNumericCode = null;
      transportDiagnostics.finalErrorName = "OpenAIProviderError";
      transportDiagnostics.finalErrorMessage = providerError.message;
      transportDiagnostics.finalCauseChain = [];
      transportDiagnostics.finalTimeoutScope = null;
      transportDiagnostics.attempts.push({
        attempt,
        stage: "provider_error",
        elapsedMs: Date.now() - attemptStartedAt,
        status: response.status,
        retryable: false,
        errorCode: transportDiagnostics.finalInfrastructureErrorCode,
        failureType: transportDiagnostics.finalInfrastructureFailureType,
      });
      throw createOpenAiUnavailableError(providerError, {
        statusCode: response.status === 429 ? 502 : 503,
        transportDiagnostics,
      });
    }

    lastRetryableError = providerError;
    transportDiagnostics.retryCount += 1;
    transportDiagnostics.attempts.push({
      attempt,
      configuredRoleTimeoutMs: configuredTimeoutMs,
      remainingLogicalBudgetMs: attemptRemainingBudgetMs,
      effectiveAttemptTimeoutMs: attemptTimeoutMs,
      stage: "provider_error",
      elapsedMs: Date.now() - attemptStartedAt,
      status: response.status,
      retryable: true,
      errorCode: providerError.providerCode || `HTTP_${response.status}`,
      failureType: classifyOpenAiInfrastructureFailure({ response }),
    });
    logOpenAiRetry({
      purpose,
      model,
      modelRole,
      solveMode,
      timeoutMs,
      timeoutSource: timeoutResolution.timeoutSource,
      attempt,
      maxAttempts,
      startedAt,
      error: providerError,
      response,
    });
    const retryDelayMs = Math.min(getOpenAiRetryDelayMs(attempt), remainingTimeoutMs());
    if (retryDelayMs > 0) await delay(retryDelayMs);
  }

  throw createOpenAiUnavailableError(lastRetryableError || new Error("OpenAI request failed."), { transportDiagnostics });
}

const MAX_PROVIDER_SSE_FRAME_CHARS = 2_000_000;
const MAX_PROVIDER_OUTPUT_TEXT_CHARS = 1_000_000;

function createStreamTerminalError(eventType, responseBody = {}) {
  const reason = responseBody?.error?.code
    || responseBody?.incomplete_details?.reason
    || responseBody?.error?.type
    || eventType;
  return Object.assign(new Error(`OpenAI stream ended with ${reason}.`), {
    statusCode: 502,
    code: "AI_SERVICE_ERROR",
    responseFailureType: eventType === "response.incomplete" ? RESPONSE_FAILURE_TYPES.TRUNCATED : eventType,
    publicMessage: "The AI service could not complete the explanation.",
    providerCode: reason,
  });
}

function parseProviderSseFrame(frame) {
  let eventName = "";
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") eventName = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  const joined = data.join("\n");
  if (joined === "[DONE]") return { type: "done" };
  let parsed;
  try {
    parsed = JSON.parse(joined);
  } catch {
    throw Object.assign(new Error("OpenAI stream contained invalid event JSON."), {
      statusCode: 502,
      code: "AI_RESPONSE_INVALID",
      publicMessage: "The AI service returned an invalid explanation.",
    });
  }
  return { ...parsed, type: parsed.type || eventName };
}

async function readProviderChunk(reader, signal) {
  if (signal.aborted) throw signal.reason || new DOMException("Stream aborted.", "AbortError");
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason || new DOMException("Stream aborted.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Some provider connections leave a pending body read unresolved after the
    // fetch signal aborts. Race the read itself against the same deadline.
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Provider SSE transport. Callers own client framing and content validation. */
async function streamOpenAiTextResponse({
  prompt,
  originalProblem = "",
  debugContext = {},
  signal = null,
  onTextDelta = null,
  onProviderEvent = null,
  schema = null,
  schemaName = "",
  modelPath = "canonicalSolve",
  purpose = "text_completion_stream",
  maxOutputTokens = null,
  deadlineAt = null,
  timeoutRole = null,
  includeModelParameters = true,
  maxOutputChars = MAX_PROVIDER_OUTPUT_TEXT_CHARS,
  maxProviderAttempts = null,
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw Object.assign(new Error("A prompt is required."), { statusCode: 400, code: "INVALID_INPUT" });
  }
  const selection = selectOpenAiModel({ modelPath, debugContext });
  const timeoutResolution = resolveOpenAiRequestTimeout(timeoutRole || selection.role);
  const startedAt = Date.now();
  const solveBudget = debugContext.solveBudget || null;
  const recoveryStage = debugContext.solveBudgetStage === "recovery"
    || debugContext.retryPurpose === "compact";
  const solveDeadlineAt = solveBudget?.deadlineAt || Number(deadlineAt || debugContext.solveDeadlineAt)
    || startedAt + (timeoutRole ? timeoutResolution.timeoutMs : getSolveTotalTimeoutMs());
  const payload = {
    model: selection.modelId,
    input: [{ role: "user", content: sanitizeStringValues([{ type: "input_text", text: prompt }]) }],
    max_output_tokens: maxOutputTokens ?? getSolveOutputTokenBudget({ modelPath, debugContext }),
    ...(includeModelParameters ? buildResponsesModelParameters(selection) : {}),
    ...(schema ? { text: { format: { type: "json_schema", name: schemaName, strict: true, schema } } } : {}),
    stream: true,
  };
  logOpenAiModelSelection(modelPath, { purpose, selection });
  logOpenAiRequest({ purpose, payload });
  logCanonicalInputProbe({
    requestId: debugContext.requestId || null,
    model: selection.modelId,
    solveMode: selection.solveMode,
    inputSource: debugContext.inputSource || null,
    canonicalInput: originalProblem || debugContext.normalizedProblem || "",
    providerInput: payload.input,
  });

  const maxAttempts = maxProviderAttempts === null
    ? getOpenAiMaxAttempts(selection.role)
    : Math.max(1, Math.min(3, Math.trunc(maxProviderAttempts) || 1));
  let providerCallCount = 0;
  let retryCount = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new DOMException("Solve cancelled.", "AbortError");
    solveBudget?.throwIfExpired();
    const allocation = solveBudget?.attemptBudget({
      configuredTimeoutMs: timeoutResolution.timeoutMs,
      recovery: recoveryStage,
    });
    const solveBudgetRemainingMs = allocation?.remainingMs ?? solveDeadlineAt - Date.now();
    const remainingMs = allocation?.effectiveTimeoutMs
      ?? Math.min(timeoutResolution.timeoutMs, solveBudgetRemainingMs);
    if (remainingMs <= 0) {
      if (solveBudget?.signal.aborted) throw solveBudget.signal.reason;
      throw createSolveTimeoutError({
        timeoutSource: "provider_attempt_timeout",
        budgetLimitReason: recoveryStage ? "recovery_stage_budget" : "primary_stage_budget",
      });
    }
    logOpenAiRequestDeadline({
      purpose,
      model: selection.modelId,
      modelRole: selection.role,
      solveMode: selection.solveMode,
      timeoutMs: remainingMs,
      timeoutSource: allocation?.timeoutSource || timeoutResolution.timeoutSource,
      timeoutConfigStatus: timeoutResolution.timeoutConfigStatus,
      configuredRoleTimeoutMs: timeoutResolution.timeoutMs,
      remainingLogicalBudgetMs: solveBudget
        ? Math.max(0, Math.floor(solveBudget.deadlineAt - Date.now()))
        : solveBudgetRemainingMs,
      remainingAttemptBudgetMs: solveBudgetRemainingMs,
      allocatedAttemptBudgetMs: remainingMs,
      budgetLimitReason: allocation?.budgetLimitReason || null,
      effectiveAttemptTimeoutMs: remainingMs,
      transportAttempt: attempt,
      debugContext,
    });
    const attemptController = solveBudget ? new AbortController() : null;
    const timeoutSignal = solveBudget ? attemptController.signal : AbortSignal.timeout(remainingMs);
    const timeoutError = solveBudget ? createSolveTimeoutError({
      timeoutSource: "provider_attempt_timeout",
      budgetLimitReason: allocation?.budgetLimitReason || null,
    }) : null;
    const timeoutTimer = solveBudget
      ? setTimeout(() => attemptController.abort(timeoutError), remainingMs)
      : null;
    timeoutTimer?.unref?.();
    const signals = [signal, solveBudget?.signal, timeoutSignal].filter(Boolean);
    const requestSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let reader;
    let bytesSeen = false;
    let terminalResponse = null;
    let providerResponseId = null;
    let providerModel = null;
    let usage = null;
    let outputText = "";
    let firstProviderByteMs = null;
    let firstProviderEventMs = null;
    let providerEventCount = 0;
    let providerAttempt = null;
    try {
      providerCallCount += 1;
      const headers = createOpenAiHeaders();
      const body = JSON.stringify(payload);
      providerAttempt = solveBudget?.recordProviderDispatch({
        model: selection.modelId,
        requestId: debugContext.requestId || null,
        attemptId: debugContext.attemptId || null,
        routeAttemptId: debugContext.routeAttemptId || null,
        routeAttemptIndex: debugContext.routeAttemptIndex ?? null,
        providerAttemptIndex: attempt,
        route: modelPath,
        attempt,
        timeoutSource: "provider_attempt_timeout",
        budgetLimitReason: allocation?.budgetLimitReason || null,
        estimatedInputTokens: estimatePromptTokens(JSON.stringify(payload.input || [])),
      }) || null;
      const response = await fetch(getStreamingResponsesUrl(), {
        method: "POST",
        headers,
        body,
        signal: requestSignal,
        dispatcher: getOpenAiAgent(remainingMs),
      });
      solveBudget?.recordProviderOutcome(providerAttempt, {
        providerRequestId: response.headers?.get?.("x-request-id") || null,
      });
      if (!response.ok) {
        const responseBody = await readOpenAiResponseBody(response, requestSignal);
        const providerError = createProviderError(response, responseBody);
        providerError.retryableBeforeStream = isRetryableProviderError(response, responseBody);
        logOpenAiProviderError({ purpose, response, responseBody, model: selection.modelId,
          modelRole: selection.role, solveMode: selection.solveMode,
          timeoutMs: remainingMs, timeoutSource: timeoutResolution.timeoutSource });
        throw providerError;
      }
      if (!response.body) throw createStreamTerminalError("missing_response_body");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      const processFrame = async (frame) => {
        if (requestSignal.aborted) throw requestSignal.reason;
        const event = parseProviderSseFrame(frame);
        if (!event || event.type === "done") return;
        if (terminalResponse) throw createStreamTerminalError("event_after_terminal");
        providerEventCount += 1;
        firstProviderEventMs ??= Date.now() - startedAt;
        const details = {
          type: event.type,
          sequenceNumber: Number.isInteger(event.sequence_number) ? event.sequence_number : null,
          providerResponseId,
          model: providerModel,
          providerModel,
          effectiveModel: selection.modelId,
          role: selection.role,
          reasoningEffort: payload.reasoning?.effort || null,
          elapsedMs: Date.now() - startedAt,
        };
        if (event.response && typeof event.response === "object") {
          providerResponseId = event.response.id || providerResponseId;
          providerModel = event.response.model || providerModel;
          usage = event.response.usage ? tagUsageWithModel(event.response.usage, selection.modelId) : usage;
          details.providerResponseId = providerResponseId;
          details.model = providerModel;
          details.providerModel = providerModel;
          if (providerAttempt && providerResponseId) {
            providerAttempt.providerResponseId = providerResponseId;
          }
        }
        const responseRefusal = event.response?.output?.some?.((item) =>
          item?.type === "refusal" || item?.content?.some?.((part) => part?.type === "refusal"));
        if (event.type === "response.refusal" || event.type === "response.output_refusal.delta"
          || event.item?.type === "refusal"
          || event.item?.content?.some?.((part) => part?.type === "refusal")
          || event.content_part?.type === "refusal" || responseRefusal) {
          throw createStreamTerminalError("response.refusal", { error: { code: "refusal" } });
        }
        if (event.type === "response.output_text.delta") {
          if (typeof event.delta !== "string") throw createStreamTerminalError("invalid_text_delta");
          outputText += event.delta;
          if (outputText.length > maxOutputChars) throw createStreamTerminalError("oversized_output_text");
          if (typeof onTextDelta === "function") await onTextDelta(event.delta, details);
        }
        if (requestSignal.aborted) throw requestSignal.reason;
        if (typeof onProviderEvent === "function") await onProviderEvent(details);
        if (requestSignal.aborted) throw requestSignal.reason;
        if (["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type)) {
          terminalResponse = event;
          if (event.type !== "response.completed") throw createStreamTerminalError(event.type, event.response || event);
        }
      };
      while (true) {
        if (requestSignal.aborted) throw requestSignal.reason;
        const { value, done } = await readProviderChunk(reader, requestSignal);
        if (done) break;
        if (value?.byteLength) {
          bytesSeen = true;
          firstProviderByteMs ??= Date.now() - startedAt;
        }
        pending += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(pending))) {
          if (boundary.index > MAX_PROVIDER_SSE_FRAME_CHARS) throw createStreamTerminalError("oversized_stream_frame");
          const frame = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          await processFrame(frame);
        }
        if (pending.length > MAX_PROVIDER_SSE_FRAME_CHARS) throw createStreamTerminalError("oversized_stream_frame");
      }
      pending += decoder.decode();
      if (requestSignal.aborted) throw requestSignal.reason;
      if (pending.trim()) await processFrame(pending);
      if (!terminalResponse || terminalResponse.type !== "response.completed") {
        throw createStreamTerminalError("missing_terminal_completion");
      }
      const finalStatus = terminalResponse.response?.status || "completed";
      if (finalStatus !== "completed") throw createStreamTerminalError(`response.${finalStatus}`, terminalResponse.response);
      solveBudget?.recordProviderOutcome(providerAttempt, {
        providerResponseId,
        usage,
      });
      console.info("[omnimath:openai-stream]", {
        requestId: debugContext.requestId || null,
        attemptId: debugContext.attemptId || null,
        routeAttemptId: debugContext.routeAttemptId || null,
        providerAttemptIndex: debugContext.providerAttemptIndex ?? null,
        providerResponseId,
        requestedModel: selection.modelId,
        effectiveModel: selection.modelId,
        providerModel,
        accountingModel: selection.modelId,
        role: selection.role,
        reasoningEffort: payload.reasoning?.effort || null,
        model: providerModel,
        attempt,
        retryCount,
        providerEventCount,
        firstProviderByteMs,
        firstProviderEventMs,
        durationMs: Date.now() - startedAt,
        terminalReason: "completed",
        usagePresent: Boolean(usage),
      });
      return {
        responseId: providerResponseId,
        model: providerModel,
        requestedModel: selection.modelId,
        effectiveModel: selection.modelId,
        providerModel,
        accountingModel: selection.modelId,
        role: selection.role,
        reasoningEffort: payload.reasoning?.effort || null,
        usage,
        outputText,
        status: finalStatus,
        firstProviderByteMs,
        firstProviderEventMs,
        durationMs: Date.now() - startedAt,
        providerEventCount,
        providerCallCount,
        retryCount,
      };
    } catch (error) {
      const cancelled = Boolean(signal?.aborted);
      const budgetAborted = Boolean(solveBudget?.signal.aborted) && !cancelled;
      const timedOut = timeoutSignal.aborted && !cancelled && !budgetAborted;
      const ownedError = cancelled
        ? signal.reason || error
        : budgetAborted
          ? solveBudget.signal.reason || error
          : timedOut
            ? timeoutSignal.reason || error
            : error;
      solveBudget?.recordProviderOutcome(providerAttempt, {
        providerResponseId,
        aborted: cancelled || budgetAborted || timedOut,
        timeoutSource: cancelled ? "upstream_abort" : ownedError?.timeoutSource || null,
        usage,
        usageStatus: usage
          ? "observed"
          : cancelled || budgetAborted || timedOut
            ? "unknown_due_to_abort"
            : "unknown_unreconciled",
      });
      const retryable = !bytesSeen && !cancelled && !budgetAborted && !timedOut && attempt < maxAttempts
        && (error.retryableBeforeStream || isTransientNetworkError(error));
      console.warn("[omnimath:openai-stream]", {
        requestId: debugContext.requestId || null,
        attemptId: debugContext.attemptId || null,
        routeAttemptId: debugContext.routeAttemptId || null,
        providerAttemptIndex: debugContext.providerAttemptIndex ?? null,
        providerResponseId,
        requestedModel: selection.modelId,
        effectiveModel: selection.modelId,
        providerModel,
        accountingModel: selection.modelId,
        role: selection.role,
        reasoningEffort: payload.reasoning?.effort || null,
        model: providerModel,
        attempt,
        providerEventCount,
        firstProviderByteMs,
        durationMs: Date.now() - startedAt,
        terminalReason: cancelled ? "cancelled" : budgetAborted || timedOut ? "timeout" : error.code || error.name || "provider_failure",
        retryable,
        usagePresent: Boolean(usage),
      });
      if (retryable) {
        retryCount += 1;
        const retryDelayMs = Math.min(
          getOpenAiRetryDelayMs(attempt),
          Math.max(0, solveDeadlineAt - Date.now()),
        );
        if (retryDelayMs > 0) {
          const retrySignal = signal && solveBudget?.signal
            ? AbortSignal.any([signal, solveBudget.signal])
            : signal || solveBudget?.signal;
          await delay(retryDelayMs, undefined, retrySignal ? { signal: retrySignal } : {});
        }
        continue;
      }
      const diagnostics = {
        requestId: debugContext.requestId || null,
        attemptId: debugContext.attemptId || null,
        routeAttemptId: debugContext.routeAttemptId || null,
        providerAttemptIndex: debugContext.providerAttemptIndex ?? null,
        providerResponseId,
        requestedModel: selection.modelId,
        effectiveModel: selection.modelId,
        providerModel,
        accountingModel: selection.modelId,
        role: selection.role,
        reasoningEffort: payload.reasoning?.effort || null,
        model: providerModel,
        providerEventCount,
        firstProviderByteMs,
        firstProviderEventMs,
        durationMs: Date.now() - startedAt,
      };
      if (cancelled) {
        const cancellationError = signal.reason instanceof Error ? signal.reason : error;
        throw attachOpenAiUsageToError(
          attachOpenAiDiagnosticsToError(cancellationError, diagnostics), usage, providerCallCount);
      }
      if (budgetAborted || timedOut) {
        const timeoutError = ownedError?.code === "AI_SOLVE_TIMEOUT"
          ? ownedError
          : createOpenAiUnavailableError(timeoutSignal.reason || error);
        timeoutError.responseFailureType ||= "request_timeout";
        timeoutError.timeoutScope ||= solveBudgetRemainingMs <= timeoutResolution.timeoutMs
          ? "total_solve" : "model_request";
        throw attachOpenAiUsageToError(
          attachOpenAiDiagnosticsToError(timeoutError, {
            ...diagnostics,
            providerAttempts: solveBudget?.providerAttempts || [],
          }), usage, providerCallCount);
      }
      const translated = error.statusCode ? error : createOpenAiUnavailableError(error);
      if (outputText && !Object.hasOwn(translated, "_omniFailedOutputText")) {
        Object.defineProperty(translated, "_omniFailedOutputText", {
          value: outputText.slice(0, 1_000_000), configurable: true,
        });
      }
      throw attachOpenAiUsageToError(
        attachOpenAiDiagnosticsToError(translated, diagnostics), usage, providerCallCount);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (reader) {
        try { await reader.cancel(); } catch { /* stream may already be closed */ }
      }
    }
  }
  throw createStreamTerminalError("retry_limit_exceeded");
}

export async function streamMathExplanation(options = {}) {
  const incomingDebugContext = options.debugContext || {};
  const existingBudget = incomingDebugContext.solveBudget || null;
  const ownedBudget = existingBudget || createSolveBudget({
    deadlineAt: Number(options.deadlineAt || incomingDebugContext.solveDeadlineAt) || null,
    totalTimeoutMs: getSolveTotalTimeoutMs(),
    signal: options.signal || null,
  });
  try {
    return await streamOpenAiTextResponse({
      ...options,
      deadlineAt: ownedBudget.deadlineAt,
      debugContext: {
        ...incomingDebugContext,
        solveDeadlineAt: ownedBudget.deadlineAt,
        solveBudget: ownedBudget,
      },
      purpose: "math_fast_solve_stream",
      schema: options.schema || fastSolveSchema,
      schemaName: options.schemaName || "math_fast_solve",
      modelPath: options.modelPath || "canonicalSolve",
    });
  } finally {
    if (!existingBudget) ownedBudget.cleanup();
  }
}

export function estimatePromptTokens(text = "") {
  return Math.ceil(String(text).length / 4);
}

export function estimateOpenAiTokenBudget({ prompt = "", image = null, maxOutputTokens = getMaxOutputTokens() } = {}) {
  const imageTokens = image
    ? readPositiveNumber("OPENAI_IMAGE_TOKEN_ESTIMATE", DEFAULT_IMAGE_TOKEN_ESTIMATE)
    : 0;

  return Math.ceil(estimatePromptTokens(prompt) + imageTokens + maxOutputTokens);
}

export function estimateOpenAiCostBudget({ prompt = "", image = null, maxOutputTokens = getMaxOutputTokens() } = {}) {
  const imageTokens = image
    ? readPositiveNumber("OPENAI_IMAGE_TOKEN_ESTIMATE", DEFAULT_IMAGE_TOKEN_ESTIMATE)
    : 0;
  const estimatedInputTokens = estimatePromptTokens(prompt) + imageTokens;
  const inputCost = readPositiveNumber(
    "OPENAI_INPUT_COST_PER_1M_TOKENS",
    DEFAULT_INPUT_COST_PER_1M_TOKENS
  );
  const outputCost = readPositiveNumber(
    "OPENAI_OUTPUT_COST_PER_1M_TOKENS",
    DEFAULT_OUTPUT_COST_PER_1M_TOKENS
  );

  return (estimatedInputTokens / 1000000 * inputCost)
    + (maxOutputTokens / 1000000 * outputCost);
}

export function estimateImageExtractionReservation({ prompt = "", image = null } = {}) {
  const full = getImageExtractionOutputTokenConfig();
  const compact = getImageExtractionOutputTokenConfig({ compact: true });
  const imageTokensPerGeneration = image
    ? readPositiveNumber("OPENAI_IMAGE_TOKEN_ESTIMATE", DEFAULT_IMAGE_TOKEN_ESTIMATE)
    : 0;
  const fullInputTokens = estimatePromptTokens(prompt) + imageTokensPerGeneration;
  const compactInputTokens = estimatePromptTokens(buildCompactImageExtractionPrompt(prompt))
    + imageTokensPerGeneration;
  const inputTokens = fullInputTokens + compactInputTokens;
  const outputTokens = full.effectiveMaxOutputTokens + compact.effectiveMaxOutputTokens;
  const model = selectOpenAiModel({ modelPath: "imageExtraction" }).modelId;
  const estimatedCostUsd = estimateModelCostUsd(model, {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  });
  return {
    model,
    estimatedTokens: inputTokens + outputTokens,
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedCostUsd,
    semanticGenerationLimit: 2,
    providerHttpAttemptLimit: 4,
    full,
    compact,
  };
}

export function normalizeOpenAiUsage(usage, fallbackTotalTokens = 0) {
  const inputTokens = Number(usage?.input_tokens || usage?.prompt_tokens || 0);
  const outputTokens = Number(usage?.output_tokens || usage?.completion_tokens || 0);
  const reasoningTokens = Number(
    usage?.output_tokens_details?.reasoning_tokens
    || usage?.completion_tokens_details?.reasoning_tokens
    || usage?.reasoning_tokens
    || 0
  );
  const totalTokens = Number(usage?.total_tokens || 0)
    || inputTokens + outputTokens
    || Math.max(0, Math.ceil(Number(fallbackTotalTokens) || 0));

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  };
}

export function estimateOpenAiCost(usage, { model = "" } = {}) {
  const modelUsage = Array.isArray(usage?._omni_model_usage) ? usage._omni_model_usage : [];
  if (modelUsage.length > 0) {
    return modelUsage.reduce((total, item) => {
      const itemModel = item?.accountingModel || item?.model || model;
      const itemCost = itemModel ? estimateModelCostUsd(itemModel, item) : null;
      return total + (Number.isFinite(itemCost) ? itemCost : estimateOpenAiCost(item));
    }, 0);
  }
  if (model) {
    const modelCost = estimateModelCostUsd(model, usage);
    if (Number.isFinite(modelCost)) return modelCost;
  }
  const normalized = normalizeOpenAiUsage(usage);
  const inputCost = readPositiveNumber(
    "OPENAI_INPUT_COST_PER_1M_TOKENS",
    DEFAULT_INPUT_COST_PER_1M_TOKENS
  );
  const outputCost = readPositiveNumber(
    "OPENAI_OUTPUT_COST_PER_1M_TOKENS",
    DEFAULT_OUTPUT_COST_PER_1M_TOKENS
  );

  return (normalized.inputTokens / 1000000 * inputCost)
    + (normalized.outputTokens / 1000000 * outputCost);
}

function attachResponseFailureDiagnostics(error, diagnostics = {}, extra = {}) {
  const mergedDiagnostics = {
    ...diagnostics,
    ...extra,
  };
  attachOpenAiDiagnosticsToError(error, mergedDiagnostics);
  attachOpenAiUsageToError(
    error,
    mergedDiagnostics.usage || null,
    mergedDiagnostics.providerCallCount || 0,
  );
  return error;
}

function extractOutputText(responseBody, diagnostics = {}) {
  const outputText = findOutputText(responseBody);
  if (outputText !== null) return outputText;

  const refusal = findResponseRefusal(responseBody);
  if (refusal) {
    throw attachResponseFailureDiagnostics(Object.assign(new Error(refusal), {
      statusCode: 502,
      code: "AI_REQUEST_REFUSED",
      responseFailureType: "refusal",
      publicMessage: "The AI service declined to complete that explanation.",
    }), diagnostics, {
      responseFailureType: "refusal",
    });
  }

  if (isExplicitlyIncompleteResponse(responseBody)) {
    throw attachResponseFailureDiagnostics(
      createTruncatedJsonError("", responseBody),
      diagnostics,
      { responseFailureType: RESPONSE_FAILURE_TYPES.TRUNCATED },
    );
  }

  throw attachResponseFailureDiagnostics(Object.assign(new Error("OpenAI response did not include text output."), {
    statusCode: 502,
    code: "AI_RESPONSE_INVALID",
    compactRetryable: true,
    responseFailureType: "missing_text",
    publicMessage: "The AI service returned an incomplete explanation.",
  }), diagnostics, {
    responseFailureType: "missing_text",
  });
}

function stripJsonMarkdownFence(value = "") {
  return String(value || "").trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu, "$1").trim();
}

function extractFirstCompleteJsonObject(value = "") {
  const text = stripJsonMarkdownFence(value);
  const start = text.indexOf("{");
  if (start < 0) return { text, complete: false };

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      return { text: text.slice(start, index + 1), complete: true };
    }
  }

  return { text: text.slice(start), complete: false };
}

function createTruncatedJsonError(outputText, responseBody) {
  return Object.assign(new Error("OpenAI response was cut off before JSON completed."), {
    statusCode: 502,
    code: "AI_RESPONSE_TRUNCATED",
    compactRetryable: true,
    responseFailureType: RESPONSE_FAILURE_TYPES.TRUNCATED,
    publicMessage: "The AI response was cut off before it finished.",
    invalidOutputText: outputText,
    finishReason: getFinishReason(responseBody) || null,
  });
}

export function parseJsonResponse(responseBody, assertFn, debugContext = {}) {
  const meta = responseBody?._omniOpenAiMeta || {};
  const responseUsage = normalizeOpenAiUsage(responseBody?.usage, 0);
  const actualVisibleOutputTokens = Math.max(0, responseUsage.outputTokens - responseUsage.reasoningTokens);
  const responseTruncated = isLengthFinishReason(responseBody);
  const baseDiagnostics = {
    requestId: debugContext.requestId || meta.requestId || null,
    routeAttemptId: debugContext.routeAttemptId || meta.routeAttemptId || null,
    routeAttemptIndex: debugContext.routeAttemptIndex ?? meta.routeAttemptIndex ?? null,
    purpose: debugContext.purpose || meta.purpose || "json_parse",
    requestedModel: meta.requestedModel || meta.model || null,
    effectiveModel: meta.effectiveModel || meta.model || null,
    providerModel: meta.providerModel ?? responseBody?.model ?? null,
    accountingModel: meta.accountingModel || meta.model || null,
    model: meta.effectiveModel || meta.model || null,
    responseModel: responseBody?.model || null,
    modelPath: meta.modelPath || null,
    temperature: meta.temperature ?? null,
    topP: meta.topP ?? null,
    temperatureSource: meta.temperatureSource || "provider_default",
    topPSource: meta.topPSource || "provider_default",
    reasoningEffort: meta.reasoningEffort ?? null,
    reasoning: meta.reasoning || null,
    modelRole: meta.modelRole || null,
    samplingOmitted: Boolean(meta.samplingOmitted),
    reasoningOmittedReason: meta.reasoningOmittedReason || null,
    transportDiagnostics: meta.transportDiagnostics || null,
    promptHash: debugContext.promptHash || meta.promptHash || null,
    normalizedProblemHash: meta.normalizedProblemHash || (debugContext.normalizedProblem ? hashDebugText(debugContext.normalizedProblem) : null),
    attemptType: debugContext.attemptType || meta.attemptType || debugAttemptType(debugContext),
    recoveryPurpose: debugContext.recoveryPurpose || meta.recoveryPurpose || null,
    initialRouting: debugContext.initialRouting || meta.initialRouting || null,
    attempt: meta.attempt ?? null,
    maxAttempts: meta.maxAttempts ?? null,
    retryCount: meta.retryCount ?? null,
    finishReason: getFinishReason(responseBody) || null,
    responseId: responseBody?.id || null,
    responseStatus: responseBody?.status || null,
    providerHttpStatus: meta.providerHttpStatus ?? null,
    incompleteDetails: getIncompleteDetails(responseBody),
    incompleteReason: getIncompleteDetails(responseBody)?.reason || null,
    responseShape: summarizeOpenAiResponseShape(responseBody),
    maxOutputTokens: meta.maxOutputTokens ?? null,
    configuredMaxOutputTokens: meta.configuredMaxOutputTokens ?? meta.maxOutputTokens ?? null,
    effectiveMaxOutputTokens: meta.effectiveMaxOutputTokens ?? meta.maxOutputTokens ?? null,
    providerPayloadMaxOutputTokens: meta.providerPayloadMaxOutputTokens ?? meta.maxOutputTokens ?? null,
    maxOutputTokensSource: meta.maxOutputTokensSource || null,
    maxOutputTokensConfigStatus: meta.maxOutputTokensConfigStatus || null,
    outputContract: meta.outputContract || null,
    actualReasoningTokens: meta.actualReasoningTokens ?? responseUsage.reasoningTokens,
    actualVisibleOutputTokens: meta.actualVisibleOutputTokens ?? actualVisibleOutputTokens,
    responseTruncated: meta.responseTruncated ?? responseTruncated,
    truncationWithZeroVisibleOutput: meta.truncationWithZeroVisibleOutput
      ?? (responseTruncated && actualVisibleOutputTokens === 0 && !findOutputText(responseBody)),
    compactRetryReasoningLevel: meta.compactRetryReasoningLevel
      ?? (debugContext.retryPurpose === "compact" ? meta.reasoningEffort || null : null),
    schemaName: meta.schemaName || null,
    schemaValidator: debugContext.schemaValidator || null,
    strictJsonEnvelope: debugContext.strictJsonEnvelope === true,
    usage: responseBody?.usage || null,
    providerCallCount: meta.providerCallCount
      ?? meta.transportDiagnostics?.successfulProviderResponses
      ?? 0,
    durationMs: meta.durationMs ?? null,
  };
  const outputText = extractOutputText(responseBody, baseDiagnostics);
  logOpenAiDebug("latex_control_character_stage", inspectLatexControlCharacterStage(
    outputText,
    "extracted_output_text"
  ));
  const outputDiagnostics = {
    ...baseDiagnostics,
    rawOutputHash: hashDebugText(outputText),
    rawOutputChars: outputText.length,
    rawOutput: outputText,
    promptText: meta.promptText || "",
    modelInputMessages: meta.modelInputMessages || [],
  };
  logOpenAiResponse({ purpose: "json_parse", responseBody });
  logOpenAiDebug("raw_model_response", {
    requestId: outputDiagnostics.requestId,
    purpose: outputDiagnostics.purpose,
    model: outputDiagnostics.model,
    temperature: outputDiagnostics.temperature,
    topP: outputDiagnostics.topP,
    temperatureSource: outputDiagnostics.temperatureSource,
    topPSource: outputDiagnostics.topPSource,
    promptHash: outputDiagnostics.promptHash,
    normalizedProblemHash: outputDiagnostics.normalizedProblemHash,
    attemptType: outputDiagnostics.attemptType,
    retryCount: outputDiagnostics.retryCount,
    finishReason: outputDiagnostics.finishReason,
    rawOutputHash: outputDiagnostics.rawOutputHash,
    rawOutputChars: outputDiagnostics.rawOutputChars,
    rawOutput: outputText,
  });
  if (isExplicitlyIncompleteResponse(responseBody) || isLengthFinishReason(responseBody)) {
    const error = createTruncatedJsonError(outputText, responseBody);
    attachResponseFailureDiagnostics(error, outputDiagnostics, {
      responseFailureType: RESPONSE_FAILURE_TYPES.TRUNCATED,
    });
    throw error;
  }

  const strictJsonEnvelope = debugContext.strictJsonEnvelope === true;
  const extracted = strictJsonEnvelope
    ? { text: String(outputText || "").trim(), complete: true }
    : extractFirstCompleteJsonObject(outputText);
  if (!extracted.complete) {
    const error = Object.assign(new Error("OpenAI returned incomplete JSON."), {
      statusCode: 502,
      code: "AI_RESPONSE_INVALID",
      compactRetryable: true,
      responseFailureType: RESPONSE_FAILURE_TYPES.TRUNCATED,
      publicMessage: "The AI service returned an incomplete explanation.",
      invalidOutputText: outputText,
    });
    attachResponseFailureDiagnostics(error, outputDiagnostics, {
      responseFailureType: RESPONSE_FAILURE_TYPES.TRUNCATED,
    });
    throw error;
  }

  let parsed;
  try {
    logOpenAiDebug("latex_control_character_stage", inspectLatexControlCharacterStage(
      extracted.text,
      "raw_json_text"
    ));
    parsed = JSON.parse(extracted.text);
    logBackendReasoningLatexStage("1.raw_provider_json_field", parsed);
    logOpenAiDebug("latex_control_character_stage", inspectLatexControlCharacterStage(
      parsed,
      "parsed_javascript_object"
    ));
  } catch (error) {
    logOpenAiDebug("json_parse_failure", {
      requestId: debugContext.requestId || meta.requestId || null,
      purpose: debugContext.purpose || meta.purpose || "json_parse",
      schemaValidator: debugContext.schemaValidator || assertFn?.name || "anonymous",
      strictJsonEnvelope,
      code: error.code || null,
      message: error.message,
      failedRule: error.code || error.message,
    });
    const wrapped = Object.assign(new Error("OpenAI returned malformed JSON."), {
      statusCode: 502,
      code: "AI_RESPONSE_INVALID",
      compactRetryable: true,
      responseFailureType: RESPONSE_FAILURE_TYPES.JSON_PARSE,
      publicMessage: strictJsonEnvelope
        ? "The image extraction service returned invalid structured data."
        : "The AI service returned an invalid explanation.",
      invalidOutputText: outputText,
    });
    attachResponseFailureDiagnostics(wrapped, outputDiagnostics, {
      responseFailureType: RESPONSE_FAILURE_TYPES.JSON_PARSE,
      strictJsonEnvelope,
    });
    throw wrapped;
  }

  logOpenAiDebug("parse_result", {
    requestId: debugContext.requestId || meta.requestId || null,
    purpose: debugContext.purpose || meta.purpose || "json_parse",
    schemaValidator: debugContext.schemaValidator || assertFn?.name || "anonymous",
    parsedJsonHash: hashDebugText(JSON.stringify(parsed)),
    parsedJson: parsed,
  });

  let asserted;
  try {
    asserted = attachOpenAiDiagnostics(assertFn(parsed), {
      ...outputDiagnostics,
      parsedJson: parsed,
    });
    logBackendReasoningLatexStage("2.backend_parsed_normalized_candidate", asserted);
    logOpenAiDebug("latex_control_character_stage", inspectLatexControlCharacterStage(
      asserted,
      "post_schema_normalization"
    ));
    logOpenAiDebug("sanitized_response", {
      requestId: debugContext.requestId || meta.requestId || null,
      purpose: debugContext.purpose || meta.purpose || "json_parse",
      schemaValidator: debugContext.schemaValidator || assertFn?.name || "anonymous",
      sanitizedJsonHash: hashDebugText(JSON.stringify(asserted)),
      sanitizedJson: asserted,
    });
    attachOpenAiDiagnostics(asserted, {
      ...asserted._omniOpenAiDiagnostics,
      sanitizedJson: asserted,
    });
    logOpenAiDebug("schema_validation_pass", {
      requestId: debugContext.requestId || meta.requestId || null,
      purpose: debugContext.purpose || meta.purpose || "json_parse",
      schemaValidator: debugContext.schemaValidator || assertFn?.name || "anonymous",
    });
    return asserted;
  } catch (error) {
    logOpenAiDebug("schema_validation_failure", {
      requestId: debugContext.requestId || meta.requestId || null,
      purpose: debugContext.purpose || meta.purpose || "json_parse",
      schemaValidator: debugContext.schemaValidator || assertFn?.name || "anonymous",
      code: error.code || null,
      message: error.message,
      failedRule: error.code || error.message,
    });
    if (error.statusCode) {
      error.invalidOutputText = outputText;
      if (!error.responseFailureType) {
        error.responseFailureType = RESPONSE_FAILURE_TYPES.SCHEMA_CONTRACT;
      }
      attachResponseFailureDiagnostics(error, outputDiagnostics, {
        parsedJson: parsed,
        responseFailureType: error.responseFailureType,
      });
      throw error;
    }
    const wrapped = Object.assign(new Error("OpenAI response failed generated-response validation."), {
      statusCode: 502,
      code: "AI_RESPONSE_INVALID",
      compactRetryable: true,
      responseFailureType: RESPONSE_FAILURE_TYPES.GENERATED_VALIDATION,
      publicMessage: "The AI service returned an invalid explanation.",
      invalidOutputText: outputText,
    });
    attachResponseFailureDiagnostics(wrapped, outputDiagnostics, {
      parsedJson: parsed,
      responseFailureType: RESPONSE_FAILURE_TYPES.GENERATED_VALIDATION,
    });
    throw wrapped;
  }
}

async function requestOpenAi({
  content,
  purpose = "math_explanation",
  modelPath = "solver",
  schema = fastSolveSchema,
  schemaName = "math_solve",
  maxOutputTokens = getSolveMaxOutputTokens(),
  outputTokenConfig = null,
  model = "",
  debugContext = {},
}) {
  const selection = selectOpenAiModel({ modelPath, model, debugContext });
  const modelParameters = buildResponsesModelParameters(selection);
  const sanitizedContent = sanitizeStringValues(content);
  const enrichedDebugContext = {
    ...debugContext,
    modelRole: selection.role,
    requestedModel: selection.modelId,
    effectiveModel: selection.modelId,
    accountingModel: selection.modelId,
    solveMode: selection.solveMode,
    samplingOmitted: selection.samplingOmitted,
    reasoningOmittedReason: selection.reasoningOmittedReason,
    configuredMaxOutputTokens: outputTokenConfig?.configuredMaxOutputTokens ?? maxOutputTokens,
    effectiveMaxOutputTokens: outputTokenConfig?.effectiveMaxOutputTokens ?? maxOutputTokens,
    providerPayloadMaxOutputTokens: maxOutputTokens,
    maxOutputTokensSource: outputTokenConfig?.source || "request_argument",
    maxOutputTokensConfigStatus: outputTokenConfig?.configStatus || "request_argument",
    outputContract: outputTokenConfig?.stage || null,
  };
  const payload = {
    model: selection.modelId,
    input: [{ role: "user", content: sanitizedContent }],
    max_output_tokens: maxOutputTokens,
    ...modelParameters,
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        strict: true,
        schema,
      },
    },
  };
  logOpenAiModelSelection(modelPath, { purpose, selection });
  logOpenAiRequest({ purpose, payload, outputTokenConfig, debugContext: enrichedDebugContext });
  logCanonicalInputProbe({
    requestId: debugContext.requestId || null,
    model: selection.modelId,
    solveMode: selection.solveMode,
    inputSource: debugContext.inputSource || null,
    canonicalInput: debugContext.normalizedProblem || "",
    providerInput: payload.input,
  });
  logOpenAiDebug("request_settings", {
    requestId: debugContext.requestId || null,
    routeAttemptId: debugContext.routeAttemptId || null,
    routeAttemptIndex: debugContext.routeAttemptIndex ?? null,
    purpose,
    requestedModel: selection.modelId,
    effectiveModel: selection.modelId,
    providerModel: null,
    accountingModel: selection.modelId,
    model: selection.modelId,
    modelPath,
    modelRole: selection.role,
    modelSource: selection.modelSource,
    maxOutputTokenCapability: selection.maxOutputTokenCapability ?? selection.maxOutputTokens,
    timeoutMs: selection.timeoutMs,
    timeoutSource: selection.timeoutSource,
    timeoutConfigStatus: selection.timeoutConfigStatus,
    reasoningEffort: selection.reasoningEffort,
    requestedReasoningEffort: selection.requestedReasoningEffort || null,
    reasoningOmittedReason: selection.reasoningOmittedReason || null,
    samplingOmitted: selection.samplingOmitted,
    freshSolve: selection.freshSolve,
    promptHash: hashDebugText(debugContentText(sanitizedContent)),
    configuredPromptHash: debugContext.promptHash || null,
    normalizedProblemHash: debugContext.normalizedProblem ? hashDebugText(debugContext.normalizedProblem) : null,
    attemptType: debugAttemptType(debugContext),
    recoveryPurpose: debugContext.recoveryPurpose || null,
    maxOutputTokens,
    configuredMaxOutputTokens: outputTokenConfig?.configuredMaxOutputTokens ?? maxOutputTokens,
    effectiveMaxOutputTokens: outputTokenConfig?.effectiveMaxOutputTokens ?? maxOutputTokens,
    providerPayloadMaxOutputTokens: payload.max_output_tokens,
    maxOutputTokensSource: outputTokenConfig?.source || "request_argument",
    maxOutputTokensConfigStatus: outputTokenConfig?.configStatus || "request_argument",
    outputContract: outputTokenConfig?.stage || null,
    temperature: payload.temperature ?? null,
    topP: payload.top_p ?? null,
    temperatureSource: payload.temperature === undefined ? "provider_default" : "payload",
    topPSource: payload.top_p === undefined ? "provider_default" : "payload",
    schemaName,
  });
  const responseBody = await fetchOpenAiWithRetry({ purpose, modelPath, payload, debugContext: enrichedDebugContext });

  logOpenAiResponse({ purpose, responseBody });
  return responseBody;
}

async function requestOpenAiText({
  content,
  maxOutputTokens = 900,
  purpose = "text_completion",
  modelPath = "solver",
  deadlineAt = null,
  timeoutRole = null,
  requireComplete = false,
  debugContext = {},
}) {
  const selection = selectOpenAiModel({ modelPath, debugContext });
  const payload = {
    model: selection.modelId,
    input: [{ role: "user", content }],
    max_output_tokens: maxOutputTokens,
  };
  logOpenAiModelSelection(modelPath, { purpose, selection });
  logOpenAiRequest({ purpose, payload });
  const responseBody = await fetchOpenAiWithRetry({
    purpose,
    modelPath,
    payload,
    debugContext: {
      ...debugContext,
      modelRole: timeoutRole || selection.role,
      requestedModel: selection.modelId,
      effectiveModel: selection.modelId,
      accountingModel: selection.modelId,
      solveMode: selection.solveMode,
      solveDeadlineAt: Number(deadlineAt) || null,
    },
  });

  const diagnostics = {
    requestId: responseBody?._omniOpenAiMeta?.requestId || null,
    routeAttemptId: responseBody?._omniOpenAiMeta?.routeAttemptId || null,
    routeAttemptIndex: responseBody?._omniOpenAiMeta?.routeAttemptIndex ?? null,
    purpose,
    requestedModel: responseBody?._omniOpenAiMeta?.requestedModel || selection.modelId,
    effectiveModel: responseBody?._omniOpenAiMeta?.effectiveModel || selection.modelId,
    providerModel: responseBody?._omniOpenAiMeta?.providerModel ?? responseBody?.model ?? null,
    accountingModel: responseBody?._omniOpenAiMeta?.accountingModel || selection.modelId,
    modelRole: selection.role,
    reasoningEffort: null,
    model: responseBody?._omniOpenAiMeta?.providerModel ?? responseBody?.model ?? null,
    responseModel: responseBody?.model || null,
    responseId: responseBody?.id || null,
    responseStatus: responseBody?.status || null,
    providerHttpStatus: responseBody?._omniOpenAiMeta?.providerHttpStatus ?? null,
    incompleteDetails: getIncompleteDetails(responseBody),
    incompleteReason: getIncompleteDetails(responseBody)?.reason || null,
    responseShape: summarizeOpenAiResponseShape(responseBody),
    usage: responseBody?.usage || null,
    providerCallCount: responseBody?._omniOpenAiMeta?.providerCallCount
      ?? responseBody?._omniOpenAiMeta?.transportDiagnostics?.successfulProviderResponses
      ?? 0,
    attempt: responseBody?._omniOpenAiMeta?.attempt ?? null,
    transportDiagnostics: responseBody?._omniOpenAiMeta?.transportDiagnostics || null,
    recoveryPurpose: debugContext.recoveryPurpose
      || responseBody?._omniOpenAiMeta?.recoveryPurpose
      || null,
  };
  return attachOpenAiDiagnostics({
    text: extractOpenAiTextResponse(responseBody, { diagnostics, requireComplete }),
    usage: responseBody.usage || null,
  }, {
    ...diagnostics,
    requestedModel: responseBody?._omniOpenAiMeta?.requestedModel || selection.modelId,
    effectiveModel: responseBody?._omniOpenAiMeta?.effectiveModel || selection.modelId,
    providerModel: responseBody?._omniOpenAiMeta?.providerModel ?? responseBody?.model ?? null,
    accountingModel: responseBody?._omniOpenAiMeta?.accountingModel || selection.modelId,
    modelRole: selection.role,
    // requestOpenAiText intentionally sends no reasoning parameter.
    reasoningEffort: null,
  });
}

export function extractOpenAiTextResponse(responseBody, { diagnostics = {}, requireComplete = false } = {}) {
  if (requireComplete && isExplicitlyIncompleteResponse(responseBody)) {
    throw attachResponseFailureDiagnostics(
      createTruncatedJsonError("", responseBody),
      diagnostics,
      { responseFailureType: RESPONSE_FAILURE_TYPES.TRUNCATED },
    );
  }
  const output = extractOutputText(responseBody, diagnostics).trim();
  if (requireComplete && !output) {
    throw attachResponseFailureDiagnostics(Object.assign(new Error("OpenAI response text was empty."), {
      statusCode: 502,
      code: "AI_RESPONSE_INVALID",
      responseFailureType: "empty_text",
      publicMessage: "The AI service returned an incomplete explanation.",
    }), diagnostics, { responseFailureType: "empty_text" });
  }
  return output;
}

function mergeUsage(left, right) {
  if (!left && !right) return null;
  const a = normalizeOpenAiUsage(left);
  const b = normalizeOpenAiUsage(right);
  return {
    input_tokens: a.inputTokens + b.inputTokens,
    output_tokens: a.outputTokens + b.outputTokens,
    total_tokens: a.totalTokens + b.totalTokens,
    output_tokens_details: {
      reasoning_tokens: a.reasoningTokens + b.reasoningTokens,
    },
    _omni_model_usage: [
      ...(Array.isArray(left?._omni_model_usage) ? left._omni_model_usage : []),
      ...(Array.isArray(right?._omni_model_usage) ? right._omni_model_usage : []),
    ],
  };
}

function generatedResponseIssueCodes(error = {}) {
  const solutionIssues = Array.isArray(error.solutionIssues) ? error.solutionIssues : [];
  const latexIssues = Array.isArray(error.latexValidationIssues)
    ? error.latexValidationIssues.flatMap((issue) => (
        Array.isArray(issue.issues)
          ? issue.issues.map((name) => `invalid_latex:${issue.fieldPath}:${name}`)
          : []
      ))
    : [];
  return [...new Set([...solutionIssues, ...latexIssues].filter(Boolean))];
}

function hasIssueCode(error = {}, code = "") {
  return generatedResponseIssueCodes(error).some((issue) => issue === code || issue.endsWith(`:${code}`));
}

function compactRetryFeedback(error = {}) {
  const type = error.responseFailureType || RESPONSE_FAILURE_TYPES.GENERATED_VALIDATION;
  const issueCodes = generatedResponseIssueCodes(error);
  if (type === RESPONSE_FAILURE_TYPES.TRUNCATED || error.code === "AI_RESPONSE_TRUNCATED") {
    return [
      "The previous full structured response was cut off or incomplete. Retry in compact mode.",
      "",
      "Truncation-specific correction:",
      "- Keep the response shorter while preserving the actual solution.",
      "- Use fewer steps and concise reasoning so the JSON completes.",
    ].join("\n");
  }
  if (type === RESPONSE_FAILURE_TYPES.FIELD_STRUCTURE) {
    const codeText = issueCodes.length ? issueCodes.join(", ") : "field_structure";
    return [
      "The previous response violated a required structured field contract. Retry in compact mode.",
      `Validation issue code: ${codeText}`,
      "",
      "Required-field correction:",
      "- Include the required title, problem, steps, and step fields.",
      "- Keep the final step complete and renderable.",
      "- Preserve systems, conditions, branches, and related equations when they are part of the answer.",
      "- Put derivation text in reasoning fields when practical.",
    ].join("\n");
  }
  if (type === RESPONSE_FAILURE_TYPES.JSON_PARSE) {
    return [
      "The previous response was not valid JSON. Retry in compact mode.",
      "",
      "JSON correction:",
      "- Return one complete JSON object only.",
      "- Escape LaTeX backslashes correctly inside JSON strings.",
      "- Do not include markdown fences or commentary outside JSON.",
    ].join("\n");
  }
  if (type === RESPONSE_FAILURE_TYPES.SCHEMA_CONTRACT) {
    return [
      "The previous response did not match the required solve schema. Retry in compact mode.",
      "",
      "Schema correction:",
      "- Return JSON matching the compact schema exactly.",
      "- Include only title, problemLatex, and steps at the top level.",
      "- Every step must include id, heading, latex, reasoning, and anchors.",
    ].join("\n");
  }
  if (type === RESPONSE_FAILURE_TYPES.LATEX_SYNTAX) {
    const codeText = issueCodes.length ? ` Validation issue code: ${issueCodes.join(", ")}.` : "";
    return [
      `The previous response contained malformed LaTeX.${codeText}`.trim(),
      "",
      "LaTeX correction:",
      "- Ensure every math-rendered field is valid KaTeX-compatible LaTeX.",
      "- Do not omit required command backslashes or braces.",
      "- Do not wrap math fields in markdown, display delimiters, or prose.",
    ].join("\n");
  }
  return [
    "The previous response failed generated-response validation. Retry in compact mode.",
    issueCodes.length ? `Validation issue code: ${issueCodes.join(", ")}` : "",
    "",
    "Validation correction:",
    "- Return valid JSON matching the compact schema.",
    "- Keep all math fields valid LaTeX.",
    "- Keep the complete final result in the last step, including related conditions or equations.",
  ].filter((line) => line !== "").join("\n");
}

function buildCompactSolvePrompt(prompt, originalProblem = "", failureContext = {}) {
  const retryFeedback = compactRetryFeedback(failureContext);
  return `${prompt}

${retryFeedback}

Compact mode output rules:
- Return JSON matching the compact schema exactly: title, problemLatex, steps.
- Use 4-8 steps for long problems; never more than 8.
- Each step must contain id, heading, latex, reasoning, and anchors.
- Set anchors to [] for every step unless one anchor is essential.
- Keep reasoning to 1 concise sentence, maximum 25 words.
- Do not restate the entire original problem as step 1.
- For equation solving, each displayed latex step should transform the equation currently being solved.
- Put coefficient facts and identity checks in reasoning, not as standalone latex steps.
- For perfect-square quadratics, use the shortest chain: original equation, factored square equation, linear equation, final answer.
- Preserve mathematical correctness over hover interactivity.
- Use compact equations for verification; avoid prose-heavy derivations.
  - The last step latex is treated as finalAnswerLatex and must contain the complete final result.
  - Make that last step a concise result summary, not a repeated derivation or a dump of intermediate systems. Preserve all requested parts and necessary qualifications.
  - Preserve related systems, boundary or initial conditions, branches, and equivalent final forms in the last step when they are part of the answer.
- Return JSON only.

Original problem context:
${originalProblem || "Use the problem from the prior prompt."}`;
}

function generatedAttemptType(debugContext = {}, compact = false) {
  const base = debugAttemptType(debugContext);
  const prefix = base === "repair" || base === "quality-repair"
    ? "repair"
    : base === "escalation" || base === "quality-escalation"
      ? "escalation"
      : "initial";
  return `${prefix}-${compact ? "compact" : "full"}`;
}

function orchestrationGenerationStage(debugContext = {}, compact = false) {
  const attemptType = generatedAttemptType(debugContext, compact);
  if (attemptType === "repair-compact") return "quality_repair_compact";
  if (attemptType === "repair-full") return "quality_repair";
  if (attemptType === "escalation-compact") return "fresh_escalation_compact";
  if (attemptType === "escalation-full") return "fresh_escalation";
  return compact ? "initial_compact" : "initial";
}

function recordOrchestrationGeneration(orchestrationTelemetry, {
  value = null,
  error = null,
  usageOverride = undefined,
  debugContext = {},
  compact = false,
  startedAt = Date.now(),
  candidateProduced = false,
  compactRetryAttempted = false,
  compactRetrySuppressedByPolicy = false,
} = {}) {
  try {
    if (typeof orchestrationTelemetry?.recordGenerationAttempt !== "function") return;
    const diagnostics = value?._omniOpenAiDiagnostics
      || error?._omniOpenAiDiagnostics
      || value?._omniOpenAiMeta
      || {};
    const transportDiagnostics = diagnostics.transportDiagnostics
      || error?.openAiTransportDiagnostics
      || {};
    const usage = usageOverride !== undefined
      ? usageOverride
      : value?.usage || diagnostics.usage || error?._aiUsage || null;
    const normalizedUsage = normalizeOpenAiUsage(usage, 0);
    const model = diagnostics.model || value?.model || transportDiagnostics.model || null;
    const responseFailureType = error?.responseFailureType || diagnostics.responseFailureType || null;
    const errorCode = error?.code || null;
    orchestrationTelemetry.recordGenerationAttempt({
      requestId: debugContext.requestId || diagnostics.requestId || null,
      endpoint: debugContext.endpoint || null,
      generationStage: orchestrationGenerationStage(debugContext, compact),
      modelRole: diagnostics.modelRole || transportDiagnostics.modelRole || null,
      model,
      solveMode: diagnostics.solveMode || transportDiagnostics.solveMode || null,
      httpAttemptCount: transportDiagnostics.transportAttempts
        ?? diagnostics.providerCallCount
        ?? (error?.providerStatus !== null && error?.providerStatus !== undefined ? 1 : usage ? 1 : 0),
      responseClassification: candidateProduced
        ? "candidate_produced"
        : errorCode === "AI_SERVICE_UNAVAILABLE" || errorCode === "AI_SERVICE_ERROR" || errorCode === "AI_PROVIDER_RATE_LIMITED"
          ? "infrastructure_failure"
          : "response_generation_failure",
      candidateProduced,
      validationOutcome: candidateProduced ? "pending" : "not_run",
      failureClassification: candidateProduced ? null : {
        category: errorCode === "AI_SERVICE_UNAVAILABLE" || errorCode === "AI_SERVICE_ERROR" || errorCode === "AI_PROVIDER_RATE_LIMITED"
          ? "infrastructure_failure"
          : "response_generation_failure",
        errorCode,
        responseFailureType,
      },
      retryReason: responseFailureType || errorCode || null,
      compactRetryAttempted,
      compactRetrySuppressedByPolicy,
      inputTokens: normalizedUsage.inputTokens,
      visibleOutputTokens: Math.max(0, normalizedUsage.outputTokens - normalizedUsage.reasoningTokens),
      reasoningTokens: normalizedUsage.reasoningTokens,
      totalTokens: normalizedUsage.totalTokens,
      durationMs: diagnostics.durationMs ?? Date.now() - startedAt,
      estimatedCostUsd: usage ? estimateOpenAiCost(usage, { model }) : null,
    });
  } catch {
    // Orchestration telemetry is strictly best effort.
  }
}

async function notifyGeneratedResponseFailure(callback, details = {}) {
  if (typeof callback !== "function") return;
  try {
    await callback(details);
  } catch (error) {
    console.warn("[omnimath:generated-failure-capture-error]", {
      requestId: details?.debugContext?.requestId || details?.error?._omniOpenAiDiagnostics?.requestId || null,
      stage: details?.attemptType || details?.stage || null,
      message: error.message,
      code: error.code || null,
    });
  }
}

export function normalizeProviderSolveCandidate(value, { image = false, compact = false, originalProblem = "" } = {}) {
  const structured = image
    ? assertImageSolveResponse(value)
    : compact
      ? assertCompactSolveResponse(value, originalProblem)
      : assertFastSolveResponse(value, originalProblem);
  const normalized = image
    ? convertImageSolveToMathExplanation(structured)
    : convertFastSolveToMathExplanation(structured, { originalProblem, includeProblemStep: false });

  // Evaluate the entire candidate while it is still inside the retry boundary.
  // A completed provider JSON object is not yet a usable browser solution.
  const inspection = inspectSolveCandidateStructure(normalized, { stage: "normalized" });
  if (!inspection.usable) {
    try {
      assertSolveCandidateStructure(normalized, { stage: "normalized" });
    } catch (error) {
      error.compactRetryable = true;
      throw error;
    }
  }
  const structuredInspection = inspectSolveCandidateStructure(structured, { strictParse: false });
  const sourceSteps = Array.isArray(value?.steps) ? value.steps : [];
  const sourceFinal = compact ? sourceSteps.at(-1)?.latex : value?.finalAnswerLatex;
  const normalizationActions = [];
  if (typeof sourceFinal === "string" && sourceFinal !== structured.finalAnswerLatex) {
    normalizationActions.push("final_answer_normalized");
  }
  if (sourceSteps.some((step, index) => {
    const source = image ? step?.equationLatex : step?.latex;
    return typeof source === "string" && source !== structured.steps?.[index]?.latex;
  })) normalizationActions.push("step_latex_normalized");
  if (structured.finalAnswerLatex !== normalized.finalAnswerLatex) {
    normalizationActions.push("final_answer_render_prepared");
  }
  Object.defineProperties(normalized, {
    _omniNormalizationActions: { value: normalizationActions, configurable: true },
    _omniRecoverableFindings: { value: structuredInspection.recoverableIssues, configurable: true },
    _omniWarnings: { value: [...new Set([...structuredInspection.warnings, ...inspection.warnings])], configurable: true },
  });
  return normalized;
}

export async function createMathExplanation(options = {}) {
  const incomingDebugContext = options.debugContext || {};
  const existingBudget = incomingDebugContext.solveBudget || null;
  const ownedBudget = existingBudget || createSolveBudget({
    deadlineAt: Number(incomingDebugContext.solveDeadlineAt) || null,
    totalTimeoutMs: getSolveTotalTimeoutMs(),
    signal: options.signal || null,
  });
  try {
    return await createMathExplanationWithBudget({
      ...options,
      debugContext: {
        ...incomingDebugContext,
        solveDeadlineAt: ownedBudget.deadlineAt,
        solveBudget: ownedBudget,
      },
    });
  } finally {
    if (!existingBudget) ownedBudget.cleanup();
  }
}

async function createMathExplanationWithBudget({
  prompt,
  image,
  originalProblem = "",
  debugContext = {},
  onGeneratedResponseFailure = null,
  modelPath = "solver",
  allowCompactRetry = true,
  orchestrationTelemetry = null,
}) {
  const solveStartedAt = Date.now();
  const solveDeadlineAt = Number(debugContext.solveDeadlineAt)
    || solveStartedAt + getSolveTotalTimeoutMs();
  const solveDebugContext = {
    ...debugContext,
    solveDeadlineAt,
  };
  const providerAttemptStartCount = solveDebugContext.solveBudget?.providerAttempts?.length || 0;
  const dispatchedCallCount = () => solveDebugContext.solveBudget
    ? Math.max(0, solveDebugContext.solveBudget.providerAttempts.length - providerAttemptStartCount)
    : null;
  const routeAttemptId = solveDebugContext.routeAttemptId
    || `${solveDebugContext.requestId || "solve"}:route:${solveDebugContext.routeAttemptIndex || 1}`;
  const fullGenerationAttemptId = `${routeAttemptId}:generation:full`;
  const compactGenerationAttemptId = `${routeAttemptId}:generation:compact`;
  const fullCandidateId = `${routeAttemptId}:candidate:full`;
  const compactCandidateId = `${routeAttemptId}:candidate:compact`;
  const content = [{ type: "input_text", text: prompt }];
  if (image) {
    content.push({
      type: "input_image",
      image_url: `data:${image.contentType};base64,${image.buffer.toString("base64")}`,
      detail: "high",
    });
  }

  if (image) {
    console.info("[omnimath:image-openai-forward]", {
      forwarded: true,
      filename: image.filename || null,
      contentType: image.contentType,
      bytes: image.buffer?.length || 0,
      dataUrlChars: `data:${image.contentType};base64,`.length + image.buffer.toString("base64").length,
    });
  }

  const purpose = image ? "math_image_fast_solve" : "math_fast_solve";
  const fullStartedAt = solveStartedAt;
  let responseBody;
  try {
    responseBody = await requestOpenAi({
      content,
      purpose,
      schema: image ? imageSolveSchema : fastSolveSchema,
      schemaName: image ? "math_image_solve" : "math_fast_solve",
      maxOutputTokens: getSolveOutputTokenBudget({ modelPath, debugContext: solveDebugContext }),
      modelPath,
      debugContext: solveDebugContext,
    });
  } catch (error) {
    attachOpenAiUsageToError(error, null, dispatchedCallCount() ?? providerCallCountFromError(error));
    logSolveCandidateOutcome({
      requestId: solveDebugContext.requestId || null,
      attemptId: fullGenerationAttemptId,
      candidateId: null,
      solveMode: solveDebugContext.solveMode || debugAttemptType(solveDebugContext),
      model: error?._omniOpenAiDiagnostics?.model || null,
      providerCompletionStatus: "provider_failure",
      truncationState: error?.responseFailureType === RESPONSE_FAILURE_TYPES.TRUNCATED ? "truncated" : null,
      fatalFindings: [error?.code, error?.responseFailureType],
      retryReason: error?.code || error?.responseFailureType || null,
      outcome: "provider_failure",
    });
    recordOrchestrationGeneration(orchestrationTelemetry, {
      error,
      debugContext: solveDebugContext,
      startedAt: fullStartedAt,
    });
    throw error;
  }
  let usage = responseBody.usage || null;
  let parsed;
  let compactFallback = false;
  let aiCallCount = dispatchedCallCount() ?? providerCallCountFromResponse(responseBody);
  try {
    parsed = parseJsonResponse(
      responseBody,
      (value) => normalizeProviderSolveCandidate(value, { image, originalProblem }),
      {
        ...solveDebugContext,
        purpose,
        schemaValidator: image ? "assertImageSolveResponse" : "assertFastSolveResponse",
      }
    );
  } catch (error) {
    const recoveryBudgetAvailable = solveDebugContext.solveBudget?.canStartRecovery?.() !== false;
    const compactRetryAllowed = error.compactRetryable
      && !image
      && allowCompactRetry !== false
      && recoveryBudgetAvailable;
    if (error.compactRetryable && !recoveryBudgetAvailable) {
      error.retrySuppressedReason = "insufficient_recovery_budget";
    }
    attachOpenAiUsageToError(error, usage, aiCallCount);
    logSolveCandidateOutcome({
      requestId: solveDebugContext.requestId || null,
      attemptId: fullGenerationAttemptId,
      candidateId: fullCandidateId,
      solveMode: solveDebugContext.solveMode || debugAttemptType(solveDebugContext),
      model: error?._omniOpenAiDiagnostics?.model || null,
      providerCompletionStatus: error?.responseFailureType === RESPONSE_FAILURE_TYPES.TRUNCATED ? "incomplete" : "completed",
      truncationState: error?.responseFailureType === RESPONSE_FAILURE_TYPES.TRUNCATED ? "truncated" : "complete",
      fatalFindings: [error?.code, error?.responseFailureType, ...(error?.solutionIssues || [])],
      recoverableFindings: error?.recoverableFindings || [],
      warnings: error?.warnings || [],
      retryReason: compactRetryAllowed ? (error?.responseFailureType || error?.code || "validation") : null,
      outcome: "rejected",
    });
    recordOrchestrationGeneration(orchestrationTelemetry, {
      error,
      debugContext: solveDebugContext,
      startedAt: fullStartedAt,
      compactRetryAttempted: Boolean(compactRetryAllowed),
      compactRetrySuppressedByPolicy: Boolean(
        error.compactRetryable
        && !image
        && allowCompactRetry === false
      ),
    });
    await notifyGeneratedResponseFailure(onGeneratedResponseFailure, {
      error,
      stage: generatedAttemptType(debugContext, false),
      attemptType: generatedAttemptType(debugContext, false),
      prompt,
      promptHash: debugContext.promptHash || hashDebugText(prompt),
      purpose,
      originalProblem,
      debugContext,
      failureClassification: "response_generation_failure",
      qualityRepairAttempted: false,
      compactRetryAttempted: Boolean(compactRetryAllowed),
      compactRetrySuppressedByPolicy: Boolean(
        error.compactRetryable
        && !image
        && allowCompactRetry === false
      ),
      freshEscalationAttempted: false,
    });
    if (!compactRetryAllowed) throw error;
    console.warn("[omnimath:openai-compact-retry]", {
      purpose,
      reason: error.code,
      responseFailureType: error.responseFailureType || null,
      solutionIssues: error.solutionIssues || [],
      finishReason: error.finishReason || null,
      outputChars: String(error.invalidOutputText || "").length,
    });
    const compactPrompt = buildCompactSolvePrompt(prompt, originalProblem, error);
    const compactDebugContext = {
      ...solveDebugContext,
      solveBudgetStage: "recovery",
      promptHash: hashDebugText(compactPrompt),
      retryPurpose: "compact",
      attemptType: generatedAttemptType(debugContext, true),
    };
    const compactStartedAt = Date.now();
    let compactResponse;
    try {
      compactResponse = await requestOpenAi({
        content: [{ type: "input_text", text: compactPrompt }],
        purpose: "math_compact_solve_retry",
        schema: compactSolveSchema,
        schemaName: "math_compact_solve",
        maxOutputTokens: getSolveOutputTokenBudget({
          compact: true,
          modelPath,
          debugContext: compactDebugContext,
        }),
        modelPath,
        debugContext: compactDebugContext,
      });
    } catch (compactRequestError) {
      attachOpenAiUsageToError(
        compactRequestError,
        usage,
        dispatchedCallCount() ?? aiCallCount + providerCallCountFromError(compactRequestError),
      );
      logSolveCandidateOutcome({
        requestId: solveDebugContext.requestId || null,
        attemptId: compactGenerationAttemptId,
        candidateId: compactCandidateId,
        solveMode: compactDebugContext.solveMode || "compact",
        model: compactRequestError?._omniOpenAiDiagnostics?.model || null,
        providerCompletionStatus: "provider_failure",
        truncationState: compactRequestError?.responseFailureType === RESPONSE_FAILURE_TYPES.TRUNCATED ? "truncated" : null,
        fatalFindings: [compactRequestError?.code, compactRequestError?.responseFailureType],
        previousUsableCandidate: false,
        retryReason: compactRequestError?.code || compactRequestError?.responseFailureType || null,
        outcome: "provider_failure",
      });
      recordOrchestrationGeneration(orchestrationTelemetry, {
        error: compactRequestError,
        usageOverride: null,
        debugContext: solveDebugContext,
        compact: true,
        startedAt: compactStartedAt,
        compactRetryAttempted: true,
      });
      throw compactRequestError;
    }
    usage = mergeUsage(usage, compactResponse.usage || null);
    aiCallCount = dispatchedCallCount() ?? aiCallCount + providerCallCountFromResponse(compactResponse);
    compactFallback = true;
    try {
      parsed = parseJsonResponse(
        compactResponse,
        (value) => normalizeProviderSolveCandidate(value, { compact: true, originalProblem }),
        {
          ...solveDebugContext,
          purpose: "math_compact_solve_retry",
          schemaValidator: "assertCompactSolveResponse",
          promptHash: hashDebugText(compactPrompt),
          retryPurpose: "compact",
          attemptType: generatedAttemptType(debugContext, true),
        }
      );
    } catch (compactError) {
      attachOpenAiUsageToError(compactError, usage, aiCallCount);
      logSolveCandidateOutcome({
        requestId: solveDebugContext.requestId || null,
        attemptId: compactGenerationAttemptId,
        candidateId: compactCandidateId,
        solveMode: "compact",
        model: compactError?._omniOpenAiDiagnostics?.model || null,
        providerCompletionStatus: compactError?.responseFailureType === RESPONSE_FAILURE_TYPES.TRUNCATED ? "incomplete" : "completed",
        truncationState: compactError?.responseFailureType === RESPONSE_FAILURE_TYPES.TRUNCATED ? "truncated" : "complete",
        fatalFindings: [compactError?.code, compactError?.responseFailureType, ...(compactError?.solutionIssues || [])],
        previousUsableCandidate: false,
        retryReason: compactError?.code || compactError?.responseFailureType || null,
        outcome: "rejected",
      });
      recordOrchestrationGeneration(orchestrationTelemetry, {
        error: compactError,
        usageOverride: compactResponse.usage || null,
        debugContext: solveDebugContext,
        compact: true,
        startedAt: compactStartedAt,
        compactRetryAttempted: true,
      });
      await notifyGeneratedResponseFailure(onGeneratedResponseFailure, {
        error: compactError,
        stage: generatedAttemptType(debugContext, true),
        attemptType: generatedAttemptType(debugContext, true),
        prompt: compactPrompt,
        promptHash: hashDebugText(compactPrompt),
        purpose: "math_compact_solve_retry",
        originalProblem,
        debugContext: {
          ...solveDebugContext,
          retryPurpose: "compact",
        },
        failureClassification: "response_generation_failure",
        qualityRepairAttempted: false,
        compactRetryAttempted: true,
        freshEscalationAttempted: false,
      });
      throw compactError;
    }
    recordOrchestrationGeneration(orchestrationTelemetry, {
      value: parsed,
      usageOverride: compactResponse.usage || null,
      debugContext: solveDebugContext,
      compact: true,
      startedAt: compactStartedAt,
      candidateProduced: true,
      compactRetryAttempted: true,
    });
    logSolveCandidateOutcome({
      requestId: solveDebugContext.requestId || null,
      attemptId: compactGenerationAttemptId,
      candidateId: compactCandidateId,
      solveMode: "compact",
      model: compactResponse?._omniOpenAiMeta?.model || compactResponse?.model || null,
      providerCompletionStatus: "completed",
      truncationState: "complete",
      previousUsableCandidate: false,
      normalizationActions: parsed?._omniNormalizationActions || [],
      recoverableFindings: parsed?._omniRecoverableFindings || [],
      warnings: parsed?._omniWarnings || [],
      outcome: "parsed_candidate",
    });
  }
  if (!compactFallback) {
    recordOrchestrationGeneration(orchestrationTelemetry, {
      value: parsed,
      debugContext: solveDebugContext,
      startedAt: fullStartedAt,
      candidateProduced: true,
    });
    logSolveCandidateOutcome({
      requestId: solveDebugContext.requestId || null,
      attemptId: fullGenerationAttemptId,
      candidateId: fullCandidateId,
      solveMode: solveDebugContext.solveMode || debugAttemptType(solveDebugContext),
      model: responseBody?._omniOpenAiMeta?.model || responseBody?.model || null,
      providerCompletionStatus: "completed",
      truncationState: "complete",
      normalizationActions: parsed?._omniNormalizationActions || [],
      recoverableFindings: parsed?._omniRecoverableFindings || [],
      warnings: parsed?._omniWarnings || [],
      outcome: "parsed_candidate",
    });
  }
  const result = parsed;

  if (parsed?._omniOpenAiDiagnostics) {
    attachOpenAiDiagnostics(result, {
      ...parsed._omniOpenAiDiagnostics,
      routeAttemptId,
      attemptId: compactFallback ? compactGenerationAttemptId : fullGenerationAttemptId,
      candidateId: compactFallback ? compactCandidateId : fullCandidateId,
      compactFallback,
      aiCallCount,
    });
  }

  logOpenAiDebug("normalized_solution", {
    requestId: debugContext.requestId || null,
    purpose,
    compactFallback,
    aiCallCount,
    problemLatex: result.problemLatex || result.expression || result.extractedProblemLatex || originalProblem,
    finalAnswerLatex: result.finalAnswerLatex || result.finalAnswer || "",
    stepCount: Array.isArray(result.steps) ? result.steps.length : 0,
    normalizedSolution: result,
  });

  if (compactFallback) {
    result.runtimeNotice = "Compact explanation generated because the full structured response was too long.";
  }

  if (image) {
    console.info("[omnimath:image-openai-output]", {
      extractedProblemText: result.extractedProblemText || "",
      extractedProblemLatex: result.extractedProblemLatex || result.expression || "",
      firstStepLatex: result.steps?.[0]?.math || "",
      finalAnswerLatex: result.finalAnswerLatex || result.finalAnswer || "",
    });
  }

  Object.defineProperty(result, "_aiUsage", {
    enumerable: false,
    configurable: true,
    value: usage,
  });
  Object.defineProperty(result, "_aiCallCount", {
    enumerable: false,
    configurable: true,
    value: aiCallCount,
  });
  return result;
}

const compactImageExtractionIssueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "message", "severity"],
  properties: {
    type: { type: "string" },
    message: { type: "string" },
    severity: { type: "string", enum: ["low", "medium", "high"] },
  },
};

const compactImageExtractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["extractedProblemLatex", "confidence", "issues"],
  properties: {
    extractedProblemLatex: { type: "string" },
    confidence: { type: "number" },
    issues: {
      type: "array",
      maxItems: 3,
      items: compactImageExtractionIssueSchema,
    },
  },
};

function assertCompactImageExtractionResponse(value) {
  const providerIssues = Array.isArray(value?.issues) ? value.issues : [];
  const explicitlyUnreadable = providerIssues.length === 1
    && providerIssues[0]?.type === "image_unreadable";
  return assertImageExtractionResponse({
    ...value,
    // The compact recovery intentionally avoids a second long transcription.
    // Exact LaTeX remains human-reviewable and is the canonical extraction.
    extractedProblemText: value?.extractedProblemLatex,
    issues: explicitlyUnreadable
      ? providerIssues
      : [
          ...providerIssues,
          {
            type: "compact_extraction_recovery",
            message: "Extraction recovered from a cut-off response; review the transcription before solving.",
            severity: "medium",
          },
        ],
  });
}

function buildCompactImageExtractionPrompt(prompt = "") {
  return `${prompt}

Compact recovery contract:
- The previous extraction was explicitly cut off by the output-token limit.
- Return only extractedProblemLatex, confidence, and issues.
- Transcribe the complete problem exactly once in extractedProblemLatex.
- Use at most three concise issue objects and do not repeat the problem in issue messages.
- Do not solve, summarize, or add prose outside the strict JSON object.`;
}

function isExplicitImageExtractionTokenTruncation(error = {}) {
  const reason = String(
    error.finishReason
    || error?._omniOpenAiDiagnostics?.incompleteReason
    || "",
  ).toLowerCase();
  return error.code === "AI_RESPONSE_TRUNCATED"
    && ["max_output_tokens", "max_tokens", "length"].includes(reason);
}

function classifyImageExtractionTransportError(error) {
  const failureType = error?.openAiTransportDiagnostics?.finalInfrastructureFailureType;
  if (failureType === "request_timeout" || failureType === "connection_timeout" || failureType === "timeout") {
    error.code = "AI_REQUEST_TIMEOUT";
    error.responseFailureType = "provider_timeout";
    error.publicMessage = "Image extraction timed out before the provider returned a result.";
  }
  return error;
}

export async function createImageProblemExtraction({
  prompt,
  image,
  debugContext = {},
  deadlineAt = null,
}) {
  const logicalImageIngestionRequestId = debugContext.logicalImageIngestionRequestId
    || debugContext.ingestionRequestId
    || debugContext.requestId
    || `image-ingestion:${crypto.randomUUID()}`;
  const imageHash = debugContext.imageHash || crypto
    .createHash("sha256")
    .update(image.buffer)
    .digest("hex");
  const initialExtractionAttemptId = debugContext.extractionAttemptId
    || `${logicalImageIngestionRequestId}:extraction:initial`;
  const lifecycleDebugContext = {
    ...debugContext,
    requestId: debugContext.requestId || logicalImageIngestionRequestId,
    logicalImageIngestionRequestId,
    imageHash,
    extractionAttemptId: initialExtractionAttemptId,
  };
  const imageDataUrl = `data:${image.contentType};base64,${image.buffer.toString("base64")}`;
  const imageContent = {
    type: "input_image",
    image_url: imageDataUrl,
    detail: "high",
  };
  const content = [{ type: "input_text", text: prompt }, imageContent];
  const timeoutResolution = resolveOpenAiRequestTimeout("imageExtraction");
  const extractionDeadlineAt = Number.isFinite(Number(deadlineAt)) && Number(deadlineAt) > 0
    ? Number(deadlineAt)
    : Date.now() + timeoutResolution.timeoutMs;
  const fullTokenConfig = getImageExtractionOutputTokenConfig({ debugContext: lifecycleDebugContext });
  const initialDebugContext = {
    ...lifecycleDebugContext,
    attemptType: lifecycleDebugContext.attemptType || "image-extraction-initial",
    solveDeadlineAt: extractionDeadlineAt,
  };

  console.info("[omnimath:image-openai-forward]", {
    forwarded: true,
    purpose: "math_image_extract",
    filename: image.filename || null,
    contentType: image.contentType,
    bytes: image.buffer?.length || 0,
    dataUrlChars: imageDataUrl.length,
    requestId: lifecycleDebugContext.requestId,
    logicalImageIngestionRequestId,
    imageHash,
    extractionAttemptId: initialExtractionAttemptId,
    configuredTimeoutMs: timeoutResolution.timeoutMs,
    remainingLogicalBudgetMs: Math.max(0, extractionDeadlineAt - Date.now()),
  });

  let responseBody;
  try {
    responseBody = await requestOpenAi({
      content,
      purpose: "math_image_extract",
      schema: imageExtractionSchema,
      schemaName: "math_image_extract",
      maxOutputTokens: fullTokenConfig.effectiveMaxOutputTokens,
      outputTokenConfig: fullTokenConfig,
      modelPath: "imageExtraction",
      debugContext: initialDebugContext,
    });
  } catch (error) {
    attachOpenAiUsageToError(error, error?._aiUsage || null, providerCallCountFromError(error));
    throw classifyImageExtractionTransportError(error);
  }

  let usage = responseBody.usage || null;
  let aiCallCount = providerCallCountFromResponse(responseBody);
  let result;
  try {
    result = parseJsonResponse(responseBody, assertImageExtractionResponse, {
      ...initialDebugContext,
      purpose: "math_image_extract",
      schemaValidator: "assertImageExtractionResponse",
      strictJsonEnvelope: true,
    });
  } catch (error) {
    const remainingLogicalBudgetMs = Math.max(0, extractionDeadlineAt - Date.now());
    const compactRetryAllowed = isExplicitImageExtractionTokenTruncation(error)
      && remainingLogicalBudgetMs >= MIN_IMAGE_EXTRACTION_COMPACT_RETRY_MS;
    if (!compactRetryAllowed) {
      if (isExplicitImageExtractionTokenTruncation(error)
        && remainingLogicalBudgetMs < MIN_IMAGE_EXTRACTION_COMPACT_RETRY_MS) {
        error.retrySuppressedReason = "insufficient_remaining_extraction_budget";
      }
      attachOpenAiUsageToError(error, usage, aiCallCount);
      throw error;
    }

    const compactTokenConfig = getImageExtractionOutputTokenConfig({
      compact: true,
      debugContext: lifecycleDebugContext,
    });
    const compactPrompt = buildCompactImageExtractionPrompt(prompt);
    const compactDebugContext = {
      ...lifecycleDebugContext,
      extractionAttemptId: `${initialExtractionAttemptId}:compact`,
      attemptType: "image-extraction-compact",
      retryPurpose: "compact",
      solveDeadlineAt: extractionDeadlineAt,
    };
    console.warn("[omnimath:image-extraction-retry]", {
      requestId: lifecycleDebugContext.requestId,
      logicalImageIngestionRequestId,
      imageHash,
      extractionAttemptId: compactDebugContext.extractionAttemptId,
      retryReason: "provider_max_output_tokens",
      priorOutputContract: "full",
      selectedOutputContract: "compact",
      remainingLogicalBudgetMs,
      configuredTimeoutMs: timeoutResolution.timeoutMs,
      configuredMaxOutputTokens: compactTokenConfig.configuredMaxOutputTokens,
      effectiveMaxOutputTokens: compactTokenConfig.effectiveMaxOutputTokens,
    });

    let compactResponse;
    try {
      compactResponse = await requestOpenAi({
        content: [{ type: "input_text", text: compactPrompt }, imageContent],
        purpose: "math_image_extract_compact_retry",
        schema: compactImageExtractionSchema,
        schemaName: "math_image_extract_compact",
        maxOutputTokens: compactTokenConfig.effectiveMaxOutputTokens,
        outputTokenConfig: compactTokenConfig,
        modelPath: "imageExtraction",
        debugContext: compactDebugContext,
      });
    } catch (compactRequestError) {
      const compactUsage = compactRequestError?._aiUsage || null;
      attachOpenAiUsageToError(
        classifyImageExtractionTransportError(compactRequestError),
        mergeUsage(usage, compactUsage),
        aiCallCount + providerCallCountFromError(compactRequestError),
      );
      throw compactRequestError;
    }

    usage = mergeUsage(usage, compactResponse.usage || null);
    aiCallCount += providerCallCountFromResponse(compactResponse);
    try {
      result = parseJsonResponse(compactResponse, assertCompactImageExtractionResponse, {
        ...compactDebugContext,
        purpose: "math_image_extract_compact_retry",
        schemaValidator: "assertCompactImageExtractionResponse",
        strictJsonEnvelope: true,
      });
    } catch (compactError) {
      attachOpenAiUsageToError(compactError, usage, aiCallCount);
      throw compactError;
    }

    attachOpenAiDiagnostics(result, {
      ...result?._omniOpenAiDiagnostics,
      extractionRecoveryAttempted: true,
      extractionRecoveryReason: "provider_max_output_tokens",
      selectedExtractionContract: "compact",
      initialConfiguredMaxOutputTokens: fullTokenConfig.configuredMaxOutputTokens,
      initialEffectiveMaxOutputTokens: fullTokenConfig.effectiveMaxOutputTokens,
      providerCallCount: aiCallCount,
    });
  }

  Object.defineProperty(result, "_aiUsage", {
    enumerable: false,
    configurable: true,
    value: usage,
  });
  Object.defineProperty(result, "_aiCallCount", {
    enumerable: false,
    configurable: true,
    value: aiCallCount,
  });
  return result;
}

function followupModelPath(scope = "lens") {
  return scope === "workspace" ? "solver" : "pinned";
}

export async function createFollowupAnswer({
  prompt,
  scope = "lens",
  deadlineAt = null,
  debugContext = {},
}) {
  const modelPath = followupModelPath(scope);
  const result = await requestOpenAiText({
    content: [{ type: "input_text", text: prompt }],
    purpose: "math_explanation_followup",
    modelPath,
    deadlineAt,
    timeoutRole: "pinned",
    requireComplete: true,
    debugContext: { ...debugContext, followupScope: scope },
  });
  return result;
}

export async function streamFollowupAnswer({
  prompt,
  scope = "lens",
  deadlineAt = null,
  debugContext = {},
  signal = null,
  onTextDelta = null,
  onProviderEvent = null,
} = {}) {
  const modelPath = followupModelPath(scope);
  const result = await streamOpenAiTextResponse({
    prompt,
    purpose: "math_explanation_followup_stream",
    modelPath,
    maxOutputTokens: 900,
    deadlineAt,
    timeoutRole: "pinned",
    includeModelParameters: false,
    maxOutputChars: 128_000,
    // The existing follow-up path applies the pinned timeout/retry policy even
    // when workspace scope retains solver model routing. Keep both scopes at
    // two pre-output transport attempts and never add a semantic retry.
    maxProviderAttempts: 2,
    signal,
    onTextDelta,
    onProviderEvent,
    debugContext: { ...debugContext, followupScope: scope },
  });
  const answer = String(result.outputText || "").trim();
  if (!answer) {
    const error = Object.assign(new Error("The AI service returned an empty follow-up answer."), {
      statusCode: 502,
      code: "INVALID_AI_RESPONSE",
      responseFailureType: "empty_text",
      publicMessage: "The AI service returned an incomplete explanation. Please try again.",
    });
    attachOpenAiUsageToError(error, result.usage, result.providerCallCount);
    throw attachOpenAiDiagnosticsToError(error, result);
  }
  return attachOpenAiDiagnostics({ ...result, text: answer }, {
    requestId: debugContext.requestId || null,
    requestedModel: result.requestedModel,
    effectiveModel: result.effectiveModel,
    providerModel: result.providerModel,
    accountingModel: result.accountingModel,
    modelRole: result.role,
    reasoningEffort: result.reasoningEffort,
    responseId: result.responseId,
    responseStatus: result.status,
    usage: result.usage,
    providerCallCount: result.providerCallCount,
    retryCount: result.retryCount,
    providerEventCount: result.providerEventCount,
    firstProviderByteMs: result.firstProviderByteMs,
    firstProviderEventMs: result.firstProviderEventMs,
    durationMs: result.durationMs,
    recoveryPurpose: debugContext.recoveryPurpose || null,
  });
}

export async function createLazyTokenExplanation({ prompt, mode = "hover", debugContext = {} }) {
  const modelPath = mode === "pin" ? "pinned" : "hover";
  const responseBody = await requestOpenAi({
    content: [{ type: "input_text", text: prompt }],
    purpose: mode === "pin" ? "math_pin_explanation" : "math_token_explanation",
    schema: lazyTokenExplanationSchema,
    schemaName: "math_token_explanation",
    maxOutputTokens: getLazyMaxOutputTokens(),
    modelPath,
    debugContext,
  });
  const parsed = parseJsonResponse(responseBody, assertLazyTokenExplanation, {
      ...debugContext,
      purpose: mode === "pin" ? "math_pin_explanation" : "math_token_explanation",
      schemaValidator: "assertLazyTokenExplanation",
    });
  return attachOpenAiDiagnostics({
    ...parsed,
    usage: responseBody.usage || null,
  }, parsed._omniOpenAiDiagnostics || {});
}

export async function createCompareMethods({ prompt, debugContext = {} }) {
  const responseBody = await requestOpenAi({
    content: [{ type: "input_text", text: prompt }],
    purpose: "math_compare_methods",
    schema: compareMethodsSchema,
    schemaName: "math_compare_methods",
    maxOutputTokens: getSolveMaxOutputTokens(),
    modelPath: "solver",
    debugContext,
  });
  const parsed = parseJsonResponse(responseBody, assertCompareMethods);
  return attachOpenAiDiagnostics({
    ...parsed,
    usage: responseBody.usage || null,
  }, parsed._omniOpenAiDiagnostics || {});
}

export async function debugOpenAiConnection() {
  const result = await requestOpenAiText({
    purpose: "debug_openai",
    maxOutputTokens: 20,
    content: [{ type: "input_text", text: "Reply with exactly: ok" }],
  });

  return {
    ok: true,
    model: getOpenAiModel(),
    output: result.text.slice(0, 80),
    usage: result.usage ? normalizeOpenAiUsage(result.usage) : null,
  };
}
