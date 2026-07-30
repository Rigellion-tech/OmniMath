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

function logPersistenceAuth(event, details = {}) {
  if (!import.meta.env.DEV) return;
  console.info("[omnimath:persistence-auth]", {
    event,
    ...details,
  });
}

async function getAuthHeaders(getToken, { fresh = false, endpoint = "" } = {}) {
  if (typeof getToken !== "function") return {};

  try {
    const token = await getToken(fresh ? { skipCache: true } : undefined);
    if (fresh) {
      logPersistenceAuth("persistence-auth-refresh", {
        endpoint,
        tokenPresent: Boolean(token),
      });
    }
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch (error) {
    logPersistenceAuth("persistence-auth-failure", {
      endpoint,
      message: error.message,
    });
    return {};
  }
}

export async function syncCurrentUser({ getToken, profile }) {
  const authHeaders = await getAuthHeaders(getToken);
  const response = await fetch("/api/me", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({ profile }),
  });

  return parseResponse(response);
}

export async function fetchUserHistory({ getToken }) {
  const authHeaders = await getAuthHeaders(getToken);
  const response = await fetch("/api/history", {
    headers: authHeaders,
  });

  return parseResponse(response);
}

export async function fetchUsageSnapshot({ getToken }) {
  const authHeaders = await getAuthHeaders(getToken);
  const response = await fetch("/api/usage", {
    headers: authHeaders,
  });

  return parseResponse(response);
}

function buildSessionPayload(session) {
  return {
    id: session.id,
    title: session.title,
    demoKey: null,
    messages: session.messages || [],
    problems: session.problems || (session.problem ? [session.problem] : []),
    problem: session.problem || null,
    steps: session.steps || session.problem?.steps || [],
    pinnedWindows: session.pinnedWindows || [],
  };
}

export async function fetchUserSessions({ getToken }) {
  const authHeaders = await getAuthHeaders(getToken);
  const response = await fetch("/api/sessions", {
    headers: authHeaders,
  });

  return parseResponse(response);
}

export async function createUserSession({ getToken, session }) {
  const authHeaders = await getAuthHeaders(getToken, { fresh: true, endpoint: "/api/sessions:create" });
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({ session: buildSessionPayload(session) }),
  });

  return parseResponse(response);
}

export async function updateUserSession({ getToken, session }) {
  const authHeaders = await getAuthHeaders(getToken, { fresh: true, endpoint: "/api/sessions:update" });
  const response = await fetch(`/api/sessions?id=${encodeURIComponent(session.id)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({ session: buildSessionPayload(session) }),
  });

  return parseResponse(response);
}
