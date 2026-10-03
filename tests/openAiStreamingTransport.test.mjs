import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { streamFollowupAnswer, streamMathExplanation } from "../server/openai.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENAI_API_KEY;
const originalRetry = process.env.OPENAI_RETRY_BASE_DELAY_MS;

beforeEach(() => {
  process.env.OPENAI_API_KEY = "offline-stream-transport-fixture";
  process.env.OPENAI_RETRY_BASE_DELAY_MS = "0";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  if (originalRetry === undefined) delete process.env.OPENAI_RETRY_BASE_DELAY_MS;
  else process.env.OPENAI_RETRY_BASE_DELAY_MS = originalRetry;
});

function frame(type, body = {}) {
  return `event: ${type}\r\ndata: ${JSON.stringify({ type, ...body })}\r\n\r\n`;
}

function streamResponse(chunks) {
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

test("streamed Responses SSE handles fragmented and coalesced frames with terminal usage", async () => {
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    const content = [
      frame("response.created", { response: { id: "resp_test", model: payload.model } }),
      frame("response.output_text.delta", { delta: '{"steps":[' }),
      frame("response.output_text.delta", { delta: '{"latex":"x=2"}]}' }),
      frame("response.completed", {
        response: { id: "resp_test", model: payload.model, status: "completed", usage: {
          input_tokens: 7, output_tokens: 9, total_tokens: 16,
        } },
      }),
    ].join("");
    return streamResponse([content.slice(0, 21), content.slice(21, 47), content.slice(47, 93), content.slice(93)]);
  };
  const deltas = [];
  const events = [];
  const result = await streamMathExplanation({
    prompt: "Solve x+1=3", originalProblem: "x+1=3", debugContext: { requestId: "req_test" },
    onTextDelta: (delta) => deltas.push(delta),
    onProviderEvent: (event) => events.push(event),
  });
  assert.equal(payload.stream, true);
  assert.equal(payload.text.format.strict, true);
  assert.equal(payload.model, result.model);
  assert.equal(result.responseId, "resp_test");
  assert.equal(result.outputText, '{"steps":[{"latex":"x=2"}]}');
  assert.deepEqual(deltas, ['{"steps":[', '{"latex":"x=2"}]}']);
  assert.deepEqual(events.map((event) => event.type), [
    "response.created", "response.output_text.delta", "response.output_text.delta", "response.completed",
  ]);
  assert.equal(result.usage.total_tokens, 16);
  assert.equal(result.usage._omni_model_usage[0].model, result.model);
  assert.equal(result.providerCallCount, 1);
  assert.equal(result.retryCount, 0);
  assert.ok(result.firstProviderEventMs >= 0);
});

test("provider failure after text preserves usage and never retries", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return streamResponse([
      frame("response.output_text.delta", { delta: "partial" }),
      frame("response.failed", { response: {
        id: "resp_failed", status: "failed", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        error: { code: "provider_failure" },
      } }),
    ]);
  };
  const deltas = [];
  await assert.rejects(
    streamMathExplanation({ prompt: "test", onTextDelta: (delta) => deltas.push(delta) }),
    (error) => {
      assert.equal(error._aiUsage.total_tokens, 5);
      assert.equal(error._aiCallCount, 1);
      assert.equal(error.providerCode, "provider_failure");
      return true;
    },
  );
  assert.deepEqual(deltas, ["partial"]);
  assert.equal(calls, 1);
});

test("a broken stream after bytes cannot start a second provider call", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return streamResponse([frame("response.output_text.delta", { delta: "unfinished" })]);
  };
  await assert.rejects(streamMathExplanation({ prompt: "test" }), { code: "AI_SERVICE_ERROR" });
  assert.equal(calls, 1);
});

test("transient connection failure may retry before provider bytes", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    return streamResponse([frame("response.completed", {
      response: { id: "resp_retry", status: "completed", usage: { total_tokens: 2 } },
    })]);
  };
  const result = await streamMathExplanation({ prompt: "test" });
  assert.equal(result.responseId, "resp_retry");
  assert.equal(result.retryCount, 1);
  assert.equal(calls, 2);
});

