import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import "./helpers/noExternalNetwork.mjs";
import { handleExplainRequest } from "../server/app.js";
import { classifyProgressiveFailure, decideProgressiveRecovery } from "../server/progressiveRecoveryPolicy.js";
import { getUsageSnapshot } from "../server/usageLimits.js";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let storeDir;
let token;
let sequence = 0;

function signedSession() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT", kid: "progressive-recovery" })}.${encode({
    sub: "user_progressive_recovery", sid: "sess_progressive_recovery",
    iss: "https://offline-test.clerk.accounts.dev", iat: now, nbf: now - 1, exp: now + 300,
  })}`;
  return {
    jwtKey: publicKey.export({ type: "spki", format: "pem" }),
    token: `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`,
  };
}

function fixture() {
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

function frame(type, details = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...details })}\n\n`;
}

function stream(chunks) {
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

function completed(value, { id = "resp_recovered", model = "gpt-5.6-sol", tokens = 9 } = {}) {
  return stream([
    frame("response.created", { response: { id, model } }),
    frame("response.output_text.delta", { delta: JSON.stringify(value) }),
    frame("response.completed", { response: { id, model, status: "completed",
      usage: { input_tokens: 4, output_tokens: tokens - 4, total_tokens: tokens } } }),
  ]);
}

function failed({ code = "server_error", model = "gpt-5.6-sol", id = "resp_failed", tokens = 6 } = {}) {
  return stream([
    frame("response.created", { response: { id, model } }),
    frame("response.failed", { response: { id, model, status: "failed", error: { code },
      usage: { input_tokens: 3, output_tokens: tokens - 3, total_tokens: tokens } } }),
  ]);
}

function httpError(status, code) {
  return {
    ok: false, status, statusText: code,
    text: async () => JSON.stringify({ error: { code, message: code } }),
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

function request(label) {
  const id = `recovery-${label}-${++sequence}`;
  return {
    method: "POST", url: "/api/explain",
    headers: { "content-type": "application/json", host: "localhost:8787", authorization: `Bearer ${token}` },
    socket: { remoteAddress: "127.9.0.88" },
    body: {
      problem: "x+7=9", debugRequestId: id, reference: id,
      progressiveMode: "provider-stream",
      progressiveIdentity: { requestId: id, attemptId: `${id}:1`, sessionId: "session-recovery", conversationId: "session-recovery" },
    },
  };
}

function eventsFrom(recorder) {
  return recorder.body.split("\n\n").filter(Boolean).map((part) =>
    JSON.parse(part.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
}

function types(recorder) { return eventsFrom(recorder).map((event) => event.type); }

async function dailyUsage(req) {
  return (await getUsageSnapshot({ req })).usage.ai;
}

before(async () => {
  storeDir = join(tmpdir(), `omnimath-progressive-recovery-${Date.now()}-${Math.random()}`);
  await mkdir(storeDir, { recursive: true });
  const session = signedSession();
  token = session.token;
  Object.assign(process.env, {
    NODE_ENV: "test", OPENAI_API_KEY: "offline-progressive-recovery",
    OMNIMATH_PROGRESSIVE_SOLVE_ENABLED: "true", OPENAI_RETRY_BASE_DELAY_MS: "0",
    OMNIMATH_ESCALATION_MODEL: "gpt-6-astra",
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

test("transient pre-prefix failure retries one provider call inside one visible solve", async () => {
  const calls = [];
  const telemetry = [];
  const originalConsoleInfo = console.info;
  console.info = (message, ...rest) => {
    const marker = ["[omnimath:progressive-recovery]", "[omnimath:progressive-terminal]"]
      .find((candidate) => String(message).startsWith(`${candidate} `));
    if (marker) {
      telemetry.push({ marker, details: JSON.parse(String(message).slice(marker.length + 1)) });
    }
    originalConsoleInfo(message, ...rest);
  };
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return calls.length === 1 ? failed() : completed(fixture());
  };
  const req = request("transient");
  const beforeUsage = await dailyUsage(req);
  const recorder = new ResponseRecorder();
  try {
    await handleExplainRequest(req, recorder);
  } finally {
    console.info = originalConsoleInfo;
  }
  const events = eventsFrom(recorder);
  assert.deepEqual(events.map((event) => event.type), [
    "solve_started", "solution_metadata", "step_completed", "step_completed", "final_answer", "solve_completed",
  ]);
  assert.equal(calls.length, 2);
  assert.equal(events.filter((event) => event.type === "solve_started").length, 1);
  assert.equal(events[2].step.id, "subtract");
  assert.equal(events.at(-1).model, "gpt-5.6-sol");
  const afterUsage = await dailyUsage(req);
  assert.equal(afterUsage.daily.used, beforeUsage.daily.used + 2);
  assert.equal(afterUsage.tokens.daily.used, beforeUsage.tokens.daily.used + 15);
  const providerAttempts = telemetry.filter((entry) => entry.marker === "[omnimath:progressive-recovery]");
  assert.equal(providerAttempts.length, 2);
  assert.deepEqual(providerAttempts.map((entry) => entry.details.usage.totalTokens), [6, 9]);
  const terminal = telemetry.find((entry) => entry.marker === "[omnimath:progressive-terminal]")?.details;
  assert.equal(terminal.providerCallCount, 2);
  assert.equal(terminal.retryCount, 1);
  assert.equal(terminal.repairCount, 0);
  assert.equal(terminal.escalationCount, 0);
  assert.equal(terminal.aggregateUsage.totalTokens, 15);
  assert.equal(terminal.aggregateUsage.usageComplete, true);
  assert.equal(terminal.aggregateUsage.reportedProviderCalls, 2);
  assert.equal(terminal.initialSelectedModel, "gpt-5.6-sol");
  assert.equal(terminal.finalAuthoritativeModel, "gpt-5.6-sol");
  assert.equal(terminal.settlementStatus, "settled");
  assert.equal(terminal.partialPrefixFailure, false);
  assert.equal(Number.isFinite(terminal.firstProviderEventMs), true);
  assert.equal(Number.isFinite(terminal.firstValidatedStepMs), true);
  assert.equal(terminal.firstValidatedStepMs >= terminal.firstProviderEventMs, true);
});

test("completed malformed candidate is repaired before any metadata or Step 1 appears", async () => {
  const bad = fixture();
  bad.title = "Rejected draft";
  bad.steps[0].latex = "x+";
  const calls = [];
  const req = request("repair");
  const beforeUsage = await dailyUsage(req);
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return calls.length === 1 ? completed(bad, { id: "resp_invalid" }) : completed(fixture(), { id: "resp_repair" });
  };
  const recorder = new ResponseRecorder();
  await handleExplainRequest(req, recorder);
  const events = eventsFrom(recorder);
  assert.equal(calls.length, 2);
  assert.deepEqual(types(recorder), [
    "solve_started", "solution_metadata", "step_completed", "step_completed", "final_answer", "solve_completed",
  ]);
  assert.equal(events[1].metadata.title, "Solve equation");
  assert.equal(events[2].step.math, "x=9-7");
  assert.equal(events.filter((event) => event.type === "step_completed" && event.stepIndex === 0).length, 1);
  const afterUsage = await dailyUsage(req);
  assert.equal(afterUsage.daily.used, beforeUsage.daily.used + 2);
  assert.equal(afterUsage.tokens.daily.used, beforeUsage.tokens.daily.used + 18);
});

test("explicit lower-model inability escalates to configured stronger model with correct attribution", async () => {
  const models = [];
  const req = request("escalate");
  const beforeUsage = await dailyUsage(req);
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    models.push(payload.model);
    return models.length === 1
      ? failed({ code: "model_not_capable" })
      : completed(fixture(), { model: payload.model, id: "resp_escalated" });
  };
  const recorder = new ResponseRecorder();
  await handleExplainRequest(req, recorder);
  const events = eventsFrom(recorder);
  assert.deepEqual(models, ["gpt-5.6-sol", "gpt-6-astra"]);
  assert.deepEqual(types(recorder), [
    "solve_started", "solution_metadata", "step_completed", "step_completed", "final_answer", "solve_completed",
  ]);
  assert.equal(events[1].metadata.model, "gpt-6-astra");
  assert.equal(events.at(-1).model, "gpt-6-astra");
  const afterUsage = await dailyUsage(req);
  assert.equal(afterUsage.daily.used, beforeUsage.daily.used + 2);
  assert.equal(afterUsage.tokens.daily.used, beforeUsage.tokens.daily.used + 15);
});

test("same-model higher-reasoning progressive escalation is materially distinct", async () => {
  const prior = {
    model: process.env.OMNIMATH_ESCALATION_MODEL,
    solverEffort: process.env.OMNIMATH_SOLVER_REASONING_EFFORT,
    escalationEffort: process.env.OMNIMATH_ESCALATION_REASONING_EFFORT,
  };
  const calls = [];
  Object.assign(process.env, {
    OMNIMATH_ESCALATION_MODEL: "gpt-5.6-sol",
    OMNIMATH_SOLVER_REASONING_EFFORT: "medium",
    OMNIMATH_ESCALATION_REASONING_EFFORT: "high",
  });
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ model: payload.model, reasoning: payload.reasoning?.effort || null });
    return calls.length === 1
      ? failed({ code: "model_not_capable", model: payload.model })
      : completed(fixture(), { model: payload.model, id: "resp_same_model_high" });
  };
  const recorder = new ResponseRecorder();
  try {
    await handleExplainRequest(request("same-model-high"), recorder);
  } finally {
    process.env.OMNIMATH_ESCALATION_MODEL = prior.model;
    if (prior.solverEffort === undefined) delete process.env.OMNIMATH_SOLVER_REASONING_EFFORT;
    else process.env.OMNIMATH_SOLVER_REASONING_EFFORT = prior.solverEffort;
    if (prior.escalationEffort === undefined) delete process.env.OMNIMATH_ESCALATION_REASONING_EFFORT;
    else process.env.OMNIMATH_ESCALATION_REASONING_EFFORT = prior.escalationEffort;
  }

  assert.deepEqual(calls, [
    { model: "gpt-5.6-sol", reasoning: "medium" },
    { model: "gpt-5.6-sol", reasoning: "high" },
  ]);
  assert.equal(eventsFrom(recorder).at(-1).type, "solve_completed");
  assert.equal(eventsFrom(recorder).at(-1).effectiveModel, "gpt-5.6-sol");
});

test("progressive escalation suppresses an exact duplicate effective configuration", async () => {
  const names = [
    "OMNIMATH_ESCALATION_MODEL",
    "OMNIMATH_SOLVER_REASONING_EFFORT",
    "OMNIMATH_ESCALATION_REASONING_EFFORT",
    "OMNIMATH_OPENAI_SOLVER_TIMEOUT_MS",
    "OMNIMATH_OPENAI_ESCALATION_TIMEOUT_MS",
    "OMNIMATH_SOLVER_MAX_OUTPUT_TOKENS",
    "OMNIMATH_ESCALATION_MAX_OUTPUT_TOKENS",
  ];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    OMNIMATH_ESCALATION_MODEL: "gpt-5.6-sol",
    OMNIMATH_SOLVER_REASONING_EFFORT: "high",
    OMNIMATH_ESCALATION_REASONING_EFFORT: "high",
    OMNIMATH_OPENAI_SOLVER_TIMEOUT_MS: "90000",
    OMNIMATH_OPENAI_ESCALATION_TIMEOUT_MS: "90000",
    OMNIMATH_SOLVER_MAX_OUTPUT_TOKENS: "6500",
    OMNIMATH_ESCALATION_MAX_OUTPUT_TOKENS: "6500",
  });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const payload = JSON.parse(options.body);
    return failed({ code: "model_not_capable", model: payload.model });
  };
  const recorder = new ResponseRecorder();
  try {
    await handleExplainRequest(request("duplicate-escalation"), recorder);
  } finally {
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  }

  assert.equal(calls, 1);
  assert.deepEqual(types(recorder), ["solve_started", "solve_failed"]);
  assert.equal(eventsFrom(recorder).at(-1).recoveryDecision, "fail");
});

