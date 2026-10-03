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

function providerResponse({ outputText, status = "completed", model = "gpt-5.6-sol-2026-09-01", output, incompleteDetails } = {}) {
  const body = {
    id: `resp_${Math.random().toString(36).slice(2)}`,
    status,
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  };
  if (model !== undefined) body.model = model;
  if (outputText !== undefined) body.output_text = outputText;
  if (output !== undefined) body.output = output;
  if (incompleteDetails !== undefined) body.incomplete_details = incompleteDetails;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function validSolveOutput(problem) {
  return JSON.stringify({
    title: "Solve the equation",
    problemLatex: problem,
    steps: [
      {
        id: "isolate",
        heading: "Isolate the variable",
        latex: "3x=18",
        reasoning: "Subtract seven from both sides.",
        anchors: [],
      },
      {
        id: "answer",
        heading: "Final answer",
        latex: "x=6",
        reasoning: "Divide by three.",
        anchors: [],
      },
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

async function solve(label, problem = `Solve 3x+7=25. Case ${label}.`, requestLabel = label) {
  const req = {
    method: "POST",
    url: "/api/explain",
    headers: { "content-type": "application/json", host: "localhost:8787" },
    socket: { remoteAddress: `127.12.0.${Math.floor(Math.random() * 200) + 1}` },
    body: { problem, reference: label, debugRequestId: `ordinary-recovery-${requestLabel}` },
  };
  const res = recorder();
  await handleExplainRequest(req, res);
  return { problem, res };
}

before(async () => {
  storeDir = join(tmpdir(), `omnimath-ordinary-recovery-${Date.now()}-${Math.random()}`);
  await mkdir(storeDir, { recursive: true });
  Object.assign(process.env, {
    NODE_ENV: "test",
    OPENAI_API_KEY: "offline-ordinary-recovery",
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
  });
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CLERK_JWT_KEY;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  logs = [];
  console.info = (...args) => logs.push(args);
  console.warn = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  ({ handleExplainRequest } = await import(`../server/app.js?ordinary-recovery-${Date.now()}-${Math.random()}`));
});

after(async () => {
  globalThis.fetch = originalFetch;
  console.info = originalInfo;
  console.warn = originalWarn;
  console.error = originalError;
  process.env = originalEnv;
  await rm(storeDir, { recursive: true, force: true });
});

for (const scenario of [
  {
    label: "malformed",
    failure: () => providerResponse({ outputText: '{"title":}' }),
  },
  {
    label: "empty",
    failure: () => providerResponse({ outputText: "", output: [] }),
  },
  {
    label: "truncated",
    failure: () => providerResponse({
      status: "incomplete",
      output: [],
      incompleteDetails: { reason: "max_output_tokens" },
    }),
  },
  {
    label: "schema-invalid",
    failure: () => providerResponse({ outputText: JSON.stringify({ title: "Missing required fields" }) }),
  },
]) {
  test(`${scenario.label} full and compact output reach one bounded high-reasoning escalation`, async () => {
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      calls.push(payload);
      return calls.length < 3
        ? scenario.failure()
        : providerResponse({ outputText: validSolveOutput(`3x+7=25`) });
    };
    const { res } = await solve(scenario.label);

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().finalAnswerLatex, "x=6");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.model), [
      "gpt-5.6-sol",
      "gpt-5.6-sol",
      "gpt-5.6-sol",
    ]);
    assert.deepEqual(calls.map((call) => call.reasoning?.effort || null), ["medium", "medium", "high"]);
    assert.deepEqual(calls.map((call) => call.text.format.name), [
      "math_fast_solve",
      "math_compact_solve",
      "math_fast_solve",
    ]);

    const requestId = `ordinary-recovery-${scenario.label}`;
    const recovery = logs
      .filter(([marker, details]) => marker === "[omnimath:solve-recovery]" && details?.requestId === requestId)
      .map(([, details]) => details);
    assert.equal(recovery.some((entry) => entry.event === "recovery_selected"
      && entry.priorRouteAttemptId === `${requestId}:route:1`
      && entry.routeAttemptId === `${requestId}:route:2`), true);
    const selected = recovery.find((entry) => entry.event === "candidate_selected");
    assert.equal(selected.routeAttemptId, `${requestId}:route:2`);
    assert.equal(selected.candidateId, `${requestId}:route:2:candidate:full`);

    const aiRequest = logs.find(([marker, details]) => marker === "[omnimath:ai-request]"
      && details?.requestId === requestId)?.[1];
    assert.equal(aiRequest.attemptId, `${requestId}:route:2:generation:full`);
    assert.equal(aiRequest.routeAttemptId, `${requestId}:route:2`);
    assert.equal(aiRequest.routeAttemptIndex, 2);
    assert.equal(aiRequest.candidateId, `${requestId}:route:2:candidate:full`);
    assert.equal(aiRequest.providerTransportAttempt, 1);
    assert.equal(aiRequest.providerTransportAttempts, 1);
    assert.equal(aiRequest.requestedModel, "gpt-5.6-sol");
    assert.equal(aiRequest.effectiveModel, "gpt-5.6-sol");
    assert.equal(aiRequest.providerModel, "gpt-5.6-sol-2026-09-01");
    assert.equal(aiRequest.accountingModel, "gpt-5.6-sol");
    assert.equal(aiRequest.reasoningEffort, "high");
  });
}

test("provider refusal is explicit and does not start semantic recovery", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return providerResponse({
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "The request was declined." }],
      }],
    });
  };
  const { res } = await solve("refusal");

  assert.equal(res.statusCode, 502);
  assert.equal(res.json().code, "AI_REQUEST_REFUSED");
  assert.equal(calls, 1);
  const failure = logs
    .filter(([marker, details]) => marker === "[omnimath:solve-recovery]"
      && details?.requestId === "ordinary-recovery-refusal")
    .map(([, details]) => details)
    .find((entry) => entry.event === "attempt_failed");
  assert.equal(failure.classification, "refusal");
  assert.equal(failure.recoveryDecision, "fail");
  assert.equal(failure.nextRouteAttemptId, null);
});