test("follow-up streaming caps pre-byte transient transport failures at two calls", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
  };
  await assert.rejects(streamFollowupAnswer({
    prompt: "Why does this step follow?",
    scope: "lens",
  }), { code: "AI_SERVICE_UNAVAILABLE" });
  assert.equal(calls, 2);
});

test("malformed provider event after bytes fails without replay", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return streamResponse(["event: response.output_text.delta\ndata: {bad json}\n\n"]);
  };
  await assert.rejects(streamMathExplanation({ prompt: "test" }), { code: "AI_RESPONSE_INVALID" });
  assert.equal(calls, 1);
});

test("late provider output after completion cannot change the attempt", async () => {
  globalThis.fetch = async () => streamResponse([
    frame("response.completed", { response: { id: "resp_done", status: "completed" } })
      + frame("response.output_text.delta", { delta: "late" }),
  ]);
  await assert.rejects(streamMathExplanation({ prompt: "test" }), { providerCode: "event_after_terminal" });
});

test("client cancellation aborts the provider stream and does not retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode(
            frame("response.output_text.delta", { delta: "prefix" })
              + frame("response.completed", { response: { status: "completed" } }),
          ));
          options.signal.addEventListener("abort", () => stream.error(options.signal.reason), { once: true });
        },
      }),
    };
  };
  const deltas = [];
  await assert.rejects(streamMathExplanation({
    prompt: "test", signal: controller.signal,
    onTextDelta(delta) { deltas.push(delta); controller.abort(new DOMException("Cancelled", "AbortError")); },
  }), (error) => error.name === "AbortError");
  assert.deepEqual(deltas, ["prefix"]);
  assert.equal(calls, 1);
});

test("overall deadline times out an idle provider stream", async () => {
  let calls = 0;
  const timeoutLogs = [];
  const originalConsoleInfo = console.info;
  console.info = (...args) => {
    if (args[0] === "[omnimath:openai-timeout]") timeoutLogs.push(args[1]);
    originalConsoleInfo(...args);
  };
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(stream) {
          options.signal.addEventListener("abort", () => stream.error(options.signal.reason), { once: true });
        },
      }),
    };
  };
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(streamMathExplanation({
      prompt: "test", debugContext: { solveDeadlineAt: Date.now() + 30 },
    }), (error) => error.responseFailureType === "request_timeout" && error._aiCallCount === 1);
  } finally {
    clearTimeout(keepAlive);
    console.info = originalConsoleInfo;
  }
  assert.equal(calls, 1);
  assert.equal(timeoutLogs.length, 1);
  assert.equal(timeoutLogs[0].configuredRoleTimeoutMs, 90000);
  assert.ok(timeoutLogs[0].remainingLogicalBudgetMs > 0);
  assert.ok(timeoutLogs[0].remainingLogicalBudgetMs <= 30);
  assert.equal(timeoutLogs[0].effectiveAttemptTimeoutMs, timeoutLogs[0].remainingAttemptBudgetMs);
  assert.ok(timeoutLogs[0].effectiveAttemptTimeoutMs < timeoutLogs[0].remainingLogicalBudgetMs);
  assert.equal(timeoutLogs[0].budgetLimitReason, "primary_stage_budget");
  assert.equal(timeoutLogs[0].timeoutMs, timeoutLogs[0].effectiveAttemptTimeoutMs);
});

test("overall deadline also interrupts a provider body reader that ignores the fetch abort signal", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({ start() { /* intentionally never responds to abort */ } }),
    };
  };
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(streamMathExplanation({
      prompt: "test", debugContext: { solveDeadlineAt: Date.now() + 30 },
    }), (error) => error.responseFailureType === "request_timeout" && error._aiCallCount === 1);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(calls, 1);
});
