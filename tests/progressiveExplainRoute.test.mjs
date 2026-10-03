import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import "./helpers/noExternalNetwork.mjs";
import { handleExplainRequest, handleSolveExtractedProblemRequest } from "../server/app.js";
import { getUsageSnapshot } from "../server/usageLimits.js";
import { productionClerkOwner, recordExtraction, recordedSolvePayload } from "./helpers/recordedExtraction.mjs";
import { makePhase5KktFixture, phase5KktProblem, phase5KktDuplicatedFinal } from "./fixtures/phase5FinalAnswer.mjs";
import { assessFinalAnswerPresentation, presentSolutionSteps } from "../src/lib/finalAnswerPresentation.js";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let storeDir;
let token;

function signedSession() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", typ: "JWT", kid: "progressive-route" })}.${encode({
    sub: "user_progressive_route", sid: "sess_progressive_route",
    iss: "https://offline-test.clerk.accounts.dev", iat: now, nbf: now - 1, exp: now + 300,
  })}`;
  return {
    jwtKey: publicKey.export({ type: "spki", format: "pem" }),
    token: `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`,
  };
}

function frame(type, details = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...details })}\n\n`;
}

function providerResponse(json, { fail = false } = {}) {
  const text = JSON.stringify(json);
  const breakAt = text.indexOf('"reasoning"');
  const chunks = [
    frame("response.created", { response: { id: "resp_route", model: "gpt-5.6-sol" } }),
    frame("response.output_text.delta", { delta: text.slice(0, breakAt) }),
    frame("response.output_text.delta", { delta: text.slice(breakAt, fail ? breakAt + 6 : undefined) }),
    fail
      ? frame("response.failed", { response: { id: "resp_route", status: "failed", error: { code: "interrupted" },
        usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } } })
      : frame("response.completed", { response: { id: "resp_route", model: "gpt-5.6-sol", status: "completed",
        usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } } }),
  ];
  return {
    ok: true, status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
  };
}

function solveFixture() {
  return {
    title: "Solve equation", problemLatex: "x+7=9",
    steps: [
      { id: "subtract", heading: "Subtract seven", latex: "x=9-7",
        reasoning: "Subtract seven from both sides.", anchors: [] },
      { id: "answer", heading: "Final answer", latex: "x=2", reasoning: "Simplify.", anchors: [] },
    ],
    finalAnswerLatex: "x=2", numericCheck: "",
  };
}

class ResponseRecorder extends EventEmitter {
  statusCode = null;
  headers = {};
  body = "";
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; }
  flushHeaders() {}
  write(chunk) { this.body += chunk; return true; }
  end(chunk = "") { this.body += chunk; this.writableEnded = true; this.emit("close"); }
}

function request(id) {
  return {
    method: "POST", url: "/api/explain",
    headers: { "content-type": "application/json", host: "localhost:8787", authorization: `Bearer ${token}` },
    socket: { remoteAddress: "127.9.0.77" },
    body: {
      problem: "x+7=9", debugRequestId: id, reference: id,
      progressiveMode: "provider-stream",
      progressiveIdentity: { requestId: id, attemptId: `${id}:1`, sessionId: "session-route", conversationId: "session-route" },
    },
  };
}

