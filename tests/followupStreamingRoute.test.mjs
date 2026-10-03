import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const originalEnv = Object.fromEntries([
  "NODE_ENV", "VERCEL", "OPENAI_API_KEY", "OPENAI_RESPONSES_URL",
  "OMNIMATH_PINNED_MODEL", "OMNIMATH_SOLVER_MODEL", "OPENAI_SOLVER_MODEL", "DATABASE_URL", "POSTGRES_URL",
  "CLERK_SECRET_KEY", "CLERK_JWT_KEY", "USAGE_LOCAL_STORE_PATH",
  "DAILY_AI_LIMIT", "MONTHLY_AI_LIMIT", "DAILY_TOKEN_LIMIT", "MONTHLY_TOKEN_LIMIT",
  "OPENAI_RETRY_BASE_DELAY_MS",
].map((key) => [key, process.env[key]]));

let fixtureDirectory;
let providerServer;
let appServer;
let providerOrigin;
let appOrigin;
let providerMode = "complete";
let providerCalls = 0;
let providerPayloads = [];
let releaseProvider = null;
let providerConnectionClosed = null;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function providerFrame(type, body = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
}

function snapshot(scope = "lens") {
  const workspace = scope === "workspace";
  return {
    version: 1,
    target: {
      semanticId: workspace ? "workspace:solution-a" : "step-1:x",
      targetId: workspace ? "workspace:solution-a" : "step-1:x",
      stepId: workspace ? "" : "step-1",
      sourceRange: workspace ? null : { start: 0, end: 1 },
      sourceText: workspace ? "Current solution" : "x",
      role: workspace ? "workspace" : "variable",
      type: workspace ? "workspace" : "identifier",
      parentExpression: workspace ? "" : "x+1=2",
      selectedNode: null,
      ancestors: [],
    },
    origin: {
      problemId: "problem-a",
      problemText: "Solve x+1=2",
      solutionRevision: "solution-a",
      stepIndex: workspace ? null : 0,
      stepId: workspace ? "" : "step-1",
      stepTitle: workspace ? "" : "Subtract one",
      currentStep: workspace ? null : { id: "step-1", math: "x=1", reasoning: "Subtract one." },
      branchId: "",
    },
    evidence: {
      steps: [{ index: 0, id: "step-1", math: "x=1", reasoning: "Subtract one." }],
      relevantInputs: ["x+1=2"],
      assumptions: [],
    },
    confidence: { kind: "explicit" },
  };
}

function requestBody({ requestId, scope = "lens" } = {}) {
  return {
    stream: true,
    scope,
    presentationDepth: "standard",
    requestId,
    conversationId: `${scope}-conversation-a`,
    targetRevision: "revision-a",
    provenanceSnapshot: snapshot(scope),
    question: scope === "workspace" ? "Summarize this solution." : "Why is this x here?",
    history: [],
  };
}

function createEventReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  return {
    async next() {
      while (true) {
        const boundary = pending.search(/\r?\n\r?\n/);
        if (boundary >= 0) {
          const match = /\r?\n\r?\n/.exec(pending.slice(boundary));
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + match[0].length);
          const data = frame.split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart()).join("\n");
          if (data) return JSON.parse(data);
        }
        const chunk = await reader.read();
        if (chunk.done) return null;
        pending += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  };
}

