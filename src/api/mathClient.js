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

async function getAuthHeaders(getToken) {
  if (typeof getToken !== "function") return {};

  try {
    const token = await getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export async function explainProblem({ problem, history, getToken }) {
  const authHeaders = await getAuthHeaders(getToken);
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

  const authHeaders = await getAuthHeaders(getToken);
  const response = await fetch("/api/explain-image", {
    method: "POST",
    headers: authHeaders,
    body: formData,
  });

  return parseResponse(response);
}