function eventsFrom(recorder) {
  return recorder.body.split("\n\n").filter(Boolean).map((frameText) =>
    JSON.parse(frameText.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
}

test("provider streaming stays disabled unless the server feature switch is enabled", async () => {
  const previous = process.env.OMNIMATH_PROGRESSIVE_SOLVE_ENABLED;
  process.env.OMNIMATH_PROGRESSIVE_SOLVE_ENABLED = "false";
  try {
    const recorder = new ResponseRecorder();
    await handleExplainRequest(request("route-disabled"), recorder);
    assert.equal(recorder.statusCode, 404);
    assert.equal(JSON.parse(recorder.body).code, "PROGRESSIVE_SOLVE_DISABLED");
  } finally {
    process.env.OMNIMATH_PROGRESSIVE_SOLVE_ENABLED = previous;
  }
});

before(async () => {
  storeDir = join(tmpdir(), `omnimath-progressive-route-${Date.now()}-${Math.random()}`);
  await mkdir(storeDir, { recursive: true });
  const session = signedSession();
  token = session.token;
  Object.assign(process.env, {
    NODE_ENV: "test", OPENAI_API_KEY: "offline-progressive-route",
    OMNIMATH_PROGRESSIVE_SOLVE_ENABLED: "true",
    // This transport suite exercises more than ten independent logical solves.
    // Rate-limit behavior is covered separately; do not exhaust its fixture bucket.
    AI_RATE_LIMIT_PER_MINUTE: "50",
    CLERK_JWT_KEY: session.jwtKey, USAGE_LOCAL_STORE_PATH: join(storeDir, "usage.json"),
  });
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
});

after(async () => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  await rm(storeDir, { recursive: true, force: true });
});

test("provider stream publishes only validated ordered solve events", async () => {
  globalThis.fetch = async () => providerResponse(solveFixture());
  const recorder = new ResponseRecorder();
  await handleExplainRequest(request("route-success"), recorder);
  assert.equal(recorder.statusCode, 200, recorder.body);
  assert.match(recorder.headers["Content-Type"], /text\/event-stream/);
  const events = eventsFrom(recorder);
  assert.deepEqual(events.map((event) => event.type), [
    "solve_started", "solution_metadata", "step_completed", "step_completed", "final_answer", "solve_completed",
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [0, 1, 2, 3, 4, 5]);
  assert.equal(events[2].validation.status, "accepted");
  assert.equal(events[2].validation.authority, "server-provider-stream");
  assert.equal(events[3].step.id, "answer");
  assert.equal(events[4].answer.finalAnswerLatex, "x=2");
  assert.equal(events[4].assurance.status, "supported_checks_passed");
  assert.equal(events[4].assurance.candidateId, "route-success:1:route:1:candidate:progressive");
});

test("a contradicted progressive final answer stays with its published prefix and reports assurance", async () => {
  let calls = 0;
  const fixture = solveFixture();
  fixture.steps[1].latex = "x=3";
  fixture.finalAnswerLatex = "x=3";
  globalThis.fetch = async () => { calls += 1; return providerResponse(fixture); };
  const recorder = new ResponseRecorder();
  await handleExplainRequest(request("route-contradicted"), recorder);
  const events = eventsFrom(recorder);
  assert.equal(calls, 1);
  assert.equal(events.at(-1).type, "solve_completed");
  assert.equal(events.find((event) => event.type === "final_answer").assurance.status,
    "contradiction_detected");
  assert.equal(events.filter((event) => event.type === "step_completed").at(-1).step.id,
    "answer");
  assert.equal(events.find((event) => event.type === "final_answer").answer.finalAnswerLatex,
    "x=3");
});

test("Phase 5 KKT presentation has ordinary/progressive parity without additional provider calls or prefix replacement", async () => {
  const fixture = makePhase5KktFixture();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    if (JSON.parse(options.body).stream) return providerResponse(fixture);
    return new Response(JSON.stringify({
      id: "resp_phase5_ordinary", model: "gpt-5.6-sol", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(fixture) }] }],
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const ordinaryRequest = request("phase5-ordinary");
  ordinaryRequest.body.problem = phase5KktProblem;
  delete ordinaryRequest.body.progressiveMode;
  delete ordinaryRequest.body.progressiveIdentity;
  const ordinaryRecorder = new ResponseRecorder();
  await handleExplainRequest(ordinaryRequest, ordinaryRecorder);
  assert.equal(ordinaryRecorder.statusCode, 200, ordinaryRecorder.body);
  const ordinary = JSON.parse(ordinaryRecorder.body);
  assert.equal(calls, 1);
  assert.equal(ordinary.candidateAcceptance.accepted, true);
  assert.notEqual(ordinary.finalAnswerPresentation.action, "preserved");
  assert.equal(ordinary.finalAnswerLatex, phase5KktDuplicatedFinal);

  const progressiveRequest = request("phase5-progressive");
  progressiveRequest.body.problem = phase5KktProblem;
  const progressiveRecorder = new ResponseRecorder();
  await handleExplainRequest(progressiveRequest, progressiveRecorder);
  assert.equal(progressiveRecorder.statusCode, 200);
  assert.equal(calls, 2, "one generation per path; presentation adds zero calls");
  const events = eventsFrom(progressiveRecorder);
  assert.equal(events.at(-1).type, "solve_completed");
  const published = events.filter((event) => event.type === "step_completed").map((event) => event.step);
  assert.equal(published.length, fixture.steps.length);
  assert.equal(published.at(-1).math, phase5KktDuplicatedFinal);
  const answer = events.find((event) => event.type === "final_answer").answer;
  assert.equal(answer.finalAnswerPresentation.action, ordinary.finalAnswerPresentation.action);
  const before = structuredClone(published);
  const projection = presentSolutionSteps(published, assessFinalAnswerPresentation({ ...answer, steps: published }));
  assert.deepEqual(published, before, "authoritative prefix stays intact");
  assert.ok(!projection.some((step) => step.id === "final-answer" && step.math === phase5KktDuplicatedFinal));
  assert.equal(events.some((event) => event.type.includes("replace")), false);
});

test("retry start echoes the superseded attempt so the strict client duplicate remains identical", async () => {
  globalThis.fetch = async () => providerResponse(solveFixture());
  const before = (await getUsageSnapshot({ req: request("usage-before-retry") })).usage.ai.daily.used;
  const retry = request("route-retry");
  retry.body.progressiveIdentity.supersedesAttemptId = "route-prior:1";
  const recorder = new ResponseRecorder();
  await handleExplainRequest(retry, recorder);
  assert.equal(recorder.statusCode, 200);
  const events = eventsFrom(recorder);
  assert.equal(events[0].type, "solve_started");
  assert.equal(events[0].supersedesAttemptId, "route-prior:1");
  assert.equal(events[1].supersedesAttemptId, undefined);
  const after = (await getUsageSnapshot({ req: request("usage-after-retry") })).usage.ai.daily.used;
  assert.equal(after, before + 1);
});

test("OCR-reviewed solves retain their review provenance through the shared streaming route", async () => {
  globalThis.fetch = async () => providerResponse(solveFixture());
  const ocr = request("route-ocr");
  ocr.url = "/api/solve-extracted-problem";
  const extraction = await recordExtraction({
    owner: productionClerkOwner("user_progressive_route", process.env.CLERK_JWT_KEY),
    problem: "x+7=9",
    latex: "x+7=9",
    imageHash: "stream-ocr-fixture",
  });
  Object.assign(ocr.body, recordedSolvePayload(extraction, { solveDecision: "edited", reviewRevision: 0 }));
  const recorder = new ResponseRecorder();
  await handleSolveExtractedProblemRequest(ocr, recorder);
  assert.equal(recorder.statusCode, 200, recorder.body);
  const events = eventsFrom(recorder);
  assert.equal(events[1].type, "solution_metadata");
  assert.equal(events[1].metadata.canonicalProblem.source, "ocr-reviewed");
  assert.equal(events[1].metadata.imageSource.imageHash, "stream-ocr-fixture");
  assert.equal(events[2].type, "step_completed");
  assert.equal(events.at(-1).type, "solve_completed");
});

test("provider failure preserves the completed prefix and discards partial next step", async () => {
  const fixture = solveFixture();
  const text = JSON.stringify(fixture);
  const split = text.indexOf('"id":"answer"');
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame("response.output_text.delta", { delta: text.slice(0, split + 8) })));
        controller.enqueue(new TextEncoder().encode(frame("response.failed", { response: {
          id: "resp_interrupted", status: "failed", error: { code: "interrupted" },
          usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 },
        } })));
        controller.close();
      },
    }),
  });
  const recorder = new ResponseRecorder();
  await handleExplainRequest(request("route-interrupted"), recorder);
  const events = eventsFrom(recorder);
  assert.deepEqual(events.map((event) => event.type), [
    "solve_started", "solution_metadata", "step_completed", "solve_failed",
  ]);
  assert.equal(events[2].step.id, "subtract");
  assert.equal(events[3].sequence, 3);
});