async function postFollowup(body, signal) {
  return fetch(`${appOrigin}/api/explain-followup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
}

before(async () => {
  fixtureDirectory = join(tmpdir(), `omnimath-followup-stream-${process.pid}-${Date.now()}`);
  await mkdir(fixtureDirectory, { recursive: true });
  process.env.NODE_ENV = "test";
  delete process.env.VERCEL;
  process.env.OPENAI_API_KEY = "offline-followup-stream-fixture";
  process.env.OMNIMATH_PINNED_MODEL = "gpt-4.1-mini";
  process.env.OMNIMATH_SOLVER_MODEL = "gpt-5.6-sol";
  process.env.OPENAI_SOLVER_MODEL = "gpt-5.6-sol";
  process.env.OPENAI_RETRY_BASE_DELAY_MS = "0";
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  process.env.CLERK_SECRET_KEY = "";
  process.env.CLERK_JWT_KEY = "";
  process.env.USAGE_LOCAL_STORE_PATH = join(fixtureDirectory, "usage.json");
  process.env.DAILY_AI_LIMIT = "1000";
  process.env.MONTHLY_AI_LIMIT = "1000";
  process.env.DAILY_TOKEN_LIMIT = "1000000";
  process.env.MONTHLY_TOKEN_LIMIT = "10000000";

  providerServer = http.createServer(async (req, res) => {
    providerCalls += 1;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    providerPayloads.push(JSON.parse(raw));
    if (providerMode === "drop") {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    const model = providerPayloads.at(-1).model;
    res.write(providerFrame("response.created", { response: { id: `response-${providerCalls}`, model } }));
    res.write(providerFrame("response.output_text.delta", { delta: "First " }));

    if (providerMode === "hold") {
      providerConnectionClosed = new Promise((resolve) => res.once("close", resolve));
      return;
    }
    if (providerMode === "fail") {
      res.end(providerFrame("response.failed", { response: {
        id: `response-${providerCalls}`,
        model,
        status: "failed",
        usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 },
        error: { code: "provider_failure" },
      } }));
      return;
    }
    if (providerMode === "deferred") {
      await new Promise((resolve) => { releaseProvider = resolve; });
    }
    res.write(providerFrame("response.output_text.delta", { delta: "answer." }));
    res.end(providerFrame("response.completed", { response: {
      id: `response-${providerCalls}`,
      model,
      status: "completed",
      usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
    } }));
  });
  providerOrigin = await listen(providerServer);
  process.env.OPENAI_RESPONSES_URL = `${providerOrigin}/v1/responses`;
  const { createServer } = await import(`../server/index.js?followup-stream-${Date.now()}`);
  appServer = createServer();
  appOrigin = await listen(appServer);
});

after(async () => {
  releaseProvider?.();
  await close(appServer);
  await close(providerServer);
  Object.entries(originalEnv).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  await rm(fixtureDirectory, { recursive: true, force: true });
});

test("follow-up SSE publishes a correlated provider delta before completion and rejects an active duplicate", async () => {
  providerMode = "deferred";
  releaseProvider = null;
  const body = requestBody({ requestId: "followup-stream-success" });
  const response = await postFollowup(body);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  const events = createEventReader(response);
  const generating = await events.next();
  const firstDelta = await events.next();
  assert.equal(generating.type, "generating");
  assert.deepEqual(
    [firstDelta.type, firstDelta.delta, firstDelta.requestId, firstDelta.conversationId, firstDelta.targetRevision],
    ["delta", "First ", body.requestId, body.conversationId, body.targetRevision],
  );
  assert.equal(releaseProvider instanceof Function, true, "provider completion remains gated after first client delta");
  assert.equal(providerPayloads.at(-1).model, "gpt-4.1-mini");
  assert.equal(providerPayloads.at(-1).stream, true);
  assert.equal(providerPayloads.at(-1).text, undefined);

  const duplicate = await postFollowup(body);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, "FOLLOWUP_STREAM_IN_PROGRESS");
  assert.equal(providerCalls, 1);

  releaseProvider();
  const secondDelta = await events.next();
  const complete = await events.next();
  assert.deepEqual([secondDelta.type, secondDelta.delta], ["delta", "answer."]);
  assert.equal(complete.type, "complete");
  assert.equal(complete.answer, "First answer.");
  assert.equal(complete.fallback, false);
  for (const event of [generating, firstDelta, secondDelta, complete]) {
    assert.equal(event.requestId, body.requestId);
    assert.equal(event.conversationId, body.conversationId);
    assert.equal(event.targetRevision, body.targetRevision);
  }
});

test("workspace stream retains solver routing with explicit workspace provenance", async () => {
  providerMode = "complete";
  const body = requestBody({ requestId: "followup-stream-workspace", scope: "workspace" });
  const response = await postFollowup(body);
  const events = createEventReader(response);
  let terminal;
  while ((terminal = await events.next()) && terminal.type !== "complete") { /* consume */ }
  assert.equal(terminal.type, "complete");
  assert.equal(terminal.scope, "workspace");
  assert.equal(providerPayloads.at(-1).model, "gpt-5.6-sol");
});

test("streaming requires the complete correlation tuple before provider work", async () => {
  providerMode = "complete";
  const callsBefore = providerCalls;
  const body = requestBody({ requestId: "followup-stream-missing-correlation" });
  delete body.targetRevision;
  const response = await postFollowup(body);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "BAD_INPUT");
  assert.equal(providerCalls, callsBefore);
});

test("failure after a published delta emits one partial error and never retries", async () => {
  providerMode = "fail";
  const callsBefore = providerCalls;
  const body = requestBody({ requestId: "followup-stream-partial-failure" });
  const response = await postFollowup(body);
  const events = createEventReader(response);
  const received = [];
  let event;
  while ((event = await events.next())) received.push(event);
  assert.deepEqual(received.map((item) => item.type), ["generating", "delta", "error"]);
  assert.equal(received.at(-1).partial, true);
  assert.equal(received.at(-1).status, "partial_error");
  for (const item of received) {
    assert.equal(item.requestId, body.requestId);
    assert.equal(item.conversationId, body.conversationId);
    assert.equal(item.targetRevision, body.targetRevision);
  }
  assert.equal(providerCalls - callsBefore, 1);
});

test("failure before provider bytes never exceeds the two-call follow-up cap", async () => {
  providerMode = "drop";
  const callsBefore = providerCalls;
  const body = requestBody({ requestId: "followup-stream-pre-output-failure" });
  const response = await postFollowup(body);
  const events = createEventReader(response);
  const received = [];
  let event;
  while ((event = await events.next())) received.push(event);
  assert.deepEqual(received.map((item) => item.type), ["generating", "delta", "complete"]);
  assert.equal(received.at(-1).fallback, true);
  assert.ok(providerCalls - callsBefore >= 1);
  assert.ok(providerCalls - callsBefore <= 2);
});

test("client disconnect aborts the provider stream without another provider call", async () => {
  providerMode = "hold";
  providerConnectionClosed = null;
  const callsBefore = providerCalls;
  const controller = new AbortController();
  const body = requestBody({ requestId: "followup-stream-cancel" });
  const response = await postFollowup(body, controller.signal);
  const events = createEventReader(response);
  assert.equal((await events.next()).type, "generating");
  assert.equal((await events.next()).type, "delta");
  controller.abort();
  await Promise.race([
    providerConnectionClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("provider connection did not close")), 2000)),
  ]);
  assert.equal(providerCalls - callsBefore, 1);
});
