async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof body === "object" && body !== null
      ? body.message || body.error
      : body;
    throw Object.assign(
      new Error(message || `Request failed with status ${response.status}`),
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

export async function explainImageProblem({ file, prompt, getToken }) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("prompt", prompt);

  const authHeaders = await getAuthHeaders(getToken, "/api/explain-image");
  const response = await fetch("/api/explain-image", {
    method: "POST",
    headers: authHeaders,
    body: formData,
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
