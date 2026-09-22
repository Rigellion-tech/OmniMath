import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { createCanonicalProblemPayload } from "../src/lib/canonicalProblem.js";

function responseRecorder() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk = "") {
      this.body += chunk;
    },
    json() {
      return JSON.parse(this.body || "{}");
    },
  };
}

async function invoke(handler, url, body, remoteAddress) {
  const req = {
    method: "POST",
    url,
    headers: { "content-type": "application/json", host: "localhost:8787" },
    socket: { remoteAddress },
    body,
  };
  const res = responseRecorder();
  await handler(req, res);
  return res;
}

it("typed and OCR canonical input enter one solve orchestration while OCR provenance remains metadata", async () => {
  const originalEnv = { ...process.env };
  const storeDir = join(tmpdir(), `omnimath-canonical-solve-${Date.now()}-${Math.random()}`);
  await mkdir(storeDir, { recursive: true });
  process.env.NODE_ENV = "test";
  process.env.OMNIMATH_DEBUG_SOLVE = "1";
  process.env.USAGE_LOCAL_STORE_PATH = join(storeDir, "usage.json");
  delete process.env.OPENAI_API_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CLERK_JWT_KEY;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;

  const solveEvents = [];
  const originalInfo = console.info;
  console.info = (...args) => {
    if (args[0] === "[omnimath:solve-debug]") solveEvents.push(args[1]);
  };

  try {
    const app = await import(`../server/app.js?canonical-solve-${Date.now()}-${Math.random()}`);
    const problem = "Differentiate x^2 using the power rule";
    const canonicalText = { canonicalText: problem, canonicalLatex: "", extractionWarnings: [], extractionConfidence: null };
    const typed = await invoke(app.handleExplainRequest, "/api/explain", {
      problem,
      canonicalProblem: { ...canonicalText, source: "typed" },
      debugRequestId: "canonical-typed",
    }, "127.3.0.1");
    const ocrCanonicalProblem = createCanonicalProblemPayload({
      ...canonicalText,
      source: "ocr-reviewed",
      extractionConfidence: 93,
    });
    const ocr = await invoke(app.handleSolveExtractedProblemRequest, "/api/solve-extracted-problem", {
      problem,
      problemText: problem,
      canonicalProblem: ocrCanonicalProblem,
      extraction: {
        imageHash: "image-provenance-hash",
        extractedProblemText: problem,
        confidence: 93,
        ocrConfidence: 91,
        mathIntegrityScore: 94,
        confidenceTier: "high",
        issues: [],
      },
      solveDecision: "edited",
      reviewAction: { kind: "edited", canonicalInputHash: ocrCanonicalProblem.hash },
      debugRequestId: "canonical-ocr",
    }, "127.3.0.2");

    assert.equal(typed.statusCode, 200);
    assert.equal(ocr.statusCode, 200);
    const typedBody = typed.json();
    const ocrBody = ocr.json();
    assert.deepEqual(typedBody.steps, ocrBody.steps);
    assert.equal(ocrBody.canonicalProblem.source, "ocr-reviewed");
    assert.equal(ocrBody.imageSource.imageHash, "image-provenance-hash");
    assert.equal(ocrBody.imageSource.editedBeforeSolving, true);

    const entries = solveEvents.filter((event) => event.event === "shared_solver_entry");
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((event) => event.requestId), ["canonical-typed", "canonical-ocr"]);
    assert.equal(entries[0].normalizedProblemHash, entries[1].normalizedProblemHash);
    assert.deepEqual(entries.map((event) => event.endpoint), ["/api/explain", "/api/solve-extracted-problem"]);
    assert.deepEqual(entries.map((event) => event.inputSource), ["typed", "ocr-reviewed"]);

    const routing = solveEvents.filter((event) => event.event === "request_received");
    assert.equal(routing.length, 2);
    assert.equal(routing[0].selectedInitialModelRole, routing[1].selectedInitialModelRole);
    assert.equal(routing[0].routingDecision, routing[1].routingDecision);
    assert.equal(routing[0].solveTimeoutMs, routing[1].solveTimeoutMs);
    assert.ok(routing[0].solveTimeoutMs > 0);
  } finally {
    console.info = originalInfo;
    process.env = originalEnv;
    await rm(storeDir, { recursive: true, force: true });
  }
});