test("unsupported prose input remains inconclusive without assurance recovery", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const wrong = JSON.parse(validSolveOutput("3x+7=25"));
    wrong.steps[1].latex = "x=7";
    wrong.finalAnswerLatex = "x=7";
    wrong.numericCheck = "Provider claims the result is correct.";
    return providerResponse({ outputText: JSON.stringify(wrong) });
  };
  const { res } = await solve("evidence-only");

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(calls, 1);
  assert.equal(res.json().finalAnswerLatex, "x=7");
  assert.equal(res.json().candidateAcceptance.mode, "bounded_assurance");
  assert.equal(res.json().assurance.status, "inconclusive");
  assert.equal(res.json().candidateAcceptance.accepted, true);
  const selected = logs
    .filter(([marker, details]) => marker === "[omnimath:solve-recovery]"
      && details?.requestId === "ordinary-recovery-evidence-only")
    .map(([, details]) => details)
    .find((entry) => entry.event === "candidate_selected");
  assert.equal(selected.verificationPolicy, "bounded_mathematical_assurance_v1");
});

function algebraOutput(answer) {
  const value = JSON.parse(validSolveOutput("x^2=4"));
  value.steps[0].latex = "x^2=4";
  value.steps[1].latex = answer;
  value.finalAnswerLatex = answer;
  value.numericCheck = "";
  return JSON.stringify(value);
}

test("supported contradiction uses one shared high-reasoning route and keeps candidate history", async () => {
  let calls = 0;
  globalThis.fetch = async () => providerResponse({ outputText: algebraOutput(++calls === 1 ? "x=3" : "x=2") });
  const { res } = await solve("assurance-corrected", "x^2=4");
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(calls, 2);
  const result = res.json();
  assert.equal(result.finalAnswerLatex, "x=2");
  assert.equal(result.assurance.status, "supported_checks_passed");
  assert.equal(result.assurance.recoveryAttempted, true);
  assert.deepEqual(result.assurance.history.map((entry) => entry.status),
    ["contradiction_detected", "supported_checks_passed"]);
  assert.notEqual(result.assurance.history[0].candidateId, result.assurance.history[1].candidateId);
  assert.equal(result.assurance.routeAttemptId, "ordinary-recovery-assurance-corrected:route:2");
  const decision = logs.filter(([marker, details]) => marker === "[omnimath:solve-recovery]"
    && details?.requestId === "ordinary-recovery-assurance-corrected")
    .map(([, details]) => details).find((entry) => entry.event === "assurance_decision");
  assert.equal(decision.recoveryReason, "supported_mathematical_contradiction");
  const checkEvents = logs.filter(([marker, details]) => marker === "[omnimath:solve-recovery]"
    && details?.requestId === "ordinary-recovery-assurance-corrected"
    && details?.event === "verification_check").map(([, details]) => details);
  assert.ok(checkEvents.some((entry) => entry.candidateId === result.assurance.history[0].candidateId
    && entry.outcome === "contradiction" && entry.verificationAttemptId));
  assert.ok(checkEvents.some((entry) => entry.candidateId === result.assurance.history[1].candidateId
    && entry.outcome === "passed" && entry.verificationAttemptId));
  const cached = await solve("assurance-corrected", "x^2=4", "assurance-cache-hit");
  assert.equal(cached.res.statusCode, 200);
  assert.equal(calls, 2);
  assert.equal(cached.res.json().requestId, "ordinary-recovery-assurance-cache-hit");
  assert.equal(cached.res.json().assurance.candidateId, result.assurance.candidateId);
  assert.deepEqual(cached.res.json().assurance.history, result.assurance.history);
});

