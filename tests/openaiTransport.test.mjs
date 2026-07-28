import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  classifyOpenAiInfrastructureFailure,
  debugOpenAiConnection,
  isRetryableOpenAiTransportError,
} from "../server/openai.js";

const originalFetch = globalThis.fetch;
const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_RETRY_BASE_DELAY_MS: process.env.OPENAI_RETRY_BASE_DELAY_MS,
};

function restore() {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function responseBody() {
  return {
    id: "resp_test",
    model: "gpt-4.1-mini",
    status: "completed",
    output_text: "ok",
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function eaiAgainError() {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.openai.com"), {
      code: "EAI_AGAIN",
    }),
  });
}

afterEach(() => restore());

describe("OpenAI transport retry diagnostics", () => {
  it("classifies retryable DNS failures without exposing request secrets", () => {
    const error = eaiAgainError();

    assert.equal(isRetryableOpenAiTransportError(error), true);
    assert.equal(classifyOpenAiInfrastructureFailure({ error }), "dns_failure");
  });

  it("retries EAI_AGAIN with a bounded attempt count and records successful provider usage", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    process.env.OPENAI_RETRY_BASE_DELAY_MS = "1";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls < 3) throw eaiAgainError();
      return jsonResponse(responseBody());
    };

    const result = await debugOpenAiConnection();

    assert.equal(calls, 3);
    assert.equal(result.ok, true);
    assert.equal(result.usage.totalTokens, 5);
  });

  it("stops after bounded retries and reports sanitized infrastructure diagnostics", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    process.env.OPENAI_RETRY_BASE_DELAY_MS = "1";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw eaiAgainError();
    };

    await assert.rejects(
      () => debugOpenAiConnection(),
      (error) => {
        assert.equal(calls, 3);
        assert.equal(error.code, "AI_SERVICE_UNAVAILABLE");
        assert.equal(error.networkCauseCode, "EAI_AGAIN");
        assert.equal(error.openAiTransportDiagnostics.apiHost, "api.openai.com");
        assert.equal(error.openAiTransportDiagnostics.transportAttempts, 3);
        assert.equal(error.openAiTransportDiagnostics.successfulProviderResponses, 0);
        assert.equal(error.openAiTransportDiagnostics.retryCount, 2);
        assert.equal(error.openAiTransportDiagnostics.finalInfrastructureFailureType, "dns_failure");
        assert.equal(JSON.stringify(error.openAiTransportDiagnostics).includes("test-key"), false);
        assert.equal(JSON.stringify(error.openAiTransportDiagnostics).includes("Authorization"), false);
        return true;
      }
    );
  });

  it("does not retry ordinary non-retryable provider 4xx request errors", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse({
        error: {
          type: "invalid_request_error",
          code: "unsupported_value",
          message: "Unsupported value.",
        },
      }, 400);
    };

    await assert.rejects(
      () => debugOpenAiConnection(),
      (error) => {
        assert.equal(calls, 1);
        assert.equal(error.code, "AI_SERVICE_ERROR");
        assert.equal(error.providerStatus, 400);
        return true;
      }
    );
  });
});
