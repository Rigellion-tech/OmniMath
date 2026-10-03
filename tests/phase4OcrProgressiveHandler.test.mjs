import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import "./helpers/noExternalNetwork.mjs";
import { imageIngestionRegistry } from "../server/imageIngestionRegistry.js";
import { recordExtraction, recordedSolvePayload } from "./helpers/recordedExtraction.mjs";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const owner = "local-dev-solve-extracted-problem";
let storeDir;
let handleSolveExtractedProblemRequest;

function frame(type, details = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...details })}\n\n`;
}

function solveFixture() {
  return {
    title: "Solve equation",
    problemLatex: "x+7=9",
    steps: [
      { id: "subtract", heading: "Subtract seven", latex: "x=9-7", reasoning: "Subtract seven from both sides.", anchors: [] },
      { id: "answer", heading: "Final answer", latex: "x=2", reasoning: "Simplify.", anchors: [] },
    ],
    finalAnswerLatex: "x=2",
    numericCheck: "",
  };
}

function providerStream(json) {
  const text = JSON.stringify(json);
  const split = text.indexOf('"reasoning"');
  const chunks = [
    frame("response.created", { response: { id: "phase4-ocr-progressive", model: "gpt-5.6-sol" } }),
    frame("response.output_text.delta", { delta: text.slice(0, split) }),
    frame("response.output_text.delta", { delta: text.slice(split) }),
    frame("response.completed", { response: {
      id: "phase4-ocr-progressive",
      model: "gpt-5.6-sol",
      status: "completed",
      usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 },
    } }),
  ];
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
  };
}

class ResponseRecorder extends EventEmitter {
  statusCode = null;
  headers = {};
  body = "";
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
  }
  flushHeaders() {}
  write(chunk) {
    this.body += String(chunk);
    return true;
  }
  end(chunk = "") {
    this.body += String(chunk);
    this.writableEnded = true;
    this.emit("close");
  }
}

function request(body) {
  return {
    method: "POST",
    url: "/api/solve-extracted-problem",
    headers: { "content-type": "application/json", host: "localhost:8787" },
    socket: { remoteAddress: "127.77.0.4" },
    body,
  };
}

function eventsFrom(response) {
  return response.body
    .split("\n\n")
    .filter(Boolean)
    .map((eventFrame) => JSON.parse(eventFrame.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
}

before(async () => {
  storeDir = join(tmpdir(), `omnimath-phase4-ocr-progressive-${process.pid}-${Date.now()}`);
  await mkdir(storeDir, { recursive: true });
  for (const key of Object.keys(process.env)) {
    if (/^(?:CLERK_|DATABASE_|POSTGRES_|USAGE_KV_|KV_|UPSTASH_)/u.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    NODE_ENV: "test",
    OPENAI_API_KEY: "offline-phase4-ocr-progressive",
    OMNIMATH_PROGRESSIVE_SOLVE_ENABLED: "true",
    USAGE_LOCAL_STORE_PATH: join(storeDir, "usage.json"),
    CLERK_SECRET_KEY: "",
    CLERK_JWT_KEY: "",
    DATABASE_URL: "",
    POSTGRES_URL: "",
  });
  ({ handleSolveExtractedProblemRequest } = await import(`../server/app.js?phase4-ocr-progressive=${Date.now()}`));
});

after(async () => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  await rm(storeDir, { recursive: true, force: true });
});

test("reviewed OCR receipt streams through the canonical solver, finishes the registry, and suppresses replay", async () => {
  const problem = "x+7=9";
  const extraction = await recordExtraction({
    owner,
    problem,
    latex: problem,
    extractionValidation: {
      status: "warning",
      tier: "medium",
      critical: true,
      confidence: 78,
      ocrConfidence: 82,
      mathIntegrityScore: 78,
      issues: [{ type: "text_latex_mismatch", severity: "high", message: "Confirm the transcription." }],
      metrics: {},
    },
  });
  assert.equal(extraction.ingestion.state, "review_required");

  const body = recordedSolvePayload(extraction, {
    solveDecision: "confirmed",
    reviewRevision: 0,
    body: {
      debugRequestId: "phase4-reviewed-stream",
      progressiveMode: "provider-stream",
      progressiveIdentity: {
        requestId: "phase4-reviewed-stream",
        attemptId: "phase4-reviewed-stream:1",
        sessionId: "phase4-reviewed-session",
        conversationId: "phase4-reviewed-session",
      },
    },
  });
  const providerCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses", "test must never reach an unmocked service");
    providerCalls.push(JSON.parse(options.body));
    return providerStream(solveFixture());
  };

  const response = new ResponseRecorder();
  await handleSolveExtractedProblemRequest(request(body), response);

  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.headers["Content-Type"], /text\/event-stream/);
  const events = eventsFrom(response);
  assert.deepEqual(events.map((event) => event.type), [
    "solve_started", "solution_metadata", "step_completed", "step_completed", "final_answer", "solve_completed",
  ]);
  const metadata = events.find((event) => event.type === "solution_metadata").metadata;
  assert.equal(metadata.canonicalProblem.canonicalText, problem);
  assert.equal(metadata.canonicalProblem.source, "ocr-reviewed");
  assert.equal(metadata.imageSource.imageHash, extraction.ingestion.imageHash);
  assert.equal(metadata.imageSource.ingestion.extractionId, extraction.ingestion.extractionId);
  assert.equal(metadata.imageSource.reviewAction.extractionId, extraction.ingestion.extractionId);
  assert.equal(metadata.imageSource.reviewAction.reviewRevision, 0);
  assert.equal(metadata.imageSource.reviewAction.canonicalInputHash, body.canonicalProblem.hash);
  assert.equal(providerCalls.length, 1);
  assert.match(JSON.stringify(providerCalls[0].input), /x\+7=9/);

  const finished = await imageIngestionRegistry.get({
    owner,
    receipt: extraction.extractionReceipt,
    ingestion: extraction.ingestion,
  });
  assert.equal(finished.ingestion.state, "solved");
  assert.equal(finished.review.revisionId, body.reviewRevisionId);
  assert.equal(finished.solve.status, "solved");

  const replay = new ResponseRecorder();
  await handleSolveExtractedProblemRequest(request(body), replay);
  assert.equal(replay.statusCode, 409, replay.body);
  assert.equal(JSON.parse(replay.body).code, "OCR_SOLVE_ALREADY_COMPLETED");
  assert.equal(providerCalls.length, 1, "completed progressive replay must not create a second paid provider call");
});