test("a repeated supported contradiction stops and retains the earlier candidate", async () => {
  let calls = 0;
  globalThis.fetch = async () => providerResponse({ outputText: algebraOutput(++calls === 1 ? "x=3" : "x=5") });
  const { res } = await solve("assurance-repeated", "x^2=4");
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(calls, 2);
  const result = res.json();
  assert.equal(result.finalAnswerLatex, "x=3");
  assert.equal(result.assurance.status, "contradiction_detected");
  assert.equal(result.assurance.unresolvedContradiction, true);
  assert.equal(result.candidateAcceptance.presentationAction, "present_unresolved");
  assert.deepEqual(result.assurance.history.map((entry) => entry.status),
    ["contradiction_detected", "contradiction_detected"]);
  const cached = await solve("assurance-repeated", "x^2=4", "assurance-repeated-cache-hit");
  assert.equal(cached.res.statusCode, 200);
  assert.equal(calls, 2);
  assert.equal(cached.res.json().assurance.candidateId, result.assurance.candidateId);
  assert.deepEqual(cached.res.json().assurance.history, result.assurance.history);
  assert.deepEqual(cached.res.json().verification, result.verification);
  assert.equal(cached.res.json().candidateAcceptance.presentationAction, "present_unresolved");
});


test("a dispatched hard manual solve returns a typed timeout with unreconciled usage", async () => {
  const previous = process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS;
  process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS = "250";
  let calls = 0;
  let dispatchedSignal;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    dispatchedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };
  // Keep Node alive while AbortSignal's unref'd timers drive this mocked fetch.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const { res } = await solve("hard-timeout", "Solve the partial differential equation with these boundary conditions. Case hard-timeout.");
    const body = res.json();
    assert.equal(res.statusCode, 504, res.body);
    assert.equal(body.code, "AI_SOLVE_TIMEOUT");
    assert.equal(body.failureClassification, "request_timeout");
    assert.equal(body.timeoutSource, "provider_attempt_timeout");
    assert.match(body.message, /time|budget/i);
    assert.equal(body.requestId, "ordinary-recovery-hard-timeout");
    assert.equal(calls, 1);
    assert.equal(dispatchedSignal.aborted, true);
    const settlement = body.usage.settlement;
    assert.equal(settlement.providerCalls, 1);
    assert.equal(settlement.providerDispatched, true);
    assert.equal(settlement.settlementReason, "failure");
    assert.equal(settlement.usageStatus, "unknown_due_to_abort");
    assert.equal(settlement.costStatus, "unreconciled");
    assert.equal(settlement.actualInputTokens, null);
    assert.equal(settlement.actualOutputTokens, null);
    assert.equal(settlement.actualCostMicros, null);
    assert.equal(settlement.releasedTokens, 0);
    assert.equal(settlement.providerAttempts.length, 1);
    const dispatch = settlement.providerAttempts[0];
    assert.equal(dispatch.requestId, body.requestId);
    assert.ok(dispatch.model);
    assert.ok(dispatch.dispatchAt);
    assert.ok(dispatch.abortAt);
    assert.equal(dispatch.timeoutSource, body.timeoutSource);
  } finally {
    clearTimeout(keepAlive);
    if (previous === undefined) delete process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS;
    else process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS = previous;
  }
});

test("insufficient compact/recovery time is explicitly skipped without a dispatch", async () => {
  const previous = process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS;
  process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS = "250";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return providerResponse({ outputText: '{"title":}' });
  };
  try {
    const { res } = await solve("no-recovery-budget");
    assert.ok(res.statusCode >= 400, res.body);
    assert.equal(calls, 1);
    const decision = logs.filter(([marker, details]) => marker === "[omnimath:solve-recovery]"
      && details?.requestId === "ordinary-recovery-no-recovery-budget")
      .map(([, details]) => details).find((entry) => entry.event === "attempt_failed");
    assert.equal(decision.recoveryDecision, "fail");
    assert.equal(decision.recoveryReason, "insufficient_recovery_budget");
    assert.equal(res.json().usage.settlement.providerCalls, 1);
    assert.equal(res.json().usage.settlement.usageStatus, "observed");
  } finally {
    if (previous === undefined) delete process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS;
    else process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS = previous;
  }
});
