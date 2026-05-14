import { loadEnvFiles } from "./env.js";
import { buildMathExplanationPrompt } from "./mathPrompt.js";
import { parseMultipartForm } from "./multipart.js";
import { assertOpenAiConfigured, createMathExplanation } from "./openai.js";
import { checkAndIncrementUsage, createUsageHeaders } from "./usageLimits.js";

loadEnvFiles();

const MAX_JSON_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PROBLEM_CHARS = 12000;

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(payload));
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

function sendError(res, error) {
  const statusCode = error.statusCode || 500;
  const isServerError = statusCode >= 500;
  const message = isServerError && isProductionRuntime()
    ? error.publicMessage || "The AI backend could not complete the request."
    : error.publicMessage || error.message;

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

  sendJson(res, statusCode, payload, createUsageHeaders(error.usage, { includeRetryAfter: statusCode === 429 }));
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

  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw createBadInputError(`History item ${index + 1} is invalid.`);
    }

    const role = item.role === "tutor" || item.role === "assistant" ? "tutor" : "user";
    if (typeof item.text !== "string") {
      throw createBadInputError(`History item ${index + 1} is missing text.`);
    }

    return { role, text: item.text };
  });
}

function requireImage(file) {
  if (!file) {
    throw Object.assign(new Error("Image file is required."), {
      statusCode: 400,
      code: "BAD_INPUT",
    });
  }
  if (!file.contentType.startsWith("image/")) {
    throw Object.assign(new Error("Uploaded file must be an image."), {
      statusCode: 400,
      code: "BAD_INPUT",
    });
  }
  if (file.buffer.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error("Image file is too large."), {
      statusCode: 413,
      code: "BAD_INPUT",
    });
  }
  return file;
}

async function runHandler(res, handler) {
  try {
    await handler();
  } catch (error) {
    sendError(res, error);
  }
}

export async function handleHealthRequest(req, res) {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, ["GET"]);
    return;
  }

  sendJson(res, 200, { ok: true });
}

export async function handleExplainRequest(req, res) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  await runHandler(res, async () => {
    const body = await readJson(req);
    const problem = requireTextProblem(body.problem ?? body.prompt);
    const history = parseHistory(body.history);
    assertOpenAiConfigured();
    const usage = await checkAndIncrementUsage({ req, kind: "explanation" });
    const prompt = buildMathExplanationPrompt({ problem, history });
    const result = await createMathExplanation({ prompt });
    sendJson(res, 200, { ...result, usage }, createUsageHeaders(usage));
  });
}

export async function handleExplainImageRequest(req, res) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  await runHandler(res, async () => {
    const body = await readBody(req, MAX_IMAGE_BYTES + MAX_JSON_BYTES);
    const { fields, files } = parseMultipartForm(body, req.headers["content-type"]);
    const problem = requireTextProblem(fields.prompt || "Explain the math problem in this image.");
    const image = requireImage(files.file);
    assertOpenAiConfigured();
    const usage = await checkAndIncrementUsage({ req, kind: "image" });
    const prompt = buildMathExplanationPrompt({ problem, image: true });
    const result = await createMathExplanation({ prompt, image });
    sendJson(res, 200, { ...result, usage }, createUsageHeaders(usage));
  });
}

export async function handleApiRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/health") {
    await handleHealthRequest(req, res);
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

  sendJson(res, 404, { code: "NOT_FOUND", error: "Not found", message: "Not found" });
}