test("repeated pre-prefix failure stops after a bounded number of calls", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return failed(); };
  const recorder = new ResponseRecorder();
  await handleExplainRequest(request("repeated"), recorder);
  assert.ok(calls > 1 && calls <= 4, `unbounded provider calls: ${calls}`);
  assert.deepEqual(types(recorder), ["solve_started", "solve_failed"]);
  assert.equal(eventsFrom(recorder)[1].reason?.length > 0, true);
});

test("cancellation while the recovery provider is pending prevents Step 1 and further calls", async () => {
  const recorder = new ResponseRecorder();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    if (calls === 1) return failed();
    recorder.emit("close");
    return {
      ok: true, status: 200,
      body: new ReadableStream({
        start(controller) {
          options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
        },
      }),
    };
  };
  await handleExplainRequest(request("cancel-retry"), recorder);
  assert.equal(calls, 2);
  assert.equal(eventsFrom(recorder).some((event) => event.type === "step_completed"), false);
  assert.equal(eventsFrom(recorder).some((event) => event.type === "solve_completed"), false);
});

test("failure after authoritative Step 1 never starts replacement provider work", async () => {
  const text = JSON.stringify(fixture());
  const split = text.indexOf('"id":"answer"');
  let calls = 0;
  let terminalTelemetry = null;
  const originalConsoleWarn = console.warn;
  console.warn = (message, ...rest) => {
    const marker = "[omnimath:progressive-terminal] ";
    if (String(message).startsWith(marker)) {
      terminalTelemetry = JSON.parse(String(message).slice(marker.length));
    }
    originalConsoleWarn(message, ...rest);
  };
  globalThis.fetch = async () => {
    calls += 1;
    return stream([
      frame("response.created", { response: { id: "resp_partial", model: "gpt-5.6-sol" } }),
      frame("response.output_text.delta", { delta: text.slice(0, split + 8) }),
      frame("response.failed", { response: { id: "resp_partial", status: "failed", error: { code: "server_error" } } }),
    ]);
  };
  const recorder = new ResponseRecorder();
  try {
    await handleExplainRequest(request("post-prefix"), recorder);
  } finally {
    console.warn = originalConsoleWarn;
  }
  assert.equal(calls, 1);
  assert.deepEqual(types(recorder), ["solve_started", "solution_metadata", "step_completed", "solve_failed"]);
  assert.equal(eventsFrom(recorder)[2].step.id, "subtract");
  assert.equal(terminalTelemetry.partialPrefixFailure, true);
  assert.equal(terminalTelemetry.finalAuthoritativeModel, "gpt-5.6-sol");
  assert.equal(terminalTelemetry.aggregateUsage.usageComplete, false);
  assert.equal(terminalTelemetry.aggregateUsage.totalTokens, null);
  assert.equal(terminalTelemetry.aggregateUsage.reportedTotalTokens, null);
});

