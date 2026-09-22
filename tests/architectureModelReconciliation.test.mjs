import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import "./helpers/noExternalNetwork.mjs";

const fixtureKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

function signedSession() {
  const { privateKey, publicKey } = fixtureKeyPair;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", typ: "JWT", kid: "model-reconciliation" })}.${encode({
    sub: "user_model_reconciliation",
    sid: "sess_model_reconciliation",
    iss: "https://offline-test.clerk.accounts.dev",
    iat: now,
    nbf: now - 1,
    exp: now + 300,
  })}`;
  return {
    jwtKey: publicKey.export({ type: "spki", format: "pem" }),
    token: `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`,
  };
}

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

it("reproduces hover model attribution divergence without misrouting or mispricing", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const usagePath = join(tmpdir(), `omnimath-model-reconciliation-${Date.now()}-${Math.random()}.json`);
  t.after(async () => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    await rm(usagePath, { force: true });
  });

  for (const key of Object.keys(process.env)) {
    if (/^(?:OPENAI_|OMNIMATH_|CLERK_|DATABASE_|POSTGRES_|USAGE_|KV_|UPSTASH_|AI_|VITE_DEBUG_)/u.test(key)) {
      delete process.env[key];
    }
  }
  const session = signedSession();
  Object.assign(process.env, {
    NODE_ENV: "test",
    OPENAI_API_KEY: "offline-model-attribution-fixture",
    OMNIMATH_SOLVER_MODEL: "gpt-5.6-luna",
    OMNIMATH_HOVER_MODEL: "gpt-4.1-mini",
    OMNIMATH_MODEL_GPT_4_1_MINI_INPUT_COST_PER_1M: "1",
    OMNIMATH_MODEL_GPT_4_1_MINI_OUTPUT_COST_PER_1M: "2",
    CLERK_JWT_KEY: session.jwtKey,
    USAGE_LOCAL_STORE_PATH: usagePath,
    DAILY_AI_LIMIT: "1000",
    MONTHLY_AI_LIMIT: "1000",
    DAILY_TOKEN_LIMIT: "10000000",
    MONTHLY_TOKEN_LIMIT: "100000000",
    DAILY_SPEND_LIMIT_USD: "1000",
    MONTHLY_SPEND_LIMIT_USD: "1000",
    VITE_DEBUG_MATH_HOVER: "true",
  });

  const logs = [];
  t.mock.method(console, "info", (...args) => logs.push(args));
  t.mock.method(console, "warn", (...args) => logs.push(args));
  t.mock.method(console, "error", (...args) => logs.push(args));

  const providerRequests = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    providerRequests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      id: "resp_hover_model_reconciliation",
      status: "completed",
      model: "gpt-4.1-mini-2025-04-14",
      usage: {
        input_tokens: 1000,
        output_tokens: 2000,
        total_tokens: 3000,
      },
      output_text: JSON.stringify({
        title: "Variable",
        explanation: "This variable is the selected term in the equation.",
      }),
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const { handleExplainTokenRequest } = await import(`../server/app.js?model-reconciliation-${Date.now()}-${Math.random()}`);
  const requestId = "hover-model-reconciliation";
  const req = {
    method: "POST",
    url: "/api/explain-token",
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
      host: "localhost:8787",
    },
    socket: { remoteAddress: "127.0.0.1" },
    body: {
      debugRequestId: requestId,
      problemContext: "Solve x + 1 = 2",
      stepLatex: "x+1=2",
      selectedLatex: "x",
      semanticId: "step-1:x",
    },
  };
  const res = responseRecorder();

  await handleExplainTokenRequest(req, res);

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].model, "gpt-4.1-mini");

  const openAiRequest = logs.find(([name]) => name === "[omnimath:openai-request]")?.[1];
  const openAiResponse = logs.find(([name]) => name === "[omnimath:openai-response]")?.[1];
  const aiRequest = logs.find(([name]) => name === "[omnimath:ai-request]")?.[1];
  const requestSettings = logs.find(([name, value]) => (
    name === "[omnimath:openai-debug]" && value.event === "request_settings"
  ))?.[1];
  const hoverResponse = logs.find(([name, value]) => (
    name === "[omnimath:hover-debug]" && value.event === "http_response"
  ))?.[1];

  assert.equal(openAiRequest.model, "gpt-4.1-mini");
  assert.equal(openAiResponse.responseId, "resp_hover_model_reconciliation");
  assert.equal(openAiResponse.model, "gpt-4.1-mini-2025-04-14");
  assert.equal(requestSettings.requestId, requestId);
  assert.equal(requestSettings.model, "gpt-4.1-mini");
  assert.equal(hoverResponse.requestId, requestId);

  assert.equal(aiRequest.endpoint, "/api/explain-token");
  assert.equal(aiRequest.kind, "hover");
  assert.equal(aiRequest.model, "gpt-5.6-luna");
  assert.equal(Object.hasOwn(aiRequest, "requestId"), false);
  assert.equal(aiRequest.estimatedCostUsd, 0.005);

  const body = res.json();
  assert.equal(body.usage.settlement.actualTotalTokens, 3000);
  assert.equal(body.usage.settlement.actualCostMicros, 5000);
  assert.equal(body.usage.settlement.providerCalls, 1);
  assert.equal(body.usage.settlement.actualInputTokens, 0);
  assert.equal(body.usage.settlement.actualOutputTokens, 0);

  const persistedUsage = JSON.parse(await readFile(usagePath, "utf8"));
  const persistedEntries = Object.entries(persistedUsage);
  assert.equal(
    persistedEntries.find(([key]) => /:tokens:global$/u.test(key))?.[1]?.count,
    3000,
  );
  assert.equal(
    persistedEntries.find(([key]) => /:costMicros:global$/u.test(key))?.[1]?.count,
    5000,
  );
  assert.equal(persistedEntries.some(([key]) => /gpt-4|gpt-5/iu.test(key)), false);
});
