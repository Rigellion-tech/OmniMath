import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import "./helpers/noExternalNetwork.mjs";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;
let handleExplainRequest;
let storeDir;
let logs;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function providerResponse(outputText) {
  return new Response(JSON.stringify({
    id: "resp_timer_recovery",
    status: "completed",
    model: "gpt-5.6-sol-2026-09-01",
    output_text: outputText,
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function validSolveOutput(problem) {
  return JSON.stringify({
    title: "Solve the equation",
    problemLatex: problem,
    steps: [
      { id: "isolate", heading: "Isolate the variable", latex: "3x=18", reasoning: "Subtract seven from both sides.", anchors: [] },
      { id: "answer", heading: "Final answer", latex: "x=6", reasoning: "Divide by three.", anchors: [] },
    ],
    finalAnswerLatex: "x=6",
    numericCheck: "3(6)+7=25",
  });
}

function recorder() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    endCalls: 0,
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
    end(chunk = "") { this.endCalls += 1; this.body += chunk; },
    json() { return JSON.parse(this.body || "{}"); },
  };
}

async function startSolve(requestId) {
  const problem = `Solve the partial differential equation with these boundary conditions. Case ${requestId}.`;
  const req = {
    method: "POST",
    url: "/api/explain",
    headers: { "content-type": "application/json", host: "localhost:8787" },
    socket: { remoteAddress: "127.12.0.41" },
    body: { problem, debugRequestId: requestId },
  };
  const res = recorder();
  const done = handleExplainRequest(req, res);
  return { done, problem, res };
}

before(async () => {
  storeDir = join(tmpdir(), `omnimath-provider-timeout-${Date.now()}-${Math.random()}`);
  await mkdir(storeDir, { recursive: true });
  Object.assign(process.env, {
    NODE_ENV: "test",
    OPENAI_API_KEY: "offline-provider-timeout",
    OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS: "90000",
    OMNIMATH_OPENAI_SOLVER_TIMEOUT_MS: "120000",
    OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS: "120000",
    OMNIMATH_ESCALATION_MODEL: "gpt-5.6-sol",
    OMNIMATH_SOLVER_REASONING_EFFORT: "medium",
    OMNIMATH_ESCALATION_REASONING_EFFORT: "high",
    OPENAI_RETRY_BASE_DELAY_MS: "0",
    USAGE_LOCAL_STORE_PATH: join(storeDir, "usage.json"),
    AI_RATE_LIMIT_PER_MINUTE: "1000",
    AI_RATE_LIMIT_PER_HOUR: "1000",
    DAILY_AI_LIMIT: "1000",
    MONTHLY_AI_LIMIT: "1000",
    DAILY_TOKEN_LIMIT: "10000000",
    MONTHLY_TOKEN_LIMIT: "100000000",
    DAILY_SPEND_LIMIT_USD: "1000",
    MONTHLY_SPEND_LIMIT_USD: "10000",
  });
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CLERK_JWT_KEY;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  logs = [];
  console.info = (...args) => logs.push(args);
  console.warn = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  ({ handleExplainRequest } = await import(`../server/app.js?provider-timeout-${Date.now()}-${Math.random()}`));
});

after(async () => {
  globalThis.fetch = originalFetch;
  console.info = originalInfo;
  console.warn = originalWarn;
  console.error = originalError;
  process.env = originalEnv;
  await rm(storeDir, { recursive: true, force: true });
});

function requestLogs(marker, requestId) {
  return logs.filter(([kind, details]) => kind === marker && details?.requestId === requestId)
    .map(([, details]) => details);
}

test("primary provider deadline aborts at 65.5 seconds and recovery uses its reserved 22.5 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-01-01T00:00:00.000Z") });
  const requestId = "provider-timeout-recovered";
  const dispatched = [deferred(), deferred()];
  const signals = [];
  let calls = 0;
  globalThis.fetch = (_url, options) => {
    const index = calls++;
    signals[index] = options.signal;
    dispatched[index]?.resolve();
    if (index === 0) {
      return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    }
    return Promise.resolve(providerResponse(validSolveOutput(`Solve the partial differential equation with these boundary conditions. Case ${requestId}.`)));
  };

  const started = await startSolve(requestId);
  await dispatched[0].promise;
  t.mock.timers.tick(65_500);
  await dispatched[1].promise;
  await started.done;

  assert.equal(started.res.statusCode, 200, started.res.body);
  assert.equal(started.res.endCalls, 1);
  assert.equal(calls, 2);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  const body = started.res.json();
  const settlement = body.usage.settlement;
  assert.equal(settlement.providerCalls, 2);
  assert.equal(settlement.usageStatus, "partially_observed");
  assert.equal(settlement.costStatus, "unreconciled");
  assert.equal(settlement.actualInputTokens, null);
  assert.equal(settlement.actualOutputTokens, null);
  assert.equal(settlement.actualTotalTokens, null);
  assert.equal(settlement.observedTotalTokens, 30);
  assert.deepEqual(settlement.providerAttempts.map((attempt) => attempt.routeAttemptIndex), [1, 2]);
  assert.deepEqual(settlement.providerAttempts.map((attempt) => attempt.usageStatus), ["unknown_due_to_abort", "observed"]);
  assert.ok(settlement.providerAttempts[0].abortAt);

  const dispatches = requestLogs("[omnimath:provider-dispatch]", requestId);
  assert.deepEqual(dispatches.map((entry) => entry.routeAttemptId), [`${requestId}:route:1`, `${requestId}:route:2`]);
  assert.deepEqual(dispatches.map((entry) => entry.routeAttemptIndex), [1, 2]);
  assert.equal(dispatches[0].model, dispatches[1].model);
  const timeouts = requestLogs("[omnimath:openai-timeout]", requestId);
  assert.equal(timeouts.length, 2);
  assert.equal(timeouts[0].solveBudgetStage, "primary");
  assert.equal(timeouts[0].budgetLimitReason, "primary_stage_budget");
  assert.ok(Math.abs(timeouts[0].allocatedAttemptBudgetMs - 65_500) < 5);
  assert.equal(timeouts[1].solveBudgetStage, "recovery");
  assert.equal(timeouts[1].budgetLimitReason, "recovery_stage_budget");
  assert.ok(Math.abs(timeouts[1].allocatedAttemptBudgetMs - 22_500) < 5);
});

