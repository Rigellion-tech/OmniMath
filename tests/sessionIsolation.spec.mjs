import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { annotateMathExplanation } from "../src/lib/mathAnnotator.js";

const OCR_TEXT = "Race OCR problem: solve x+1=2.";
const OCR_LATEX = "x+1=2";
const OCR_TEXT_A1 = "Older OCR problem: solve y+1=3.";
const OCR_TEXT_A2 = "Newer OCR problem: solve z+2=5.";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createReadableMathPng() {
  const width = 1000;
  const height = 760;
  const channels = 3;
  const rowLength = width * channels;
  const raw = Buffer.alloc((rowLength + 1) * height, 255);

  for (let y = 0; y < height; y += 1) raw[y * (rowLength + 1)] = 0;

  const drawRect = (x, y, w, h) => {
    for (let row = y; row < y + h; row += 1) {
      const rowStart = row * (rowLength + 1) + 1;
      for (let col = x; col < x + w; col += 1) {
        const offset = rowStart + col * channels;
        raw[offset] = 10;
        raw[offset + 1] = 18;
        raw[offset + 2] = 20;
      }
    }
  };

  for (let line = 0; line < 8; line += 1) {
    const y = 90 + line * 72;
    drawRect(150, y, 680 - line * 18, 18);
    drawRect(150, y + 30, 430 + line * 20, 12);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createExtractionResponse({
  text = OCR_TEXT,
  latex = OCR_LATEX,
  confidenceTier = "high",
  critical = false,
} = {}) {
  const directSolveAllowed = confidenceTier === "high" && !critical;
  return {
    extractedProblemText: text,
    rawExtractedText: text,
    rawOcrText: text,
    cleanedPlainText: text,
    extractedProblemLatex: latex,
    confidence: 96,
    mathIntegrityScore: 96,
    confidenceTier,
    ocrConfidence: 96,
    issues: [],
    extractionValidation: {
      status: "pass",
      tier: confidenceTier,
      critical,
      confidence: 96,
      mathIntegrityScore: 96,
      ocrConfidence: 96,
      issues: [],
    },
    ocrSolveDecision: {
      solveDecision: "direct",
      reviewRequired: !directSolveAllowed,
      allowed: directSolveAllowed,
      reason: directSolveAllowed
        ? "ocr-no-structural-review-finding"
        : "ocr-review-required",
    },
    usage: { kind: "image", remaining: 998, limit: 999 },
  };
}

function createSolveResponse({
  title = "Race solution",
  problem = OCR_TEXT,
  expression = OCR_LATEX,
  finalAnswerLatex = "x=1",
} = {}) {
  return annotateMathExplanation({
    title,
    problem,
    expression,
    steps: [
      { id: `${title}-1`, label: "Isolate", math: expression, summary: "Set up the isolated equation." },
      { id: `${title}-2`, label: "Final answer", math: finalAnswerLatex, summary: "Read the final value." },
    ],
    finalAnswerLatex,
    usage: { kind: "image", aggregateKind: "ai", remaining: 997, limit: 999 },
  });
}

async function installSessionStore(page) {
  const sessions = [];
  sessions.saveRequests = [];
  await page.route("**/api/usage", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ usage: { ai: { used: 0, remaining: 999, limit: 999 } } }),
    });
  });
  await page.route("**/api/sessions**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions }),
      });
      return;
    }

    const payload = request.postDataJSON()?.session || {};
    sessions.saveRequests.push({
      method: request.method(),
      url: request.url(),
      sessionId: payload.id || null,
    });
    const id = payload.id || randomUUID();
    const now = new Date().toISOString();
    const saved = {
      id,
      title: payload.title || "Saved session",
      createdAt: sessions.find((session) => session.id === id)?.createdAt || now,
      updatedAt: now,
      ...payload,
    };
    const index = sessions.findIndex((session) => session.id === id);
    if (index === -1) sessions.unshift(saved);
    else sessions[index] = saved;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session: saved }),
    });
  });
  return sessions;
}

