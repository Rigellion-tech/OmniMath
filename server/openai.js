import { loadEnvFiles } from "./env.js";
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
} from "./mathExplanationSchema.js";
import { getOpenAiModelForPath, getOpenAiModels, logOpenAiModelSelection } from "./openaiModels.js";

loadEnvFiles();

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MAX_OUTPUT_TOKENS = 8000;
const DEFAULT_SOLVE_MAX_OUTPUT_TOKENS = 4200;
const DEFAULT_LAZY_MAX_OUTPUT_TOKENS = 700;
const DEFAULT_IMAGE_EXTRACTION_MAX_OUTPUT_TOKENS = 800;
const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1700;
const COMPLEX_SOLVE_MAX_OUTPUT_TOKENS = 6500;
const COMPACT_SOLVE_MAX_OUTPUT_TOKENS = 2400;
const DEFAULT_INPUT_COST_PER_1M_TOKENS = 5;
const DEFAULT_OUTPUT_COST_PER_1M_TOKENS = 30;

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
    publicMessage: "The model response was cut off. Retrying with a shorter explanation...",
    invalidOutputText: outputText,
    finishReason: getFinishReason(responseBody) || null,
  });
}

export function parseJsonResponse(responseBody, assertFn) {
  const outputText = extractOutputText(responseBody);
  logOpenAiResponse({ purpose: "json_parse", responseBody, outputText });
  if (isLengthFinishReason(responseBody)) {
    throw createTruncatedJsonError(outputText, responseBody);
  }

  const extracted = extractFirstCompleteJsonObject(outputText);
  if (!extracted.complete) {
    throw Object.assign(new Error("OpenAI returned incomplete JSON."), {
      statusCode: 502,
      code: "AI_RESPONSE_INVALID",
      publicMessage: "The AI service returned an incomplete explanation.",
      invalidOutputText: outputText,
    });
  }

  try {
    return assertFn(JSON.parse(extracted.text));
  } catch (error) {
    if (error.statusCode) {
      error.invalidOutputText = outputText;
      throw error;
    }
    throw Object.assign(new Error("OpenAI returned malformed JSON."), {
      statusCode: 502,
      code: "AI_RESPONSE_INVALID",
      publicMessage: "The AI service returned an invalid explanation.",
      invalidOutputText: outputText,
    });
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
}) {
  const payload = {
    model,
    input: [{ role: "user", content }],
    max_output_tokens: maxOutputTokens,
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        strict: true,
        schema,
      },
    },
  };
  let response;
  try {
    logOpenAiModelSelection(modelPath, { purpose });
    logOpenAiRequest({ purpose, payload });
    response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: createOpenAiHeaders(),
      body: JSON.stringify(payload),
    });
  } catch (error) {
    logOpenAiNonProviderError({ purpose, error });
    if (error.code === "SERVER_CONFIG_ERROR") throw error;
    throw Object.assign(new Error(`OpenAI request failed: ${error.message}`, { cause: error }), {
      statusCode: 502,
      code: "AI_SERVICE_UNAVAILABLE",
      publicMessage: "The AI service is temporarily unreachable.",
      providerStatus: null,
      providerCode: null,
      networkCauseCode: error.cause?.code || error.code || null,
      networkCauseMessage: error.cause?.message || error.message,
    });
  }

  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseBody = { error: { message: responseText } };
  }

  if (!response.ok) {
    logOpenAiProviderError({ purpose, response, responseBody });
    const providerCode = responseBody.error?.code || responseBody.error?.type || null;
    const message = responseBody.error?.message || `OpenAI request failed with status ${response.status}`;
    throw Object.assign(new Error(message), {
      statusCode: response.status === 429 ? 429 : 502,
      code: response.status === 429 ? "AI_PROVIDER_RATE_LIMITED" : "AI_SERVICE_ERROR",
      providerStatus: response.status,
      providerCode,
      publicMessage: response.status === 429
        ? "The AI service is busy or rate limited. Please try again later."
        : "The AI service could not complete the request.",
    });
  }

  logOpenAiResponse({ purpose, responseBody, outputText: extractOutputText(responseBody) });
  return responseBody;
}