test("a recovery provider deadline aborts at 22.5 seconds and returns one terminal timeout", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-01-01T00:00:00.000Z") });
  const requestId = "provider-timeout-recovery-failed";
  const dispatched = [deferred(), deferred()];
  const signals = [];
  let calls = 0;
  globalThis.fetch = (_url, options) => {
    const index = calls++;
    signals[index] = options.signal;
    dispatched[index]?.resolve();
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  };

  const started = await startSolve(requestId);
  await dispatched[0].promise;
  t.mock.timers.tick(65_500);
  await dispatched[1].promise;
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(22_500);
  await started.done;

  assert.equal(started.res.statusCode, 504, started.res.body);
  assert.equal(started.res.json().code, "AI_SOLVE_TIMEOUT");
  assert.equal(started.res.endCalls, 1);
  assert.equal(calls, 2);
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, true]);
  const settlement = started.res.json().usage.settlement;
  assert.equal(settlement.providerCalls, 2);
  assert.equal(settlement.costStatus, "unreconciled");
  assert.equal(settlement.actualTotalTokens, null);
  assert.deepEqual(settlement.providerAttempts.map((attempt) => attempt.usageStatus), ["unknown_due_to_abort", "unknown_due_to_abort"]);

  const dispatches = requestLogs("[omnimath:provider-dispatch]", requestId);
  assert.deepEqual(dispatches.map((entry) => entry.routeAttemptId), [`${requestId}:route:1`, `${requestId}:route:2`]);
  assert.equal(dispatches.length, 2);
  const timeouts = requestLogs("[omnimath:openai-timeout]", requestId);
  assert.equal(timeouts.length, 2);
  assert.deepEqual(timeouts.map((entry) => entry.budgetLimitReason), ["primary_stage_budget", "recovery_stage_budget"]);
  assert.ok(Math.abs(timeouts[0].allocatedAttemptBudgetMs - 65_500) < 5);
  assert.ok(Math.abs(timeouts[1].allocatedAttemptBudgetMs - 22_500) < 5);
  const failures = requestLogs("[omnimath:solve-recovery]", requestId).filter((entry) => entry.event === "attempt_failed");
  assert.equal(failures.at(-1).recoveryDecision, "fail");
});