function sessionButtons(page) {
  return page.locator("aside .omni-scrollbar button");
}

function renderedMath(page, latex) {
  return page.locator(`[data-token-latex="${latex}"]`).first();
}

function renderedProblemText(page, text) {
  return page.getByRole("main").getByText(text);
}

function captureSessionDiagnostics(page) {
  const events = [];
  page.on("console", (message) => {
    if (message.type() !== "info" || !message.text().includes("[omnimath:session-operation]")) return;
    const payload = message.args()[1];
    if (!payload) return;
    events.push(payload.jsonValue().catch(() => null));
  });
  return {
    async values() {
      return (await Promise.all(events)).filter(Boolean);
    },
  };
}

async function uploadAndAnalyze(page, name = "race-readable-math.png") {
  await page.locator("input[type='file']").setInputFiles({
    name,
    mimeType: "image/png",
    buffer: createReadableMathPng(),
  });
  await expect(page.getByRole("button", { name: /Analyze with AI/i })).toBeEnabled();
  await page.getByRole("button", { name: /Analyze with AI/i }).click();
}

test("image OCR and solve stay bound to the originating session across switches", async ({ page }) => {
  const diagnostics = captureSessionDiagnostics(page);
  const savedSessions = await installSessionStore(page);
  let extractCount = 0;
  let solveCount = 0;
  let resolveExtractRoute;
  let resolveSolveRoute;
  const extractRoutePromise = new Promise((resolve) => { resolveExtractRoute = resolve; });
  const solveRoutePromise = new Promise((resolve) => { resolveSolveRoute = resolve; });

  await page.route("**/api/extract-image-problem", async (route) => {
    extractCount += 1;
    resolveExtractRoute(route);
  });
  await page.route("**/api/solve-extracted-problem", async (route) => {
    solveCount += 1;
    resolveSolveRoute(route);
  });

  await page.goto("/?mockAuth=1");
  await uploadAndAnalyze(page);
  const extractRoute = await extractRoutePromise;

  await page.getByRole("button", { name: /New session/i }).click();
  await expect(page.getByText(OCR_TEXT)).toHaveCount(0);
  await expect(page.getByText(/Reading image|Solving reviewed problem|Explanation ready/i)).toHaveCount(0);

  await extractRoute.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(createExtractionResponse()),
  });
  const solveRoute = await solveRoutePromise;

  await expect(page.getByText(OCR_TEXT)).toHaveCount(0);
  await expect(page.getByText(/Reading image|Solving reviewed problem|Explanation ready|Race solution/i)).toHaveCount(0);

  await sessionButtons(page).nth(1).click();
  await expect(renderedProblemText(page, OCR_TEXT)).toBeVisible();
  await expect(page.getByText(/Solving reviewed problem/i)).toBeVisible();

  await solveRoute.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(createSolveResponse()),
  });
  await expect(page.getByText(/Explanation ready/i)).toBeVisible();
  await expect(renderedMath(page, "x=1")).toBeVisible();

  await sessionButtons(page).nth(0).click();
  await expect(page.getByText(OCR_TEXT)).toHaveCount(0);
  await expect(page.getByText(/Solving reviewed problem/i)).toHaveCount(0);
  await expect(renderedMath(page, "x=1")).toHaveCount(0);

  expect(extractCount).toBe(1);
  expect(solveCount).toBe(1);
  expect(savedSessions.saveRequests).toHaveLength(0);
  expect(savedSessions).toHaveLength(0);

  await sessionButtons(page).nth(1).click();
  await expect(renderedProblemText(page, OCR_TEXT)).toBeVisible();
  await expect(renderedMath(page, "x=1")).toBeVisible();
  const diagnosticEvents = await diagnostics.values();
  expect(diagnosticEvents.some((event) => event.event === "operation-created")).toBe(true);
  expect(diagnosticEvents.some((event) => event.event === "extraction-started")).toBe(true);
  expect(diagnosticEvents.some((event) => event.event === "solve-started")).toBe(true);
  expect(diagnosticEvents.some((event) => event.event === "operation-result-applied")).toBe(true);
  for (const event of diagnosticEvents.filter((item) => item.operationId)) {
    expect(event).toEqual(expect.objectContaining({
      operationId: expect.anything(),
      originSessionId: expect.anything(),
      activeSessionId: expect.anything(),
      revision: expect.anything(),
    }));
    expect(JSON.stringify(event)).not.toMatch(/Bearer|sk-|api[_-]?key|token/i);
  }
});