test("invalid completed step never crosses the server validation boundary", async () => {
  const fixture = solveFixture();
  fixture.steps[1].latex = "x+";
  globalThis.fetch = async () => providerResponse(fixture);
  const recorder = new ResponseRecorder();
  await handleExplainRequest(request("route-invalid-step"), recorder);
  const events = eventsFrom(recorder);
  assert.deepEqual(events.map((event) => event.type), [
    "solve_started", "solution_metadata", "step_completed", "solve_failed",
  ]);
  assert.equal(events[2].step.id, "subtract");
  assert.equal(events.some((event) => event.step?.id === "answer"), false);
});

test("client disconnect aborts late provider output and settles one provider call", async () => {
  const before = (await getUsageSnapshot({ req: request("usage-before-disconnect") })).usage.ai;
  const fixture = solveFixture();
  globalThis.fetch = async (_url, options) => ({
    ok: true, status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame("response.output_text.delta", {
          delta: JSON.stringify(fixture),
        }) + frame("response.completed", { response: {
          id: "late_after_disconnect", status: "completed",
          usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 },
        } })));
        options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
      },
    }),
  });
  const settlementLogs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    if (args[0] === "[omnimath:usage-unreconciled]") settlementLogs.push(args[1]);
    originalWarn(...args);
  };
  const recorder = new ResponseRecorder();
  const originalWrite = recorder.write.bind(recorder);
  recorder.write = (chunk) => {
    originalWrite(chunk);
    if (chunk.includes('"type":"step_completed"')) {
      recorder.destroyed = true;
      recorder.emit("close");
    }
    return true;
  };
  try {
    await handleExplainRequest(request("route-disconnect"), recorder);
  } finally {
    console.warn = originalWarn;
  }
  const events = eventsFrom(recorder);
  assert.deepEqual(events.map((event) => event.type), ["solve_started", "solution_metadata", "step_completed"]);
  const afterUsage = (await getUsageSnapshot({ req: request("usage-after-disconnect") })).usage.ai;
  assert.equal(afterUsage.daily.used, before.daily.used + 1);
  assert.ok(afterUsage.tokens.daily.used > before.tokens.daily.used,
    "missing terminal usage retains the token reservation");
  assert.equal(settlementLogs.length, 1);
  assert.equal(settlementLogs[0].usageStatus, "unknown_due_to_abort");
  assert.equal(settlementLogs[0].providerCalls, 1);
  assert.equal(settlementLogs[0].providerAttempts[0].timeoutSource, "upstream_abort");
});

test("idle provider stream reaches a failed terminal event on the solve deadline", async () => {
  const previousTimeout = process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS;
  process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS = "250";
  globalThis.fetch = async (_url, options) => ({
    ok: true, status: 200,
    body: new ReadableStream({
      start(controller) {
        options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
      },
    }),
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const recorder = new ResponseRecorder();
    await handleExplainRequest(request("route-idle-timeout"), recorder);
    assert.deepEqual(eventsFrom(recorder).map((event) => event.type), ["solve_started", "solve_failed"]);
  } finally {
    clearTimeout(keepAlive);
    if (previousTimeout === undefined) delete process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS;
    else process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS = previousTimeout;
  }
});
