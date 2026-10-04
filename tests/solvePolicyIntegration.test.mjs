import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import "./helpers/noExternalNetwork.mjs";
import { estimateModelCostUsd } from "../server/openaiModels.js";

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

function validSolveOutput(problem) {
  return JSON.stringify({
    title: "Mathematical solution",
    problemLatex: problem,
    steps: [
      { id: "work", heading: "Work", latex: "x=x", reasoning: "Apply the stated definitions and simplify.", anchors: [] },
      { id: "result", heading: "Result", latex: "x=x", reasoning: "This is the requested result.", anchors: [] },
    ],
    finalAnswerLatex: "x=x",
    numericCheck: "",
  });
}

function providerResponse(problem, model) {
  return new Response(JSON.stringify({
    id: `resp_${Date.now()}`,
    status: "completed",
    model,
    output_text: validSolveOutput(problem),
    usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function recorder() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    endCalls: 0,
    writableEnded: false,
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
    end(chunk = "") { this.endCalls += 1; this.body += chunk; this.writableEnded = true; },
    json() { return JSON.parse(this.body || "{}"); },
  };
}

function startSolve({ problem, requestId, signal = null }) {
  const req = {
    method: "POST",
    url: "/api/explain",
    headers: { "content-type": "application/json", host: "localhost:8787" },
    socket: { remoteAddress: "127.15.0.41" },
    body: { problem, debugRequestId: requestId },
    ...(signal ? { signal } : {}),
  };
  const res = recorder();
  return { done: handleExplainRequest(req, res), req, res };
}

function requestLogs(marker, requestId) {
  return logs.filter(([kind, details]) => kind === marker && details?.requestId === requestId)
    .map(([, details]) => details);
}

function expectedReservationCostMicros(telemetry, primaryModel, recoveryModel) {
  const recoveryInputOverheadTokens = 512;
  assert.equal((telemetry.estimatedInputTokens - recoveryInputOverheadTokens) % 2, 0);
  assert.equal(telemetry.estimatedMaxOutputTokens % 2, 0);
  const primaryInputTokens = (telemetry.estimatedInputTokens - recoveryInputOverheadTokens) / 2;
  const recoveryInputTokens = primaryInputTokens + recoveryInputOverheadTokens;
  const outputPerAttempt = telemetry.estimatedMaxOutputTokens / 2;
  return Math.ceil((
    estimateModelCostUsd(primaryModel, {
      input_tokens: primaryInputTokens,
      output_tokens: outputPerAttempt,
    })
      + estimateModelCostUsd(recoveryModel, {
        input_tokens: recoveryInputTokens,
        output_tokens: outputPerAttempt,
      })
  ) * 1_000_000);
}

before(async () => {
  storeDir = join(tmpdir(), `omnimath-solve-policy-${Date.now()}-${Math.random()}`);
  await mkdir(storeDir, { recursive: true });
  Object.assign(process.env, {
    NODE_ENV: "test",
    OPENAI_API_KEY: "offline-solve-policy",
    OMNIMATH_CANONICAL_SOLVE_MODEL: "gpt-5.6-sol",
    OMNIMATH_HARD_SOLVE_MODEL: "gpt-5.6-terra",
    OMNIMATH_ESCALATION_MODEL: "gpt-5.6-sol",
    OMNIMATH_REPAIR_MODEL: "gpt-5.6-sol",
    OMNIMATH_SOLVER_REASONING_EFFORT: "medium",
    OMNIMATH_HARD_SOLVE_REASONING_EFFORT: "high",
    OMNIMATH_ESCALATION_REASONING_EFFORT: "high",
    OMNIMATH_OPENAI_SOLVER_TIMEOUT_MS: "180000",
    OMNIMATH_OPENAI_HARD_SOLVE_TIMEOUT_MS: "180000",
    OMNIMATH_OPENAI_ESCALATION_TIMEOUT_MS: "180000",
    OPENAI_RETRY_BASE_DELAY_MS: "0",
    USAGE_LOCAL_STORE_PATH: join(storeDir, "usage.json"),
    AI_RATE_LIMIT_PER_MINUTE: "1000",
    AI_RATE_LIMIT_PER_HOUR: "1000",
    DAILY_AI_LIMIT: "1000",
    MONTHLY_AI_LIMIT: "1000",
    DAILY_TOKEN_LIMIT: "100000000",
    MONTHLY_TOKEN_LIMIT: "1000000000",
    DAILY_SPEND_LIMIT_USD: "10000",
    MONTHLY_SPEND_LIMIT_USD: "100000",
    OMNIMATH_DEV_DAILY_SPEND_LIMIT_USD: "10000",
    OMNIMATH_DEV_MONTHLY_SPEND_LIMIT_USD: "100000",
  });
  for (const name of [
    "VERCEL",
    "VERCEL_ENV",
    "OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS",
    "OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS",
    "OMNIMATH_SOLVE_SIMPLE_TOTAL_TIMEOUT_MS",
    "OMNIMATH_SOLVE_STANDARD_TOTAL_TIMEOUT_MS",
    "OMNIMATH_SOLVE_ADVANCED_TOTAL_TIMEOUT_MS",
    "OMNIMATH_SOLVE_ELITE_TOTAL_TIMEOUT_MS",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
    "DATABASE_URL",
    "POSTGRES_URL",
  ]) delete process.env[name];
  logs = [];
  console.info = (...args) => logs.push(args);
  console.warn = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  ({ handleExplainRequest } = await import(`../server/app.js?solve-policy-integration-${Date.now()}-${Math.random()}`));
});

after(async () => {
  globalThis.fetch = originalFetch;
  console.info = originalInfo;
  console.warn = originalWarn;
  console.error = originalError;
  process.env = originalEnv;
  await rm(storeDir, { recursive: true, force: true });
});

const policyCases = [
  {
    name: "small numeric matrix arithmetic uses the inexpensive simple policy",
    requestId: "policy-simple-matrix",
    problem: String.raw`Let A=\begin{bmatrix}1&2&0\\0&1&3\\2&0&1\end{bmatrix} and B=\begin{bmatrix}0&1&0\\1&0&1\\0&1&1\end{bmatrix}. Compute AB, A^2, A-2B, det(A), and A^{-1}.`,
    tier: "simple",
    reason: "small_numeric_matrix_computation",
    role: "solver",
    model: "gpt-5.6-sol",
    effort: "medium",
    output: 3_200,
    budget: [45_000, 35_000, 7_000, 3_000],
    recoveryModel: "gpt-5.6-sol",
  },
  {
    name: "advanced operator proof uses the hard-solve policy",
    requestId: "policy-advanced-operator",
    problem: "Prove that a linear operator T on a finite-dimensional vector space is diagonalizable if its characteristic polynomial splits into distinct roots.",
    tier: "advanced",
    reason: "advanced_matrix_or_operator_proof",
    role: "hardSolve",
    model: "gpt-5.6-terra",
    effort: "high",
    output: 12_000,
    budget: [150_000, 110_000, 35_000, 5_000],
    recoveryModel: "gpt-5.6-sol",
  },
  {
    name: "elite variational calculus receives the full local hard profile",
    requestId: "policy-elite-variational",
    problem: "Prove existence of a minimizer for this nonlinear variational functional on a Sobolev space, derive its first variation and Euler-Lagrange equation, and justify the weak boundary conditions.",
    tier: "elite",
    reason: "deep_variational_calculus",
    role: "hardSolve",
    model: "gpt-5.6-terra",
    effort: "high",
    output: 24_000,
    budget: [240_000, 180_000, 50_000, 10_000],
    recoveryModel: "gpt-5.6-sol",
  },
  {
    name: "ordinary undergraduate integral preserves the standard profile",
    requestId: "policy-standard-integral",
    problem: "Evaluate the undergraduate integral \\int_0^1 x^2 e^x \\, dx using integration by parts.",
    tier: "standard",
    reason: "one_dimensional_integral",
    role: "solver",
    model: "gpt-5.6-sol",
    effort: "medium",
    output: 6_500,
    budget: [90_000, 65_500, 22_500, 2_000],
    recoveryModel: "gpt-5.6-sol",
  },
];

for (const scenario of policyCases) {
  test(scenario.name, async () => {
    logs.length = 0;
    let payload;
    globalThis.fetch = async (_url, options) => {
      payload = JSON.parse(options.body);
      return providerResponse(scenario.problem, payload.model);
    };

    const started = startSolve(scenario);
    await started.done;

    assert.equal(started.res.statusCode, 200, started.res.body);
    const routing = requestLogs("[omnimath:solve-routing]", scenario.requestId).at(-1);
    const reservation = requestLogs("[omnimath:solve-reservation]", scenario.requestId).at(-1);
    assert.ok(routing);
    assert.ok(reservation);
    assert.equal(routing.difficultyTier, scenario.tier);
    assert.equal(routing.routingReason, scenario.reason);
    assert.equal(routing.selectedModelRole, scenario.role);
    assert.equal(routing.selectedModel, scenario.model);
    assert.equal(routing.reasoningEffort, scenario.effort);
    assert.equal(routing.budgetProfile, scenario.tier);
    assert.deepEqual([
      routing.canonicalBudgetMs,
      routing.primaryBudgetMs,
      routing.recoveryBudgetMs,
      routing.responseReserveMs,
    ], scenario.budget);
    assert.equal(routing.maxOutputTokens, scenario.output);
    assert.equal(payload.model, scenario.model);
    assert.equal(payload.reasoning?.effort, scenario.effort);
    assert.equal(payload.max_output_tokens, scenario.output);
    assert.equal(reservation.estimatedMaxOutputTokens, scenario.output * 2);
    const expectedCostMicros = expectedReservationCostMicros(
      reservation,
      scenario.model,
      scenario.recoveryModel,
    );
    assert.equal(reservation.estimatedCostMicros, expectedCostMicros, JSON.stringify({
      estimatedInputTokens: reservation.estimatedInputTokens,
      estimatedMaxOutputTokens: reservation.estimatedMaxOutputTokens,
      primaryModel: scenario.model,
      recoveryModel: scenario.recoveryModel,
    }));
    const settlement = started.res.json().usage.settlement;
    assert.equal(settlement.reservedCostMicros, reservation.estimatedCostMicros);
    assert.equal(settlement.reservedTokens, reservation.estimatedInputTokens + reservation.estimatedMaxOutputTokens);
  });
}

test("elite timeout uses 180s primary and 50s recovery, then stops", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-01-01T00:00:00.000Z") });
  logs.length = 0;
  const requestId = "policy-elite-timeout";
  const problem = "Prove existence and regularity for a nonlinear variational functional on a Sobolev space, then derive the first variation and Euler-Lagrange equation.";
  const dispatched = [deferred(), deferred()];
  const payloads = [];
  let calls = 0;
  globalThis.fetch = (_url, options) => {
    const index = calls++;
    payloads.push(JSON.parse(options.body));
    dispatched[index]?.resolve();
    return new Promise((_, reject) => options.signal.addEventListener(
      "abort",
      () => reject(options.signal.reason),
      { once: true },
    ));
  };

  const started = startSolve({ problem, requestId });
  await dispatched[0].promise;
  t.mock.timers.tick(180_000);
  await dispatched[1].promise;
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(50_000);
  await started.done;

  assert.equal(started.res.statusCode, 504, started.res.body);
  assert.equal(started.res.json().code, "AI_SOLVE_TIMEOUT");
  assert.equal(calls, 2);
  assert.deepEqual(payloads.map((payload) => payload.model), ["gpt-5.6-terra", "gpt-5.6-terra"]);
  assert.deepEqual(payloads.map((payload) => payload.reasoning?.effort), ["high", "high"]);
  assert.deepEqual(payloads.map((payload) => payload.max_output_tokens), [24_000, 24_000]);
  const timeouts = requestLogs("[omnimath:openai-timeout]", requestId);
  assert.equal(timeouts.length, 2);
  assert.deepEqual(timeouts.map((entry) => entry.allocatedAttemptBudgetMs), [180_000, 50_000]);
  assert.deepEqual(timeouts.map((entry) => entry.budgetLimitReason), ["primary_stage_budget", "recovery_stage_budget"]);
  const dispatches = requestLogs("[omnimath:provider-dispatch]", requestId);
  assert.deepEqual(dispatches.map((entry) => entry.routeAttemptIndex), [1, 2]);
  const outcome = requestLogs("[omnimath:solve-policy-outcome]", requestId).at(-1);
  assert.equal(outcome.recoveryUsed, true);
  assert.equal(outcome.providerCalls, 2);
});

test("caller cancellation remains terminal before recovery", async () => {
  logs.length = 0;
  const requestId = "policy-caller-cancelled";
  const problem = "Prove existence for a nonlinear variational functional, derive its first variation and Euler-Lagrange equation, and justify weak convergence.";
  const dispatched = deferred();
  const controller = new AbortController();
  let calls = 0;
  let providerSignal;
  globalThis.fetch = (_url, options) => {
    calls += 1;
    providerSignal = options.signal;
    dispatched.resolve();
    return new Promise((_, reject) => options.signal.addEventListener(
      "abort",
      () => reject(options.signal.reason),
      { once: true },
    ));
  };

  const started = startSolve({ problem, requestId, signal: controller.signal });
  await dispatched.promise;
  controller.abort(new DOMException("Caller cancelled.", "AbortError"));
  await started.done;

  assert.equal(calls, 1);
  assert.equal(providerSignal.aborted, true);
  assert.equal(requestLogs("[omnimath:provider-dispatch]", requestId).length, 1);
  const recoveries = requestLogs("[omnimath:solve-recovery]", requestId)
    .filter((entry) => entry.event === "recovery_selected");
  assert.equal(recoveries.length, 0);
  const outcome = requestLogs("[omnimath:solve-policy-outcome]", requestId).at(-1);
  assert.equal(outcome.recoveryUsed, false);
  assert.equal(outcome.providerCalls, 1);
});
