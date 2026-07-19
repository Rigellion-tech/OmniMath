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
import { getOpenAiModelForPath, getOpenAiModels, getOpenAiSamplingForPath, logOpenAiModelSelection } from "./openaiModels.js";

loadEnvFiles();

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MAX_OUTPUT_TOKENS = 8000;
const DEFAULT_SOLVE_MAX_OUTPUT_TOKENS = 4200;
const DEFAULT_LAZY_MAX_OUTPUT_TOKENS = 700;
const DEFAULT_IMAGE_EXTRACTION_MAX_OUTPUT_TOKENS = 800;
const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1700;
const DEFAULT_OPENAI_REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_OPENAI_IMAGE_EXTRACTION_TIMEOUT_MS = 45000;
const DEFAULT_OPENAI_RETRY_BASE_DELAY_MS = 500;
const COMPLEX_SOLVE_MAX_OUTPUT_TOKENS = 6500;
const COMPACT_SOLVE_MAX_OUTPUT_TOKENS = 2400;
const DEFAULT_INPUT_COST_PER_1M_TOKENS = 5;
const DEFAULT_OUTPUT_COST_PER_1M_TOKENS = 30;

function isOpenAiDebugEnabled() {
  return process.env.NODE_ENV !== "production" && (
    process.env.OMNIMATH_DEBUG_SOLVE === "true"
    || process.env.OMNIMATH_DEBUG_SOLVE === "1"
    || process.env.VITE_DEBUG_SOLUTION_STATE === "true"
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

function getOpenAiRequestTimeoutMs(modelPath = "solver") {
  const fallback = modelPath === "imageExtraction"
    ? DEFAULT_OPENAI_IMAGE_EXTRACTION_TIMEOUT_MS
    : DEFAULT_OPENAI_REQUEST_TIMEOUT_MS;
  return readPositiveNumber("OPENAI_REQUEST_TIMEOUT_MS", fallback);
}

function getOpenAiRetryBaseDelayMs() {
  return readPositiveNumber("OPENAI_RETRY_BASE_DELAY_MS", DEFAULT_OPENAI_RETRY_BASE_DELAY_MS);
}

function getOpenAiMaxAttempts(modelPath = "solver") {
  if (modelPath === "solver") return 3;
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
  return readPositiveNumber("OPENAI_IMAGE_EXTRACTION_MAX_OUTPUT_TOKENS", DEFAULT_IMAGE_EXTRACTION_MAX_OUTPUT_TOKENS);
}

function getSolveOutputTokenBudget({ prompt = "", compact = false } = {}) {
  const configured = getSolveMaxOutputTokens();
  if (compact) return Math.max(COMPACT_SOLVE_MAX_OUTPUT_TOKENS, Math.min(configured, COMPLEX_SOLVE_MAX_OUTPUT_TOKENS));

  const promptText = String(prompt || "");
  const complex = promptText.length > 2500
    || /Stokes|Green|curl|\\nabla|\\iint|\\iiint|∬|∭|vector field|surface integral/iu.test(promptText);
  return complex ? Math.max(configured, COMPLEX_SOLVE_MAX_OUTPUT_TOKENS) : configured;
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
  return {
    hasApiKey: isOpenAiConfigured(),
    model: getOpenAiModel(),
    models: getOpenAiModels(),
    lazyModel: getLazyOpenAiModel(),
    maxOutputTokens: getMaxOutputTokens(),
    solveMaxOutputTokens: getSolveMaxOutputTokens(),
    lazyMaxOutputTokens: getLazyMaxOutputTokens(),
    imageExtractionMaxOutputTokens: getImageExtractionMaxOutputTokens(),
    requestTimeoutMs: getOpenAiRequestTimeoutMs("solver"),
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

function logOpenAiRequest({ purpose, payload }) {
  const config = getOpenAiRuntimeConfig();
  console.info("[omnimath:openai-request]", {
    purpose,
    hasApiKey: config.hasApiKey,
    model: payload.model,
    maxOutputTokens: config.maxOutputTokens,
    organizationConfigured: config.organizationConfigured,
    projectConfigured: config.projectConfigured,
    payloadShape: summarizePayload(payload),
  });
}

function logOpenAiProviderError({ purpose, response, responseBody }) {
  const providerError = responseBody?.error || {};
  const config = getOpenAiRuntimeConfig();
  console.error("[omnimath:openai-error]", {
    purpose,
    status: response.status,
    statusText: response.statusText,
    model: responseBody?.model || config.model,
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

function logOpenAiResponse({ purpose, responseBody, outputText = "" }) {
  console.info("[omnimath:openai-response]", {
    purpose,
    model: responseBody?.model || null,
    finishReason: getFinishReason(responseBody) || null,
    status: responseBody?.status || null,
    outputChars: String(outputText || "").length,
    usage: responseBody?.usage || null,
  });
}

function logOpenAiNonProviderError({ purpose, error }) {
  console.error("[omnimath:openai-exception]", {
    purpose,
    model: getOpenAiModel(),
    message: error.message,
    cause: error.cause
      ? {
          name: error.cause.name,
          code: error.cause.code,
          message: error.cause.message,
          stack: error.cause.stack,
        }
      : null,
    stack: error.stack,
  });
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

function getErrorCauseCode(error) {
  return error?.cause?.code
    || error?.code
    || error?.cause?.name
    || error?.name
    || null;
}

function getErrorCauseMessage(error) {
  return error?.cause?.message || error?.message || "";
}

function isTransientNetworkError(error) {
  const code = getErrorCauseCode(error);
  if (TRANSIENT_NETWORK_CODES.has(code)) return true;
  const message = getErrorCauseMessage(error);
  if (code === "ENOTFOUND") {
    return /api\.openai\.com|getaddrinfo|dns|resolve/i.test(message);
  }
  return /connect timeout|timed out|connection.*reset|network.*temporar/i.test(message);
}

function isRetryableProviderError(response, responseBody) {
  if (!RETRYABLE_PROVIDER_STATUSES.has(response.status)) return false;
  const providerCode = responseBody?.error?.code || responseBody?.error?.type || null;
  if (providerCode && NON_RETRYABLE_PROVIDER_CODES.has(providerCode)) return false;
  if (response.status === 429 && /quota|billing/i.test(String(responseBody?.error?.message || ""))) return false;
  return true;
}

function createOpenAiUnavailableError(error, { statusCode = 503 } = {}) {
  return Object.assign(new Error(`OpenAI request failed: ${getErrorCauseMessage(error) || "service unavailable"}`, { cause: error }), {
    statusCode,
    code: "AI_SERVICE_UNAVAILABLE",
    publicMessage: "The AI service is temporarily unreachable. Check your internet connection and try again.",
    providerStatus: error?.providerStatus || null,
    providerCode: error?.providerCode || null,
    networkCauseCode: getErrorCauseCode(error),
    networkCauseMessage: getErrorCauseMessage(error),
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

function logOpenAiRetry({ purpose, model, attempt, maxAttempts, startedAt, error, response }) {
  console.warn("[omnimath:openai-retry]", {
    purpose,
    model,
    attempt,
    maxAttempts,
    causeCode: response?.status || getErrorCauseCode(error),
    causeMessage: response
      ? response.statusText || `HTTP ${response.status}`
      : getErrorCauseMessage(error),
    elapsedMs: Date.now() - startedAt,
  });
}

async function readOpenAiResponseBody(response) {
  const responseText = await response.text();
  try {
    return responseText ? JSON.parse(responseText) : {};
  } catch {
    return { error: { message: responseText } };
  }
}

async function fetchOpenAiWithRetry({ purpose, modelPath, payload, debugContext = {} }) {
  const model = payload.model;
  const maxAttempts = getOpenAiMaxAttempts(modelPath);
  const timeoutMs = getOpenAiRequestTimeoutMs(modelPath);
  const startedAt = Date.now();
  let lastRetryableError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: createOpenAiHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: getOpenAiAgent(timeoutMs),
      });
    } catch (error) {
      logOpenAiNonProviderError({ purpose, error });
      if (error.code === "SERVER_CONFIG_ERROR") throw error;
      if (!isTransientNetworkError(error) || attempt >= maxAttempts) {
        throw createOpenAiUnavailableError(error);
      }

      lastRetryableError = error;
      logOpenAiRetry({ purpose, model, attempt, maxAttempts, startedAt, error });
      await delay(getOpenAiRetryDelayMs(attempt));
      continue;
    }

    const responseBody = await readOpenAiResponseBody(response);
    if (response.ok) {
      Object.defineProperty(responseBody, "_omniOpenAiMeta", {
        enumerable: false,
        configurable: true,
        value: {
          requestId: debugContext.requestId || null,
          purpose,
          model,
          modelPath,
          attempt,
          maxAttempts,
          retryCount: attempt - 1,
          timeoutMs,
          temperature: payload.temperature ?? null,
          topP: payload.top_p ?? null,
          temperatureSource: payload.temperature === undefined ? "provider_default" : "payload",
          topPSource: payload.top_p === undefined ? "provider_default" : "payload",
          normalizedProblemHash: debugContext.normalizedProblem ? hashDebugText(debugContext.normalizedProblem) : null,
          promptHash: debugContext.promptHash || null,
          attemptType: debugAttemptType(debugContext),
          promptText: debugContentText(payload.input?.[0]?.content || []),
          modelInputMessages: createDiagnosticInputMessages(payload.input),
          maxOutputTokens: payload.max_output_tokens ?? null,
          schemaName: payload.text?.format?.name || null,
        },
      });
      logOpenAiDebug("http_response", {
        requestId: debugContext.requestId || null,
        purpose,
        model,
        modelPath,
        temperature: payload.temperature ?? null,
        topP: payload.top_p ?? null,
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

    logOpenAiProviderError({ purpose, response, responseBody });
    if (!isRetryableProviderError(response, responseBody)) {
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
      throw createOpenAiUnavailableError(providerError, {
        statusCode: response.status === 429 ? 502 : 503,
      });
    }

    lastRetryableError = providerError;
    logOpenAiRetry({ purpose, model, attempt, maxAttempts, startedAt, error: providerError, response });
    await delay(getOpenAiRetryDelayMs(attempt));
  }

  throw createOpenAiUnavailableError(lastRetryableError || new Error("OpenAI request failed."));
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

export function normalizeOpenAiUsage(usage, fallbackTotalTokens = 0) {
  const inputTokens = Number(usage?.input_tokens || usage?.prompt_tokens || 0);
  const outputTokens = Number(usage?.output_tokens || usage?.completion_tokens || 0);
  const totalTokens = Number(usage?.total_tokens || 0)
    || inputTokens + outputTokens
    || Math.max(0, Math.ceil(Number(fallbackTotalTokens) || 0));

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

export function estimateOpenAiCost(usage) {
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

function extractOutputText(responseBody) {
  if (typeof responseBody.output_text === "string") return responseBody.output_text;

  for (const item of responseBody.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") return content.text;
    }
  }

  const refusal = responseBody.output
    ?.flatMap((item) => item.content || [])
    ?.find((content) => content.refusal)?.refusal;

  if (refusal) {
    throw Object.assign(new Error(refusal), {
      statusCode: 502,
      code: "AI_REQUEST_REFUSED",
      publicMessage: "The AI service declined to complete that explanation.",
    });
  }

  throw Object.assign(new Error("OpenAI response did not include text output."), {
    statusCode: 502,
    code: "AI_RESPONSE_INVALID",
    compactRetryable: true,
    publicMessage: "The AI service returned an incomplete explanation.",
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
    publicMessage: "The model response was cut off. Retrying with a shorter explanation...",
    invalidOutputText: outputText,
    finishReason: getFinishReason(responseBody) || null,
  });
}

export function parseJsonResponse(responseBody, assertFn, debugContext = {}) {
  const outputText = extractOutputText(responseBody);
  logOpenAiResponse({ purpose: "json_parse", responseBody, outputText });
  const meta = responseBody?._omniOpenAiMeta || {};
  const baseDiagnostics = {
    requestId: debugContext.requestId || meta.requestId || null,
    purpose: debugContext.purpose || meta.purpose || "json_parse",
    model: meta.model || responseBody?.model || null,
    responseModel: responseBody?.model || null,
    modelPath: meta.modelPath || null,
    temperature: meta.temperature ?? null,
    topP: meta.topP ?? null,
    temperatureSource: meta.temperatureSource || "provider_default",
    topPSource: meta.topPSource || "provider_default",
    promptHash: debugContext.promptHash || meta.promptHash || null,
    normalizedProblemHash: meta.normalizedProblemHash || (debugContext.normalizedProblem ? hashDebugText(debugContext.normalizedProblem) : null),
    attemptType: debugContext.attemptType || meta.attemptType || debugAttemptType(debugContext),
    attempt: meta.attempt ?? null,
    maxAttempts: meta.maxAttempts ?? null,
    retryCount: meta.retryCount ?? null,
    finishReason: getFinishReason(responseBody) || null,
    responseId: responseBody?.id || null,
    responseStatus: responseBody?.status || null,
    incompleteDetails: responseBody?.incomplete_details || null,
    rawOutputHash: hashDebugText(outputText),
    rawOutputChars: outputText.length,
    rawOutput: outputText,
    promptText: meta.promptText || "",
    modelInputMessages: meta.modelInputMessages || [],
    maxOutputTokens: meta.maxOutputTokens ?? null,
    schemaName: meta.schemaName || null,
    schemaValidator: debugContext.schemaValidator || null,
    usage: responseBody?.usage || null,
  };
  logOpenAiDebug("raw_model_response", {
    requestId: baseDiagnostics.requestId,
    purpose: baseDiagnostics.purpose,
    model: baseDiagnostics.model,
    temperature: baseDiagnostics.temperature,
    topP: baseDiagnostics.topP,
    temperatureSource: baseDiagnostics.temperatureSource,
    topPSource: baseDiagnostics.topPSource,
    promptHash: baseDiagnostics.promptHash,
    normalizedProblemHash: baseDiagnostics.normalizedProblemHash,
    attemptType: baseDiagnostics.attemptType,
    retryCount: baseDiagnostics.retryCount,
    finishReason: baseDiagnostics.finishReason,
    rawOutputHash: baseDiagnostics.rawOutputHash,
    rawOutputChars: baseDiagnostics.rawOutputChars,
    rawOutput: outputText,
  });
  if (isLengthFinishReason(responseBody)) {
    const error = createTruncatedJsonError(outputText, responseBody);
    attachOpenAiDiagnosticsToError(error, {
      ...baseDiagnostics,
      responseFailureType: RESPONSE_FAILURE_TYPES.TRUNCATED,
    });
    throw error;
  }

  const extracted = extractFirstCompleteJsonObject(outputText);
  if (!extracted.complete) {
    const error = Object.assign(new Error("OpenAI returned incomplete JSON."), {
      statusCode: 502,
      code: "AI_RESPONSE_INVALID",
      compactRetryable: true,
      responseFailureType: RESPONSE_FAILURE_TYPES.TRUNCATED,
      publicMessage: "The AI service returned an incomplete explanation.",
      invalidOutputText: outputText,
    });
    attachOpenAiDiagnosticsToError(error, {
      ...baseDiagnostics,
      responseFailureType: RESPONSE_FAILURE_TYPES.TRUNCATED,
    });
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(extracted.text);
  } catch (error) {
    logOpenAiDebug("json_parse_failure", {
      requestId: debugContext.requestId || meta.requestId || null,
      purpose: debugContext.purpose || meta.purpose || "json_parse",
      schemaValidator: debugContext.schemaValidator || assertFn?.name || "anonymous",
      code: error.code || null,
      message: error.message,
      failedRule: error.code || error.message,
    });
    const wrapped = Object.assign(new Error("OpenAI returned malformed JSON."), {
      statusCode: 502,
      code: "AI_RESPONSE_INVALID",
      compactRetryable: true,
      responseFailureType: RESPONSE_FAILURE_TYPES.JSON_PARSE,
      publicMessage: "The AI service returned an invalid explanation.",
      invalidOutputText: outputText,
    });
    attachOpenAiDiagnosticsToError(wrapped, {
      ...baseDiagnostics,
      responseFailureType: RESPONSE_FAILURE_TYPES.JSON_PARSE,
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
      ...baseDiagnostics,
      parsedJson: parsed,
    });
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
      attachOpenAiDiagnosticsToError(error, {
        ...baseDiagnostics,
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
    attachOpenAiDiagnosticsToError(wrapped, {
      ...baseDiagnostics,
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
  model = getOpenAiModelForPath(modelPath),
  debugContext = {},
}) {
  const sampling = getOpenAiSamplingForPath(modelPath);
  const payload = {
    model,
    input: [{ role: "user", content }],
    max_output_tokens: maxOutputTokens,
    ...sampling,
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        strict: true,
        schema,
      },
    },
  };
  logOpenAiModelSelection(modelPath, { purpose });
  logOpenAiRequest({ purpose, payload });
  logOpenAiDebug("request_settings", {
    requestId: debugContext.requestId || null,
    purpose,
    model,
    modelPath,
    promptHash: hashDebugText(debugContentText(content)),
    configuredPromptHash: debugContext.promptHash || null,
    normalizedProblemHash: debugContext.normalizedProblem ? hashDebugText(debugContext.normalizedProblem) : null,
    attemptType: debugAttemptType(debugContext),
    maxOutputTokens,
    temperature: payload.temperature ?? null,
    topP: payload.top_p ?? null,
    temperatureSource: payload.temperature === undefined ? "provider_default" : "payload",
    topPSource: payload.top_p === undefined ? "provider_default" : "payload",
    schemaName,
  });
  const responseBody = await fetchOpenAiWithRetry({ purpose, modelPath, payload, debugContext });

  logOpenAiResponse({ purpose, responseBody, outputText: extractOutputText(responseBody) });
  return responseBody;
}

async function requestOpenAiText({ content, maxOutputTokens = 900, purpose = "text_completion", modelPath = "solver" }) {
  const model = getOpenAiModelForPath(modelPath);
  const payload = {
    model,
    input: [{ role: "user", content }],
    max_output_tokens: maxOutputTokens,
  };
  logOpenAiModelSelection(modelPath, { purpose });
  logOpenAiRequest({ purpose, payload });
  const responseBody = await fetchOpenAiWithRetry({ purpose, modelPath, payload });

  return {
    text: extractOutputText(responseBody).trim(),
    usage: responseBody.usage || null,
  };
}

function mergeUsage(left, right) {
  if (!left && !right) return null;
  const a = normalizeOpenAiUsage(left);
  const b = normalizeOpenAiUsage(right);
  return {
    input_tokens: a.inputTokens + b.inputTokens,
    output_tokens: a.outputTokens + b.outputTokens,
    total_tokens: a.totalTokens + b.totalTokens,
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
  if (
    type === RESPONSE_FAILURE_TYPES.FIELD_STRUCTURE
    || hasIssueCode(error, "final_answer_splits_into_multiple_unrelated_fragments")
  ) {
    const codeText = issueCodes.length ? issueCodes.join(", ") : "field_structure";
    return [
      "The previous response violated the final-answer field contract. Retry in compact mode.",
      `Validation issue code: ${codeText}`,
      "",
      "Final-answer structure correction:",
      "- Return the final result as exactly one standalone mathematical expression.",
      "- Do not include derivation text in the final answer.",
      "- Do not include \\Rightarrow.",
      "- Do not include line breaks.",
      "- Do not include multiple unrelated equations.",
      "- Put derivation only in earlier steps.",
      "- For compact format, ensure the last step latex contains only the final standalone result.",
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
    "- Keep the final result as one standalone expression in the last step.",
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
- For equation solving, each displayed latex step must transform the equation currently being solved.
- Put coefficient facts and identity checks in reasoning, not as standalone latex steps.
- For perfect-square quadratics, use the shortest chain: original equation, factored square equation, linear equation, final answer.
- Preserve mathematical correctness over hover interactivity.
- Use compact equations for verification; avoid prose-heavy derivations.
- The last step latex is treated as finalAnswerLatex and must obey the standalone-final-expression contract: exactly one final expression, or one equation assigning the original expression to the final value.
- The last step latex must contain no prose, explanation, intermediate derivation, \\Rightarrow, multiline content, display separators, or multiple unrelated equations.
- Return JSON only.

Original problem context:
${originalProblem || "Use the problem from the prior prompt."}`;
}

function generatedAttemptType(debugContext = {}, compact = false) {
  const base = debugAttemptType(debugContext);
  const prefix = base === "repair" || base === "quality-repair" ? "repair" : "initial";
  return `${prefix}-${compact ? "compact" : "full"}`;
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

export async function createMathExplanation({
  prompt,
  image,
  originalProblem = "",
  debugContext = {},
  onGeneratedResponseFailure = null,
}) {
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
  let responseBody;
  try {
    responseBody = await requestOpenAi({
      content,
      purpose,
      schema: image ? imageSolveSchema : fastSolveSchema,
      schemaName: image ? "math_image_solve" : "math_fast_solve",
      maxOutputTokens: getSolveOutputTokenBudget({ prompt }),
      modelPath: "solver",
      debugContext,
    });
  } catch (error) {
    attachOpenAiUsageToError(error, null, 1);
    throw error;
  }
  let usage = responseBody.usage || null;
  let parsed;
  let compactFallback = false;
  let aiCallCount = 1;
  try {
    parsed = parseJsonResponse(
      responseBody,
      (value) => (image ? assertImageSolveResponse(value) : assertFastSolveResponse(value)),
      {
        ...debugContext,
        purpose,
        schemaValidator: image ? "assertImageSolveResponse" : "assertFastSolveResponse",
      }
    );
  } catch (error) {
    attachOpenAiUsageToError(error, usage, aiCallCount);
    await notifyGeneratedResponseFailure(onGeneratedResponseFailure, {
      error,
      stage: generatedAttemptType(debugContext, false),
      attemptType: generatedAttemptType(debugContext, false),
      prompt,
      promptHash: debugContext.promptHash || hashDebugText(prompt),
      purpose,
      originalProblem,
      debugContext,
    });
    if (!error.compactRetryable || image) throw error;
    console.warn("[omnimath:openai-compact-retry]", {
      purpose,
      reason: error.code,
      responseFailureType: error.responseFailureType || null,
      solutionIssues: error.solutionIssues || [],
      finishReason: error.finishReason || null,
      outputChars: String(error.invalidOutputText || "").length,
    });
    const compactPrompt = buildCompactSolvePrompt(prompt, originalProblem, error);
    let compactResponse;
    try {
      compactResponse = await requestOpenAi({
        content: [{ type: "input_text", text: compactPrompt }],
        purpose: "math_compact_solve_retry",
        schema: compactSolveSchema,
        schemaName: "math_compact_solve",
        maxOutputTokens: getSolveOutputTokenBudget({ prompt: compactPrompt, compact: true }),
        modelPath: "solver",
        debugContext: {
          ...debugContext,
          promptHash: hashDebugText(compactPrompt),
          retryPurpose: "compact",
          attemptType: generatedAttemptType(debugContext, true),
        },
      });
    } catch (compactRequestError) {
      attachOpenAiUsageToError(compactRequestError, usage, 2);
      throw compactRequestError;
    }
    usage = mergeUsage(usage, compactResponse.usage || null);
    aiCallCount = 2;
    compactFallback = true;
    try {
      parsed = parseJsonResponse(
        compactResponse,
        (value) => assertCompactSolveResponse(value, originalProblem),
        {
          ...debugContext,
          purpose: "math_compact_solve_retry",
          schemaValidator: "assertCompactSolveResponse",
          promptHash: hashDebugText(compactPrompt),
          retryPurpose: "compact",
          attemptType: generatedAttemptType(debugContext, true),
        }
      );
    } catch (compactError) {
      attachOpenAiUsageToError(compactError, usage, aiCallCount);
      await notifyGeneratedResponseFailure(onGeneratedResponseFailure, {
        error: compactError,
        stage: generatedAttemptType(debugContext, true),
        attemptType: generatedAttemptType(debugContext, true),
        prompt: compactPrompt,
        promptHash: hashDebugText(compactPrompt),
        purpose: "math_compact_solve_retry",
        originalProblem,
        debugContext: {
          ...debugContext,
          retryPurpose: "compact",
        },
      });
      throw compactError;
    }
  }
  const result = image
    ? convertImageSolveToMathExplanation(parsed)
    : convertFastSolveToMathExplanation(parsed, { originalProblem, includeProblemStep: false });

  if (parsed?._omniOpenAiDiagnostics) {
    attachOpenAiDiagnostics(result, {
      ...parsed._omniOpenAiDiagnostics,
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

export async function createImageProblemExtraction({ prompt, image }) {
  const content = [{ type: "input_text", text: prompt }];
  content.push({
    type: "input_image",
    image_url: `data:${image.contentType};base64,${image.buffer.toString("base64")}`,
    detail: "high",
  });

  console.info("[omnimath:image-openai-forward]", {
    forwarded: true,
    purpose: "math_image_extract",
    filename: image.filename || null,
    contentType: image.contentType,
    bytes: image.buffer?.length || 0,
    dataUrlChars: `data:${image.contentType};base64,`.length + image.buffer.toString("base64").length,
  });

  const responseBody = await requestOpenAi({
    content,
    purpose: "math_image_extract",
    schema: imageExtractionSchema,
    schemaName: "math_image_extract",
    maxOutputTokens: getImageExtractionMaxOutputTokens(),
    modelPath: "imageExtraction",
  });
  const usage = responseBody.usage || null;
  const result = parseJsonResponse(responseBody, assertImageExtractionResponse);

  Object.defineProperty(result, "_aiUsage", {
    enumerable: false,
    configurable: true,
    value: usage,
  });
  Object.defineProperty(result, "_aiCallCount", {
    enumerable: false,
    configurable: true,
    value: 1,
  });
  return result;
}

export async function createFollowupAnswer({ prompt }) {
  const result = await requestOpenAiText({
    content: [{ type: "input_text", text: prompt }],
  });
  return result;
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
  return {
    ...parseJsonResponse(responseBody, assertLazyTokenExplanation, {
      ...debugContext,
      purpose: mode === "pin" ? "math_pin_explanation" : "math_token_explanation",
      schemaValidator: "assertLazyTokenExplanation",
    }),
    usage: responseBody.usage || null,
  };
}

export async function createCompareMethods({ prompt }) {
  const responseBody = await requestOpenAi({
    content: [{ type: "input_text", text: prompt }],
    purpose: "math_compare_methods",
    schema: compareMethodsSchema,
    schemaName: "math_compare_methods",
    maxOutputTokens: getSolveMaxOutputTokens(),
    modelPath: "solver",
  });
  return {
    ...parseJsonResponse(responseBody, assertCompareMethods),
    usage: responseBody.usage || null,
  };
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
