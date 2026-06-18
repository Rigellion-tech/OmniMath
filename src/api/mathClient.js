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
  if (!import.meta.env.DEV) return;
  console.info("[omnimath:frontend-auth]", {
    endpoint,
    ...details,
  });
}

async function getAuthHeaders(getToken, endpoint) {
  if (typeof getToken !== "function") {
    logAuthDebug(endpoint, { getTokenAvailable: false, authorizationHeaderSent: false });
    return {};
  }

  try {
    const token = await getToken();
    logAuthDebug(endpoint, {
      getTokenAvailable: true,
      authorizationHeaderSent: Boolean(token),
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
  const authHeaders = await getAuthHeaders(getToken, "/api/explain");
  const response = await fetch("/api/explain", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({
      problem,
      history,
    }),
  });

  return parseResponse(response);
}

export async function explainImageProblem({ file, prompt, getToken, quality }) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("prompt", prompt);
  if (Number.isFinite(quality?.metrics?.ocrConfidence)) {
    formData.append("ocrConfidence", String(quality.metrics.ocrConfidence));
  }

  const authHeaders = await getAuthHeaders(getToken, "/api/explain-image");
  const response = await fetch("/api/explain-image", {
    method: "POST",
    headers: authHeaders,
    body: formData,
  });

  return parseResponse(response);
}

export async function extractImageProblem({ file, prompt, getToken, quality }) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("prompt", prompt);
  if (Number.isFinite(quality?.metrics?.ocrConfidence)) {
    formData.append("ocrConfidence", String(quality.metrics.ocrConfidence));
  }

  const authHeaders = await getAuthHeaders(getToken, "/api/extract-image-problem");
  const response = await fetch("/api/extract-image-problem", {
    method: "POST",
    headers: authHeaders,
    body: formData,
  });

  return parseResponse(response);
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
  };

  return {
    problem: normalizedText,
    problemText: editableDisplayText,
    extraction: payloadExtraction,
    solveDecision,
  };
}

export async function solveExtractedProblem({
  problem = "",
  problemLatex = "",
  problemText = "",
  extraction = {},
  solveDecision = "direct",
  getToken,
}) {
  const authHeaders = await getAuthHeaders(getToken, "/api/solve-extracted-problem");
  const response = await fetch("/api/solve-extracted-problem", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({
      problem,
      problemLatex,
      problemText,
      extraction,
      solveDecision,
    }),
  });

  return parseResponse(response);
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
  const authHeaders = await getAuthHeaders(getToken, "/api/compare-methods");
  const response = await fetch("/api/compare-methods", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify(payload || {}),
  });

  return parseResponse(response);
}
