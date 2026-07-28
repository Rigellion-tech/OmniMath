import { getSolutionSteps } from "../lib/solutionSteps.js";
import {
  canonicalProblemFromExtraction,
  createCanonicalProblemPayload,
  diffCanonicalProblemPayloads,
  getCanonicalSolverInput,
  logCanonicalProblem,
} from "../lib/canonicalProblem.js";

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof body === "object" && body !== null
      ? body.message || body.error
      : body;
    const friendlyMessage = typeof body === "object" && body?.code === "AI_SERVICE_UNAVAILABLE"
      ? "AI service timed out or connection dropped. Try again."
      : message;
    logSolutionDebug("api error response", {
      requestId: typeof body === "object" && body !== null ? body.requestId || null : null,
      status: response.status,
      code: typeof body === "object" && body !== null ? body.code || null : null,
      message: friendlyMessage,
      body,
    });
    throw Object.assign(
      new Error(friendlyMessage || `Request failed with status ${response.status}`),
      { status: response.status, body }
    );
  }

  return body;
}

function decodeJwtPayload(token) {
  try {
    const payload = token?.split(".")?.[1];
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

function summarizeToken(token) {
  const claims = decodeJwtPayload(token);
  return {
    present: Boolean(token),
    tokenChars: token?.length || 0,
    userId: claims?.sub || null,
    sessionId: claims?.sid || claims?.session_id || null,
    issuer: claims?.iss || null,
    authorizedParty: claims?.azp || null,
    audience: claims?.aud || null,
    expiresAt: claims?.exp || null,
  };
}

function logAuthDebug(endpoint, details) {
  if (!import.meta.env?.DEV) return;
  console.info("[omnimath:frontend-auth]", {
    endpoint,
    ...details,
  });
}

function isSolutionDebugEnabled() {
  return import.meta.env?.DEV && (
    import.meta.env.VITE_DEBUG_SOLUTION_STATE === "true"
    || import.meta.env.OMNIMATH_DEBUG_SOLVE === "true"
  );
}

function logSolutionDebug(event, details = {}) {
  if (!isSolutionDebugEnabled()) return;
  console.info("[omnimath:solution-state]", {
    event,
    ...details,
  });
}

function createClientRequestId(prefix = "client") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function firstArray(...values) {
  return values.find(Array.isArray) || [];
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

/** @returns {Record<string, any>} */
function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** @returns {Record<string, any>} */
export function normalizeSolveResponse(rawResponse = {}, { endpoint = "" } = {}) {
  const raw = objectOrEmpty(rawResponse);
  const explanation = objectOrEmpty(raw.explanation);
  const result = objectOrEmpty(raw.result);
  const solution = objectOrEmpty(raw.solution);
  const problem = objectOrEmpty(raw.problem);
  const source = [raw, explanation, result, solution, problem].find((item) => Array.isArray(item.steps)) || raw;
  const steps = getSolutionSteps(raw);
  const saveWarning = raw.runtime?.saveWarning || explanation.runtime?.saveWarning || result.runtime?.saveWarning || raw.saveWarning || "";
  const warnings = [
    ...firstArray(raw.warnings, explanation.warnings, result.warnings, solution.warnings),
    ...(saveWarning ? [saveWarning] : []),
  ];
  const metadata = {
    ...(raw.metadata || {}),
    endpoint,
    runtime: raw.runtime || explanation.runtime || result.runtime || null,
    usage: raw.usage || explanation.usage || result.usage || null,
    savedExplanationId: raw.savedExplanationId || explanation.savedExplanationId || result.savedExplanationId || null,
    saveStatus: saveWarning ? "not_saved" : raw.savedExplanationId ? "saved" : raw.saved === false ? "not_saved" : "unknown",
    rawKeys: Object.keys(raw),
  };
  const normalized = {
    ...raw,
    ...source,
    steps,
    finalAnswer: firstValue(raw.finalAnswer, raw.finalAnswerLatex, explanation.finalAnswer, explanation.finalAnswerLatex, result.finalAnswer, result.finalAnswerLatex, solution.finalAnswer, solution.finalAnswerLatex, source.finalAnswer, source.finalAnswerLatex) || "",
    concepts: firstArray(raw.concepts, explanation.concepts, result.concepts, solution.concepts, source.concepts),
    warnings,
    metadata,
    runtime: {
      ...(raw.runtime || {}),
      saveWarning: saveWarning || raw.runtime?.saveWarning || null,
    },
  };
  return normalized;
}

async function getAuthHeaders(getToken, endpoint, { fresh = false } = {}) {
  if (typeof getToken !== "function") {
    logAuthDebug(endpoint, { getTokenAvailable: false, authorizationHeaderSent: false });
    return {};
  }

  try {
    const token = await getToken(fresh ? { skipCache: true } : undefined);
    logAuthDebug(endpoint, {
      getTokenAvailable: true,
      authorizationHeaderSent: Boolean(token),
      fresh,
      token: summarizeToken(token),
    });
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch (error) {
    logAuthDebug(endpoint, {
      getTokenAvailable: true,
      authorizationHeaderSent: false,
      error: error.message,
    });
    return {};
  }
}

export async function explainProblem({ problem, history, getToken }) {
  const debugRequestId = createClientRequestId("typed-solve");
  const canonicalProblem = createCanonicalProblemPayload({
    canonicalText: problem,
    source: "typed",
  });
  logCanonicalProblem("solve request", canonicalProblem, { endpoint: "/api/explain" });
  logSolutionDebug("api explain payload", {
    requestId: debugRequestId,
    rawProblem: problem,
    payloadProblem: canonicalProblem.canonicalText,
    historyCount: Array.isArray(history) ? history.length : 0,
  });
  const authHeaders = await getAuthHeaders(getToken, "/api/explain", { fresh: true });
  const response = await fetch("/api/explain", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({
      problem: canonicalProblem.canonicalText,
      canonicalProblem,
      history,
      debugRequestId,
    }),
  });

  const parsed = await parseResponse(response);
  logSolutionDebug("api explain response", {
    requestId: parsed?.requestId || debugRequestId,
    status: response.status,
    ok: response.ok,
    code: parsed?.code,
    message: parsed?.message,
  });
  return normalizeSolveResponse(parsed, { endpoint: "/api/explain" });
}

export async function explainImageProblem({ file, prompt, getToken, quality }) {
  const debugRequestId = createClientRequestId("image-solve");
  const formData = new FormData();
  formData.append("file", file);
  formData.append("prompt", prompt);
  formData.append("debugRequestId", debugRequestId);
  if (Number.isFinite(quality?.metrics?.ocrConfidence)) {
    formData.append("ocrConfidence", String(quality.metrics.ocrConfidence));
  }

  const authHeaders = await getAuthHeaders(getToken, "/api/explain-image", { fresh: true });
  const response = await fetch("/api/explain-image", {
    method: "POST",
    headers: authHeaders,
    body: formData,
  });

  const parsed = await parseResponse(response);
  logSolutionDebug("api explain-image response", {
    requestId: parsed?.requestId || debugRequestId,
    status: response.status,
    ok: response.ok,
    code: parsed?.code,
    message: parsed?.message,
  });
  return normalizeSolveResponse(parsed, { endpoint: "/api/explain-image" });
}

export async function extractImageProblem({ file, prompt, getToken, quality }) {
  const debugRequestId = createClientRequestId("image-extract");
  const formData = new FormData();
  formData.append("file", file);
  formData.append("prompt", prompt);
  formData.append("debugRequestId", debugRequestId);
  if (Number.isFinite(quality?.metrics?.ocrConfidence)) {
    formData.append("ocrConfidence", String(quality.metrics.ocrConfidence));
  }

  const authHeaders = await getAuthHeaders(getToken, "/api/extract-image-problem", { fresh: true });
  const response = await fetch("/api/extract-image-problem", {
    method: "POST",
    headers: authHeaders,
    body: formData,
  });

  const parsed = await parseResponse(response);
  logSolutionDebug("api extract-image response", {
    requestId: parsed?.requestId || debugRequestId,
    status: response.status,
    ok: response.ok,
    code: parsed?.code,
    message: parsed?.message,
  });
  return parsed;
}

function normalizeLineBreaks(value = "") {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksTokenPerLine(value = "") {
  const lines = normalizeLineBreaks(value).split("\n").filter(Boolean);
  if (lines.length < 8) return false;
  const shortLines = lines.filter((line) => line.trim().length <= 3).length;
  const punctuationLines = lines.filter((line) => /^[()[\]{},.=+\-*/^<>]$/u.test(line.trim())).length;
  return shortLines / lines.length >= 0.72 && punctuationLines >= 2;
}

function joinTokenLines(value = "") {
  const tokens = normalizeLineBreaks(value).split("\n").map((line) => line.trim()).filter(Boolean);
  let output = "";

  for (const token of tokens) {
    if (!output) {
      output = token;
      continue;
    }

    if (/^[),\].=+\-*/^>]$/u.test(token)) {
      output += token;
    } else if (/[([{<]$/u.test(output) || /^[([{<]$/u.test(token)) {
      output += token;
    } else if (/^[,.;:]$/u.test(token)) {
      output += token;
    } else if (/^[A-Za-z0-9\\]$/u.test(token) && /[A-Za-z0-9\\]$/u.test(output)) {
      output += token;
    } else {
      output += ` ${token}`;
    }
  }

  return output
    .replace(/\s+([,.;:)>\]}])/gu, "$1")
    .replace(/,\s+/gu, ",")
    .replace(/([(<\[{^])\s+/gu, "$1")
    .replace(/\^\s+/gu, "^")
    .replace(/\s+([+\-*/=^])/gu, "$1")
    .replace(/([+\-*/=^])\s+/gu, "$1")
    .trim();
}

function normalizeSpacedRelationalOperators(value = "") {
  return String(value || "")
    .replace(/>\s+=/g, ">=")
    .replace(/<\s+=/g, "<=")
    .replace(/!\s+=/g, "!=");
}

export function normalizeOcrTextForSubmission(value = "") {
  const normalized = normalizeLineBreaks(value);
  const joined = looksTokenPerLine(normalized) ? joinTokenLines(normalized) : normalized;
  return normalizeSpacedRelationalOperators(joined);
}

export function buildExtractionSubmissionPayload(options = {}) {
  const extraction = options.extraction;
  const displayText = options.displayText;
  const rawText = options.rawText;
  const solveDecision = options.solveDecision;
  const exactRawText = normalizeLineBreaks(rawText || extraction?.rawExtractedText || extraction?.rawOcrText || extraction?.extractedProblemText || "");
  const editableDisplayText = normalizeLineBreaks(displayText || extraction?.displayText || extraction?.cleanedPlainText || extraction?.extractedProblemText || exactRawText);
  const normalizedText = normalizeOcrTextForSubmission(editableDisplayText || exactRawText);
  const source = options.source || (solveDecision === "direct" && normalizedText === normalizeOcrTextForSubmission(extraction?.extractedProblemText || exactRawText)
    ? "ocr-direct"
    : "ocr-reviewed");
  const canonicalProblem = canonicalProblemFromExtraction({
    extraction,
    canonicalText: normalizedText,
    source,
  });
  if (extraction?.canonicalProblem?.hash && extraction.canonicalProblem.hash !== canonicalProblem.hash) {
    logCanonicalProblem("hash divergence", canonicalProblem, {
      previousHash: extraction.canonicalProblem.hash,
      differences: diffCanonicalProblemPayloads(extraction.canonicalProblem, canonicalProblem),
      path: "buildExtractionSubmissionPayload",
    });
  }
  logCanonicalProblem("review continue", canonicalProblem, {
    solveDecision,
    path: "buildExtractionSubmissionPayload",
  });
  const previewMath = Array.isArray(extraction?.displaySegments)
    ? extraction.displaySegments
    : Array.isArray(extraction?.imageSource?.displaySegments)
      ? extraction.imageSource.displaySegments
      : [];
  const payloadExtraction = {
    ...(extraction || {}),
    rawText: exactRawText,
    displayText: editableDisplayText,
    normalizedText,
    validationText: normalizedText,
    previewMath,
    submittedProblemSource: "ocr-review-state",
    canonicalProblem,
  };

  return {
    problem: getCanonicalSolverInput(canonicalProblem),
    problemText: editableDisplayText,
    canonicalProblem,
    extraction: payloadExtraction,
    solveDecision,
  };
}

export async function solveExtractedProblem({
  problem = "",
  problemLatex = "",
  problemText = "",
  extraction = {},
  canonicalProblem = null,
  solveDecision = "direct",
  getToken,
}) {
  const debugRequestId = createClientRequestId("solve-extracted");
  const safeExtraction = objectOrEmpty(extraction);
  const frozenCanonicalProblem = canonicalProblem || safeExtraction.canonicalProblem || createCanonicalProblemPayload({
    canonicalText: problem,
    canonicalLatex: problemLatex,
    source: safeExtraction.submittedProblemSource ? "ocr-reviewed" : "typed",
    extractionWarnings: safeExtraction.issues || safeExtraction.extractionValidation?.issues || [],
    extractionConfidence: safeExtraction.confidence ?? safeExtraction.extractionValidation?.confidence,
  });
  const canonicalInput = getCanonicalSolverInput(frozenCanonicalProblem, problem);
  logCanonicalProblem("solve request", frozenCanonicalProblem, { endpoint: "/api/solve-extracted-problem" });
  logSolutionDebug("api solve-extracted payload", {
    requestId: debugRequestId,
    normalizedExtractedProblem: canonicalInput,
    canonicalInputHash: frozenCanonicalProblem.hash,
    solveDecision,
  });
  const authHeaders = await getAuthHeaders(getToken, "/api/solve-extracted-problem", { fresh: true });
  const response = await fetch("/api/solve-extracted-problem", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({
      problem: canonicalInput,
      problemLatex,
      problemText,
      canonicalProblem: frozenCanonicalProblem,
      extraction: {
        ...safeExtraction,
        canonicalProblem: frozenCanonicalProblem,
      },
      solveDecision,
      debugRequestId,
    }),
  });

  const parsed = await parseResponse(response);
  logSolutionDebug("api solve-extracted response", {
    requestId: parsed?.requestId || debugRequestId,
    status: response.status,
    ok: response.ok,
    code: parsed?.code,
    message: parsed?.message,
  });
  return normalizeSolveResponse(parsed, { endpoint: "/api/solve-extracted-problem" });
}

export async function explainFollowup({ payload, getToken }) {
  const authHeaders = await getAuthHeaders(getToken, "/api/explain-followup");
  const response = await fetch("/api/explain-followup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify(payload || {}),
  });

  return parseResponse(response);
}

export async function explainToken({ payload, getToken, signal }) {
  const authHeaders = await getAuthHeaders(getToken, "/api/explain-token");
  const response = await fetch("/api/explain-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify(payload || {}),
    signal,
  });

  return parseResponse(response);
}

export async function explainPin({ payload, getToken, signal }) {
  const authHeaders = await getAuthHeaders(getToken, "/api/explain-pin");
  const response = await fetch("/api/explain-pin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify(payload || {}),
    signal,
  });

  return parseResponse(response);
}

export async function compareMethods({ payload, getToken }) {
  const canonicalProblem = payload?.canonicalProblem || createCanonicalProblemPayload({
    canonicalText: payload?.problemLatex || payload?.problem || "",
    canonicalLatex: payload?.problemLatex || "",
    source: payload?.imageSource || payload?.extraction ? "ocr-reviewed" : "typed",
  });
  logCanonicalProblem("compare request", canonicalProblem, { endpoint: "/api/compare-methods" });
  const authHeaders = await getAuthHeaders(getToken, "/api/compare-methods");
  const response = await fetch("/api/compare-methods", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({
      ...(payload || {}),
      problemLatex: getCanonicalSolverInput(canonicalProblem, payload?.problemLatex || payload?.problem || ""),
      canonicalProblem,
    }),
  });

  return parseResponse(response);
}