async function requestOpenAiText({ content, maxOutputTokens = 900, purpose = "text_completion", modelPath = "solver" }) {
  const payload = {
    model: getOpenAiModelForPath(modelPath),
    input: [{ role: "user", content }],
    max_output_tokens: maxOutputTokens,
  };
  let response;
  try {
    logOpenAiModelSelection(modelPath, { purpose });
    logOpenAiRequest({ purpose, payload });
    response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: createOpenAiHeaders(),
      body: JSON.stringify(payload),
    });
  } catch (error) {
    logOpenAiNonProviderError({ purpose, error });
    if (error.code === "SERVER_CONFIG_ERROR") throw error;
    throw Object.assign(new Error(`OpenAI request failed: ${error.message}`, { cause: error }), {
      statusCode: 502,
      code: "AI_SERVICE_UNAVAILABLE",
      publicMessage: "The AI service is temporarily unreachable.",
      providerStatus: null,
      providerCode: null,
      networkCauseCode: error.cause?.code || error.code || null,
      networkCauseMessage: error.cause?.message || error.message,
    });
  }

  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseBody = { error: { message: responseText } };
  }

  if (!response.ok) {
    logOpenAiProviderError({ purpose, response, responseBody });
    const providerCode = responseBody.error?.code || responseBody.error?.type || null;
    const message = responseBody.error?.message || `OpenAI request failed with status ${response.status}`;
    throw Object.assign(new Error(message), {
      statusCode: response.status === 429 ? 429 : 502,
      code: response.status === 429 ? "AI_PROVIDER_RATE_LIMITED" : "AI_SERVICE_ERROR",
      providerStatus: response.status,
      providerCode,
      publicMessage: response.status === 429
        ? "The AI service is busy or rate limited. Please try again later."
        : "The AI service could not complete the request.",
    });
  }

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

function buildCompactSolvePrompt(prompt, originalProblem = "") {
  return `${prompt}

The previous full structured response was cut off. Retry in compact mode.

Compact mode output rules:
- Return JSON matching the compact schema exactly: title, problemLatex, steps.
- Use 4-8 steps for long problems; never more than 8.
- Each step must contain id, heading, latex, reasoning, and anchors.
- Set anchors to [] for every step unless one anchor is essential.
- Keep reasoning to 1 concise sentence, maximum 25 words.
- Do not restate the entire original problem as step 1.
- Preserve mathematical correctness over hover interactivity.
- Use compact equations for verification; avoid prose-heavy derivations.
- Return JSON only.

Original problem context:
${originalProblem || "Use the problem from the prior prompt."}`;
}

export async function createMathExplanation({ prompt, image, originalProblem = "" }) {
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
  const responseBody = await requestOpenAi({
    content,
    purpose,
    schema: image ? imageSolveSchema : fastSolveSchema,
    schemaName: image ? "math_image_solve" : "math_fast_solve",
    maxOutputTokens: getSolveOutputTokenBudget({ prompt }),
    modelPath: "solver",
  });
  let usage = responseBody.usage || null;
  let parsed;
  let compactFallback = false;
  let aiCallCount = 1;
  try {
    parsed = parseJsonResponse(
      responseBody,
      (value) => (image ? assertImageSolveResponse(value) : assertFastSolveResponse(value))
    );
  } catch (error) {
    if (!["AI_RESPONSE_TRUNCATED", "AI_RESPONSE_INVALID"].includes(error.code) || image) throw error;
    console.warn("[omnimath:openai-compact-retry]", {
      purpose,
      reason: error.code,
      finishReason: error.finishReason || null,
      outputChars: String(error.invalidOutputText || "").length,
    });
    const compactPrompt = buildCompactSolvePrompt(prompt, originalProblem);
    const compactResponse = await requestOpenAi({
      content: [{ type: "input_text", text: compactPrompt }],
      purpose: "math_compact_solve_retry",
      schema: compactSolveSchema,
      schemaName: "math_compact_solve",
      maxOutputTokens: getSolveOutputTokenBudget({ prompt: compactPrompt, compact: true }),
      modelPath: "solver",
    });
    usage = mergeUsage(usage, compactResponse.usage || null);
    aiCallCount = 2;
    compactFallback = true;
    parsed = parseJsonResponse(
      compactResponse,
      (value) => assertCompactSolveResponse(value, originalProblem)
    );
  }
  const result = image
    ? convertImageSolveToMathExplanation(parsed)
    : convertFastSolveToMathExplanation(parsed, { originalProblem, includeProblemStep: !compactFallback });

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
    value: usage,
  });
  Object.defineProperty(result, "_aiCallCount", {
    enumerable: false,
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
    value: usage,
  });
  Object.defineProperty(result, "_aiCallCount", {
    enumerable: false,
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

export async function createLazyTokenExplanation({ prompt, mode = "hover" }) {
  const modelPath = mode === "pin" ? "pinned" : "hover";
  const responseBody = await requestOpenAi({
    content: [{ type: "input_text", text: prompt }],
    purpose: mode === "pin" ? "math_pin_explanation" : "math_token_explanation",
    schema: lazyTokenExplanationSchema,
    schemaName: "math_token_explanation",
    maxOutputTokens: getLazyMaxOutputTokens(),
    modelPath,
  });
  return {
    ...parseJsonResponse(responseBody, assertLazyTokenExplanation),
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