test("rate limit, auth failure, and bad request do not start recovery", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return httpError(429, "insufficient_quota"); };
  const limited = new ResponseRecorder();
  await handleExplainRequest(request("quota"), limited);
  assert.equal(calls, 1);
  assert.deepEqual(types(limited), ["solve_started", "solve_failed"]);

  const unauthenticated = request("auth");
  unauthenticated.headers.authorization = "Bearer invalid";
  const authResponse = new ResponseRecorder();
  const previousRuntime = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await handleExplainRequest(unauthenticated, authResponse);
  } finally {
    process.env.NODE_ENV = previousRuntime;
  }
  assert.equal(authResponse.statusCode, 401);
  assert.equal(calls, 1);

  const invalid = request("invalid");
  invalid.body.problem = "";
  const badResponse = new ResponseRecorder();
  await handleExplainRequest(invalid, badResponse);
  assert.equal(badResponse.statusCode, 400);
  assert.equal(calls, 1);
});

test("pre-prefix failure classification covers every recovery decision input", () => {
  const cases = [
    [{ code: "AI_SERVICE_UNAVAILABLE", networkCauseCode: "ECONNRESET" }, "transient_provider_network_error"],
    [{ responseFailureType: "error", providerCode: "server_error" }, "transient_provider_network_error"],
    [{ responseFailureType: "request_timeout" }, "request_timeout"],
    [{ code: "AI_RESPONSE_INVALID" }, "malformed_structured_output"],
    [{ code: "PROGRESSIVE_FRAME_INVALID" }, "parser_framing_failure"],
    [{ code: "PROGRESSIVE_STEP_REJECTED" }, "strict_step_validation_failure"],
    [{ responseFailureType: "truncated" }, "truncated_output"],
    [{ providerCode: "refusal" }, "refusal"],
    [{ responseFailureType: "empty_response" }, "empty_response"],
    [{ responseFailureType: "missing_response_body" }, "unsupported_stream_behavior"],
    [{ providerStatus: 429, providerCode: "rate_limit_exceeded" }, "usage_rate_limit_error"],
    [{ providerStatus: 401, providerCode: "invalid_api_key" }, "authentication_configuration_error"],
    [{ code: "SERVER_CONFIG_ERROR" }, "authentication_configuration_error"],
    [{ providerStatus: 400 }, "bad_request"],
    [{ providerCode: "model_not_capable" }, "model_capability_failure"],
    [{ name: "AbortError" }, "user_cancellation"],
    [{ responseFailureType: "interactive_deadline_exceeded" }, "total_solve_deadline"],
  ];
  for (const [error, expected] of cases) {
    assert.equal(classifyProgressiveFailure(error), expected, JSON.stringify(error));
  }
  assert.equal(classifyProgressiveFailure({}, { cancelled: true }), "user_cancellation");
  assert.equal(classifyProgressiveFailure({}, { disconnected: true }), "user_cancellation");
});

