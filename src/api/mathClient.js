import { getRenderableSolutionSteps } from "../lib/solutionSteps.js";
import { inspectReasoningCandidate } from "../lib/reasoningLatexDiagnostics.js";
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

function summarizeClientText(value) {
  const present = value !== undefined && value !== null;
  const text = typeof value === "string" ? value : "";
  return {
    present,
    type: typeof value,
    charCount: text.length,
    trimmedCharCount: text.trim().length,
  };
}

function summarizeClientSteps(steps = [], stage = "client") {
  return {
    stage,
    stepCount: Array.isArray(steps) ? steps.length : 0,
    steps: Array.isArray(steps)
      ? steps.map((step, index) => ({
          index,
          id: typeof step?.id === "string" ? step.id : null,
          math: summarizeClientText(step?.math),
          latex: summarizeClientText(step?.latex),
          equationLatex: summarizeClientText(step?.equationLatex),
          display: summarizeClientText(step?.display),
          lineCount: Array.isArray(step?.lines) ? step.lines.length : 0,
          chunkCount: Array.isArray(step?.chunks) ? step.chunks.length : 0,
          boundaryError: step?.renderBoundaryError || null,
        }))
      : [],
  };
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

function logFrontendReasoningLatexStage(stage, candidate) {
  if (!import.meta.env?.DEV || import.meta.env.VITE_DEBUG_REASONING_LATEX !== "true") return;
  console.info("[omnimath:reasoning-latex]", inspectReasoningCandidate(candidate, {
    stage,
    stepSelector: import.meta.env.VITE_DEBUG_REASONING_LATEX_STEPS || "1,2",
  }));
}

/** @returns {Record<string, any>} */
export function normalizeSolveResponse(rawResponse = {}, { endpoint = "", requestId: requestedRequestId = "" } = {}) {
  const raw = objectOrEmpty(rawResponse);
  const explanation = objectOrEmpty(raw.explanation);
  const result = objectOrEmpty(raw.result);
  const solution = objectOrEmpty(raw.solution);
  const problem = objectOrEmpty(raw.problem);
  const source = [raw, explanation, result, solution, problem].find((item) => Array.isArray(item.steps)) || raw;
  const requestId = raw.requestId || raw.metadata?.requestId || requestedRequestId || "";
  logFrontendReasoningLatexStage("4a.frontend_received_field", source);
  // A live API solve must contain renderable math/text, not just a label or
  // an empty object. Legacy persisted status calculations still use the more
  // permissive getSolutionSteps() path elsewhere.
  logSolutionDebug("solve payload boundary", {
    stage: "api-parsed",
    endpoint,
    requestId: requestId || null,
    // Observe the received arrays before selection or placeholder repair.
    receivedCandidates: [raw, explanation, result, solution, problem].map((candidate, index) => ({
      path: ["response", "explanation", "result", "solution", "problem"][index],
      ...summarizeClientSteps(candidate.steps, "api-parsed"),
    })),
  });
  const sourceSteps = getRenderableSolutionSteps(raw);
  const boundaryErrors = sourceSteps.flatMap((step) => step.renderBoundaryError ? [step.renderBoundaryError] : []);
  if (boundaryErrors.length > 0) {
    console.error("[omnimath:solution-step-boundary]", {
      outcome: "accepted_empty",
      stage: "client-selection",
      requestId: requestId || null,
      endpoint,
      boundaryErrors,
    });
  }
  const steps = sourceSteps;
  const saveWarning = raw.runtime?.saveWarning || explanation.runtime?.saveWarning || result.runtime?.saveWarning || raw.saveWarning || "";
  const saveStatus = raw.runtime?.saveStatus
    || explanation.runtime?.saveStatus
    || result.runtime?.saveStatus
    || "";
  const warnings = [
    ...firstArray(raw.warnings, explanation.warnings, result.warnings, solution.warnings),
    ...(saveWarning ? [saveWarning] : []),
  ];
  const metadata = {
    ...(raw.metadata || {}),
    endpoint,
    requestId: requestId || null,
    runtime: raw.runtime || explanation.runtime || result.runtime || null,
    usage: raw.usage || explanation.usage || result.usage || null,
    savedExplanationId: raw.savedExplanationId || explanation.savedExplanationId || result.savedExplanationId || null,
    saveStatus: saveWarning
      ? "not_saved"
      : saveStatus || raw.savedExplanationId
        ? (saveStatus || "saved")
        : raw.saved === false
          ? "not_saved"
          : "unknown",
    rawKeys: Object.keys(raw),
  };
  const normalized = {
    ...raw,
    ...source,
    requestId: requestId || null,
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
  if (import.meta.env?.DEV && import.meta.env.VITE_DEBUG_MATH_RENDER === "true") {
    const responseFinalLine = raw.steps?.flatMap((step) => step?.lines || [])
      .find((line) => line?.role === "final_answer")?.latex || "";
    const selectedFinalLine = steps.flatMap((step) => step?.lines || [])
      .find((line) => line?.role === "final_answer")?.latex || "";
    console.info("[omnimath:final-answer-api-boundary]", {
      requestId: requestId || null,
      apiResponseFinalAnswerLatex: raw.finalAnswerLatex || "",
      apiResponseFinalLineLatex: responseFinalLine,
      selectedFinalAnswerLatex: normalized.finalAnswer,
      selectedFinalLineLatex: selectedFinalLine,
    });
  }
  logSolutionDebug("solve payload boundary", {
    stage: "client-normalized",
    endpoint,
    requestId: requestId || null,
    normalizedStepSummary: summarizeClientSteps(steps, "client-normalized"),
  });
  logFrontendReasoningLatexStage("4b.frontend_response_normalization", normalized);
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

/** @param {{ canonicalProblem?: any, history?: any[], sourceMetadata?: any, getToken?: any, signal?: AbortSignal, endpoint?: string }} options */
export async function solveCanonicalProblem({
  canonicalProblem,
  history = [],
  sourceMetadata = {},
  getToken,
  signal,
  endpoint = "/api/solve-extracted-problem",
}) {
  const safeCanonicalProblem = canonicalProblem || createCanonicalProblemPayload({
    canonicalText: sourceMetadata.problem || "",
    source: "typed",
  });
  const canonicalInput = getCanonicalSolverInput(safeCanonicalProblem);
  const debugRequestId = createClientRequestId("canonical-solve");
  const source = safeCanonicalProblem.source === "typed" ? "typed" : "ocr";
  logCanonicalProblem("solve request", safeCanonicalProblem, { endpoint, source });
  logSolutionDebug("api canonical-solve payload", {
    requestId: debugRequestId,
    canonicalInputHash: safeCanonicalProblem.hash,
    source,
    historyCount: Array.isArray(history) ? history.length : 0,
  });
  const authHeaders = await getAuthHeaders(getToken, endpoint, { fresh: true });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({
      problemInput: {
        problemText: canonicalInput,
        source,
        sourceMetadata,
      },
      problem: canonicalInput,
      problemText: canonicalInput,
      canonicalProblem: safeCanonicalProblem,
      history,
      extraction: sourceMetadata.extraction || {},
      solveDecision: sourceMetadata.solveDecision || "direct",
      reviewAction: sourceMetadata.reviewAction || null,
      debugRequestId,
    }),
    signal,
  });

  const parsed = await parseResponse(response);
  logSolutionDebug("api canonical-solve response", {
    requestId: parsed?.requestId || debugRequestId,
    status: response.status,
    ok: response.ok,
    code: parsed?.code,
    message: parsed?.message,
    source,
  });
  return normalizeSolveResponse(parsed, { endpoint, requestId: debugRequestId });
}

export async function explainProblem({ problem, canonicalLatex = "", history, getToken, signal }) {
  const canonicalProblem = createCanonicalProblemPayload({
    canonicalText: problem,
    canonicalLatex,
    source: "typed",
  });
  return solveCanonicalProblem({
    canonicalProblem,
    history,
    sourceMetadata: { problem, canonicalLatex },
    getToken,
    signal,
    endpoint: "/api/explain",
  });
}

export async function explainImageProblem({ file, prompt, history = [], getToken, quality, signal }) {
  const extraction = await extractImageProblem({ file, prompt, getToken, quality, signal });
  const canonicalProblem = canonicalProblemFromExtraction({
    extraction,
    canonicalText: extraction.extractedProblemText || extraction.rawExtractedText || "",
    source: "ocr-direct",
  });
  const payload = buildExtractionSubmissionPayload({
    extraction: { ...extraction, canonicalProblem },
    displayText: canonicalProblem.canonicalText,
    rawText: extraction.rawExtractedText || extraction.rawOcrText || canonicalProblem.canonicalText,
    solveDecision: "direct",
    source: "ocr-direct",
  });
  return solveExtractedProblem({ ...payload, history, getToken, signal });
}

export async function extractImageProblem({ file, prompt, getToken, quality, signal }) {
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
    signal,
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
  const reviewAction = solveDecision === "confirmed"
    ? { kind: "confirmed_unchanged", canonicalInputHash: canonicalProblem.hash }
    : solveDecision === "edited"
      ? { kind: "edited", canonicalInputHash: canonicalProblem.hash }
      : null;
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
    reviewAction,
  };
}