test("image extraction failure applies only to the origin session while another session is active", async ({ page }) => {
  let extractCount = 0;
  let resolveExtractRoute;
  const extractRoutePromise = new Promise((resolve) => { resolveExtractRoute = resolve; });

  await installSessionStore(page);
  await page.route("**/api/extract-image-problem", async (route) => {
    extractCount += 1;
    resolveExtractRoute(route);
  });
  await page.route("**/api/solve-extracted-problem", async (route) => {
    throw new Error(`Unexpected solve request: ${route.request().url()}`);
  });

  await page.goto("/?mockAuth=1");
  await uploadAndAnalyze(page, "failure-readable-math.png");
  const extractRoute = await extractRoutePromise;
  await page.getByRole("button", { name: /New session/i }).click();
  await extractRoute.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ message: "Synthetic extraction failure", code: "AI_SERVICE_UNAVAILABLE" }),
  });

  await expect(page.getByText(/Image analysis failed|Synthetic extraction failure/i)).toHaveCount(0);
  await expect(page.getByText(OCR_TEXT)).toHaveCount(0);
  await sessionButtons(page).nth(1).click();
  await expect(page.getByText(/Image analysis failed/i)).toBeVisible();
  expect(extractCount).toBe(1);
});

test("older image operation completion cannot overwrite a newer operation in the same session", async ({ page }) => {
  const extractionRoutes = [];
  const solveRoutes = [];

  await installSessionStore(page);
  await page.route("**/api/extract-image-problem", async (route) => {
    extractionRoutes.push(route);
  });
  await page.route("**/api/solve-extracted-problem", async (route) => {
    solveRoutes.push(route);
  });

  await page.goto("/?mockAuth=1");
  await uploadAndAnalyze(page, "older-readable-math.png");
  await expect.poll(() => extractionRoutes.length).toBe(1);

  await page.getByRole("button", { name: /Clear selected image/i }).click();
  await uploadAndAnalyze(page, "newer-readable-math.png");
  await expect.poll(() => extractionRoutes.length).toBe(2);

  await extractionRoutes[1].fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(createExtractionResponse({ text: OCR_TEXT_A2, latex: "z+2=5" })),
  });
  await expect.poll(() => solveRoutes.length).toBe(1);
  await solveRoutes[0].fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(createSolveResponse({
      title: "Newer race solution",
      problem: OCR_TEXT_A2,
      expression: "z+2=5",
      finalAnswerLatex: "z=3",
    })),
  });

  await expect(page.getByText(/Explanation ready/i)).toBeVisible();
  await expect(renderedProblemText(page, OCR_TEXT_A2)).toBeVisible();
  await expect(renderedMath(page, "z=3")).toBeVisible();

  await extractionRoutes[0].fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(createExtractionResponse({ text: OCR_TEXT_A1, latex: "y+1=3" })),
  });

  await expect(renderedProblemText(page, OCR_TEXT_A2)).toBeVisible();
  await expect(renderedMath(page, "z=3")).toBeVisible();
  await expect(page.getByText(OCR_TEXT_A1)).toHaveCount(0);
  expect(extractionRoutes).toHaveLength(2);
  expect(solveRoutes).toHaveLength(1);
});
