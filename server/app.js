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
import {
  createExplanationCacheKey,
  createImageHash,
  getCachedExplanation,
  setCachedExplanation,
} from "./explanationCache.js";
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
const REGRESSION_INTEGRAL_KEY = "\\int_0^\\infty\\frac\\ln(1+x^2)\\arctanxx(1+x^2)\\,dx";
const REGRESSION_INTEGRAL_VALUE = 0.7546938294602481;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

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
  const message = isServerError && isProductionRuntime()
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

  if (!isProductionRuntime() && error.authDebug) {
    payload.debug = { auth: error.authDebug };
  }

  const headers = createUsageHeaders(error.usage, { includeRetryAfter: statusCode === 429 });
  if (error.retryAfterSeconds && !headers["Retry-After"]) {
    headers["Retry-After"] = String(error.retryAfterSeconds);
  }

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

function getCacheRequestFields(body = {}) {
  return {
    reference: body.selectedTokenId || body.selectedStepId || body.reference || "",
    depth: body.depth || "intermediate",
  };
}

function estimateTokens(text = "") {
  return Math.ceil(String(text).length / 4);
}

function compactLatex(value = "") {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/\\left|\\right|\{|\}/g, "");
}

function evaluateSimpleLatexNumber(value = "") {
  const text = compactLatex(value)
    .replace(/^\\boxed/, "")
    .replace(/^\\displaystyle/, "");
  const pi = Math.PI;
  const ln2 = Math.log(2);

  if (
    /^\\frac\\pi2\\ln\^?2?2$/.test(text)
    || /^\\frac\\pi2\\ln2\^2$/.test(text)
    || /^\\frac\\pi2\\ln\^2\(2\)$/.test(text)
  ) {
    return (pi / 2) * ln2 ** 2;
  }
  if (/^\\frac\\pi2\\left\(\\ln2\\right\)\^2$/.test(text)) {
    return (pi / 2) * ln2 ** 2;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function logNumericVerificationIfAvailable(result) {
  const problemKey = compactLatex(result?.expression || result?.problem || result?.originalProblem);
  if (problemKey !== REGRESSION_INTEGRAL_KEY) return;

  const finalValue = evaluateSimpleLatexNumber(result.finalAnswerLatex || result.finalAnswer);
  const modelCheck = Number(result.numericCheck);
  const observed = Number.isFinite(finalValue) ? finalValue : modelCheck;
  const delta = Number.isFinite(observed) ? Math.abs(observed - REGRESSION_INTEGRAL_VALUE) : null;
  const payload = {
    expected: REGRESSION_INTEGRAL_VALUE,
    finalAnswer: result.finalAnswerLatex || result.finalAnswer,
    finalAnswerValue: finalValue,
    modelNumericCheck: Number.isFinite(modelCheck) ? modelCheck : null,
    delta,
  };

  if (delta === null || delta > 1e-6) {
    console.warn("[omnimath:numeric-check-warning]", payload);
    return;
  }

  console.info("[omnimath:numeric-check]", payload);
}

function dollarsToMicros(value) {
  return Math.ceil(Math.max(0, Number(value) || 0) * 1000000);
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
}) {
  const durationMs = Math.max(0, Date.now() - startedAt);
  const normalizedUsage = normalizeOpenAiUsage(aiUsage, estimateTokens(prompt));
  const details = {
    userId: identity?.clerkUserId,
    endpoint,
    source,
    durationMs,
    apiCallCount,
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

function buildResponse(result, { usage, saved, source, demoMode }) {
  return {
    ...result,
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
    const identity = await requireClerkIdentity(req);
    throttleRequest(req, identity, "ai");
    assertAiEnabled();
    const body = await readJson(req);
    requireObject(body);
    const problem = requireTextProblem(body.problem ?? body.prompt);
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
        buildResponse(cached, { usage, source: "cached", demoMode: !isOpenAiConfigured() }),
        createUsageHeaders(usage)
      );
      return;
    }

    const prompt = buildMathExplanationPrompt({ problem, history });
    const estimatedTokens = estimateOpenAiTokenBudget({ prompt, maxOutputTokens: getSolveMaxOutputTokens() });
    const estimatedCostMicros = dollarsToMicros(estimateOpenAiCostBudget({ prompt, maxOutputTokens: getSolveMaxOutputTokens() }));
    const { duplicate, value } = await runDeduplicatedRequest(cacheKey, async () => {
      let result = createLocalRuleExplanation(problem, { source: "text" });
      let source = "local rule";
      const willCallOpenAi = !result && isOpenAiConfigured();
      const { reservation } = await checkAndReserveUsage({
        req,
        identity,
        kind: "explanation",
        estimatedTokens: willCallOpenAi ? estimatedTokens : 0,
        estimatedCostMicros: willCallOpenAi ? estimatedCostMicros : 0,
      });
      let usage;

      try {
        if (!result) {
          if (!isOpenAiConfigured()) {
            throw createOpenAiRequiredError();
          } else {
            result = await createMathExplanation({ prompt, originalProblem: problem });
            result = applyLocalRulesToExplanation(result);
            source = "live AI call";
          }
        }
        result = annotateMathExplanation(result);
        logNumericVerificationIfAvailable(result);

        const normalizedUsage = normalizeOpenAiUsage(result._aiUsage, 0);
        usage = await settleTokenUsage(
          reservation,
          normalizedUsage.totalTokens,
          dollarsToMicros(estimateOpenAiCost(result._aiUsage))
        );
      } catch (error) {
        try {
          await releaseTokenReservation(reservation);
        } catch (releaseError) {
          console.warn("Could not release token reservation:", releaseError.message);
        }
        throw error;
      }

      setCachedExplanation(cacheKey, result);
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
      }),
      createUsageHeaders(usage)
    );
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
      extraction.extractionValidation = validateExtraction({
        extractedProblemText: extraction.extractedProblemText,
        extractedProblemLatex: extraction.extractedProblemLatex,
        ocrConfidence: fields.ocrConfidence,
        modelConfidence: extraction.confidence,
        modelIssues: extraction.issues,
      });
      extraction.confidence = extraction.extractionValidation.confidence;
      extraction.confidenceTier = extraction.extractionValidation.tier;
      extraction.issues = extraction.extractionValidation.issues;
      extraction.imageSource = {
        imageHash,
        filename: image.filename || null,
        contentType: image.contentType,
        bytes: image.buffer.length,
        rawExtractedText: extraction.extractedProblemText,
        rawExtractedLatex: extraction.extractedProblemLatex,
        confidence: extraction.confidence,
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
    const identity = await requireClerkIdentity(req);
    throttleRequest(req, identity, "ai");
    assertAiEnabled();
    const body = requireObject(await readJson(req));
    const problemLatex = requireTextProblem(body.problemLatex || body.problem || body.extractedProblemLatex);
    const problemText = optionalShortText(body.problemText || body.extractedProblemText || "", "Problem text", MAX_PROBLEM_CHARS);
    const extraction = requireObject(body.extraction || {}, "Extraction");
    const solveDecision = ["direct", "anyway", "edited"].includes(body.solveDecision)
      ? body.solveDecision
      : "direct";
    const prompt = buildMathExplanationPrompt({
      problem: problemLatex,
      history: [{
        role: "student",
        text: problemText ? `Confirmed image extraction text: ${problemText}` : "Confirmed image extraction.",
      }],
    });
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

    const { duplicate, value } = await runDeduplicatedRequest(cacheKey, async () => {
      let result = createLocalRuleExplanation(problemLatex, { source: "image" });
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

      try {
        if (!result) {
          if (!isOpenAiConfigured()) {
            throw createOpenAiRequiredError();
          }
          result = await createMathExplanation({ prompt, originalProblem: problemLatex });
          result = applyLocalRulesToExplanation(result);
          source = "live AI call";
        }
        result = annotateMathExplanation(result);
        result.imageSource = {
          ...(extraction.imageSource || {}),
          imageHash: extraction.imageSource?.imageHash || extraction.imageHash || null,
          filename: extraction.imageSource?.filename || null,
          contentType: extraction.imageSource?.contentType || null,
          bytes: extraction.imageSource?.bytes || null,
          rawExtractedText: extraction.rawExtractedText || extraction.extractedProblemText || extraction.imageSource?.rawExtractedText || "",
          rawExtractedLatex: extraction.rawExtractedLatex || extraction.extractedProblemLatex || extraction.imageSource?.rawExtractedLatex || "",
          finalProblemText: problemText,
          finalProblemLatex: problemLatex,
          confidence: Number(extraction.confidence ?? extraction.extractionValidation?.confidence ?? extraction.imageSource?.confidence ?? 0),
          confidenceTier: extraction.confidenceTier || extraction.extractionValidation?.tier || extraction.imageSource?.confidenceTier || "",
          issues: Array.isArray(extraction.issues)
            ? extraction.issues
            : extraction.extractionValidation?.issues || extraction.imageSource?.issues || [],
          solveDecision,
          editedBeforeSolving: solveDecision === "edited",
        };
        result.extractedProblemText = result.imageSource.rawExtractedText;
        result.extractedProblemLatex = result.imageSource.rawExtractedLatex;
        result.extractionValidation = extraction.extractionValidation || {
          confidence: result.imageSource.confidence,
          tier: result.imageSource.confidenceTier,
          issues: result.imageSource.issues,
        };

        const normalizedUsage = normalizeOpenAiUsage(result._aiUsage, 0);
        usage = await settleTokenUsage(
          reservation,
          normalizedUsage.totalTokens,
          dollarsToMicros(estimateOpenAiCost(result._aiUsage))
        );
      } catch (error) {
        try {
          await releaseTokenReservation(reservation);
        } catch (releaseError) {
          console.warn("Could not release token reservation:", releaseError.message);
        }
        throw error;
      }

      setCachedExplanation(cacheKey, result);
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
      }),
      createUsageHeaders(usage)
    );
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

      try {
        if (!result) {
          if (!isOpenAiConfigured()) {
            throw createOpenAiRequiredError();
          } else {
            result = await createMathExplanation({ prompt, image, originalProblem: problem });
            result = applyLocalRulesToExplanation(result);
            source = "live AI call";
          }
        }
        result = annotateMathExplanation(result);
        result.extractionValidation = validateExtraction({
          extractedProblemText: result.extractedProblemText,
          extractedProblemLatex: result.extractedProblemLatex || result.expression,
          ocrConfidence: fields.ocrConfidence,
        });
        logImageUploadDebug("extracted", {
          extractedProblemText: result.extractedProblemText || "",
          extractedProblemLatex: result.extractedProblemLatex || result.expression || "",
          generatedProblemLatex: result.expression || "",
          firstStepLatex: result.steps?.[0]?.math || "",
          finalAnswerLatex: result.finalAnswerLatex || result.finalAnswer || "",
          extractionValidation: result.extractionValidation,
        });

        const normalizedUsage = normalizeOpenAiUsage(result._aiUsage, 0);
        usage = await settleTokenUsage(
          reservation,
          normalizedUsage.totalTokens,
          dollarsToMicros(estimateOpenAiCost(result._aiUsage))
        );
      } catch (error) {
        try {
          await releaseTokenReservation(reservation);
        } catch (releaseError) {
          console.warn("Could not release token reservation:", releaseError.message);
        }
        throw error;
      }

      setCachedExplanation(cacheKey, result);
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
    const problemLatex = requireShortText(
      body.problemLatex || body.problem,
      "Problem LaTeX",
      MAX_PROBLEM_CHARS
    );
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
      sendJson(res, 200, { ...cached, usage, cached: true }, createUsageHeaders(usage));
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

    const payload = { methods: result.methods };
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
    const identity = await requireClerkIdentity(req);
    throttleRequest(req, identity, "ai");
    assertAiEnabled();
    const body = requireObject(await readJson(req));
    const history = parseFollowupHistory(body.history);
    const prompt = buildFollowupPrompt(body, history);
    const estimatedTokens = estimateOpenAiTokenBudget({ prompt });
    const estimatedCostMicros = dollarsToMicros(estimateOpenAiCostBudget({ prompt }));
    const { reservation } = await checkAndReserveUsage({
      req,
      identity,
      kind: "explanation",
      estimatedTokens: isOpenAiConfigured() ? estimatedTokens : 0,
      estimatedCostMicros: isOpenAiConfigured() ? estimatedCostMicros : 0,
    });
    let answer;
    let aiUsage;
    let usage;

    try {
      if (!isOpenAiConfigured()) {
        throw Object.assign(new Error("OPENAI_API_KEY is not configured on the server."), {
          statusCode: 503,
          code: "SERVER_CONFIG_ERROR",
          publicMessage: "Follow-up chat needs the live AI backend to be configured.",
        });
      }

      const result = await createFollowupAnswer({ prompt });
      answer = result.text;
      aiUsage = result.usage;
      const normalizedUsage = normalizeOpenAiUsage(aiUsage, estimateTokens(prompt));
      usage = await settleTokenUsage(
        reservation,
        normalizedUsage.totalTokens,
        dollarsToMicros(estimateOpenAiCost(aiUsage))
      );
    } catch (error) {
      try {
        await releaseTokenReservation(reservation);
      } catch (releaseError) {
        console.warn("Could not release token reservation:", releaseError.message);
      }
      throw error;
    }

    logExplanationSource({
      source: "live AI call",
      kind: "text",
      endpoint: "/api/explain-followup",
      identity,
      prompt,
      aiUsage,
    });
    sendJson(res, 200, { answer, usage }, createUsageHeaders(usage));
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