test("policy forbids recovery after prefix and for cancellation, deadline, auth, usage, bad request, or refusal", () => {
  const eligible = ["transient_provider_network_error", "request_timeout", "truncated_output",
    "malformed_structured_output", "parser_framing_failure", "strict_step_validation_failure", "model_capability_failure"];
  for (const classification of eligible) {
    const decision = decideProgressiveRecovery({
      classification, authoritativePrefixPublished: true, retryAttempted: false,
      repairAttempted: false, escalationAttempted: false, repairCandidateAvailable: true,
      escalationModelAvailable: true, deadlineRemaining: true, providerAttemptCount: 1,
    });
    assert.equal(decision.action, "fail", classification);
    assert.equal(decision.reason, "authoritative_prefix_published");
  }
  for (const classification of ["user_cancellation", "total_solve_deadline", "authentication_configuration_error",
    "usage_rate_limit_error", "bad_request", "refusal"]) {
    const decision = decideProgressiveRecovery({
      classification, authoritativePrefixPublished: false, retryAttempted: false,
      repairAttempted: false, escalationAttempted: false, repairCandidateAvailable: true,
      escalationModelAvailable: true, deadlineRemaining: true, providerAttemptCount: 1,
    });
    assert.equal(decision.action, "fail", classification);
  }
  assert.equal(decideProgressiveRecovery({
    classification: "transient_provider_network_error", authoritativePrefixPublished: false,
    retryAttempted: false, repairAttempted: false, escalationAttempted: false,
    repairCandidateAvailable: false, escalationModelAvailable: true,
    deadlineRemaining: false, providerAttemptCount: 1,
  }).action, "fail");
});