export async function solveExtractedProblem({
  problem = "",
  problemLatex = "",
  problemText = "",
  extraction = {},
  canonicalProblem = null,
  solveDecision = "direct",
  reviewAction = null,
  history = [],
  getToken,
  signal,
}) {
  const safeExtraction = objectOrEmpty(extraction);
  const frozenCanonicalProblem = canonicalProblem || safeExtraction.canonicalProblem || createCanonicalProblemPayload({
    canonicalText: problem,
    canonicalLatex: problemLatex,
    source: safeExtraction.submittedProblemSource ? "ocr-reviewed" : "typed",
    extractionWarnings: safeExtraction.issues || safeExtraction.extractionValidation?.issues || [],
    extractionConfidence: safeExtraction.confidence ?? safeExtraction.extractionValidation?.confidence,
  });
  return solveCanonicalProblem({
    canonicalProblem: frozenCanonicalProblem,
    sourceMetadata: {
      extraction: {
        ...safeExtraction,
        canonicalProblem: frozenCanonicalProblem,
      },
      solveDecision,
      reviewAction,
      problemLatex,
      problemText,
    },
    history,
    getToken,
    signal,
  });
}

export async function explainFollowup({ payload, getToken, signal }) {
  const authHeaders = await getAuthHeaders(getToken, "/api/explain-followup");
  const response = await fetch("/api/explain-followup", {
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
