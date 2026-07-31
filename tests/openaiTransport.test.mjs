import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  classifyOpenAiInfrastructureFailure,
  createMathExplanation,
  debugOpenAiConnection,
  isRetryableOpenAiTransportError,
  normalizeOpenAiTransportError,
} from "../server/openai.js";

const originalFetch = globalThis.fetch;
const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_RETRY_BASE_DELAY_MS: process.env.OPENAI_RETRY_BASE_DELAY_MS,
  OMNIMATH_SOLVER_MODEL: process.env.OMNIMATH_SOLVER_MODEL,
  OMNIMATH_REPAIR_MODEL: process.env.OMNIMATH_REPAIR_MODEL,
  OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS:
    process.env.OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS,
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

function transportError(code, message = code) {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(message), { code }),
  });
}

function domTimeoutError(cause = undefined) {
  const error = new DOMException(
    "The operation was aborted due to timeout",
    "TimeoutError",
  );
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", {
      configurable: true,
      value: cause,
    });
  }
  return error;
}

afterEach(() => restore());

describe("OpenAI transport retry diagnostics", () => {
  it("classifies DOM TimeoutError code 23 as a non-retryable request timeout", async () => {
    const timeoutError = domTimeoutError();
    const normalized = normalizeOpenAiTransportError(timeoutError);

    assert.equal(normalized.normalizedErrorCode, "TimeoutError");
    assert.equal(normalized.legacyNumericCode, 23);
    assert.equal(normalized.failureType, "request_timeout");
    assert.equal(normalized.timeoutScope, "request");
    assert.equal(normalized.errorName, "TimeoutError");
    assert.equal(
      normalized.errorMessage,
      "The operation was aborted due to timeout",
    );
    assert.equal(isRetryableOpenAiTransportError(timeoutError), false);
    assert.equal(
      classifyOpenAiInfrastructureFailure({ error: timeoutError }),
      "request_timeout",
    );

    process.env.OPENAI_API_KEY = "test-key";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw timeoutError;
    };

    await assert.rejects(
      () => debugOpenAiConnection(),
      (error) => {
        const diagnostics = error.openAiTransportDiagnostics;
        assert.equal(calls, 1);
        assert.equal(error.code, "AI_SERVICE_UNAVAILABLE");
        assert.equal(error.networkCauseCode, "TimeoutError");
        assert.equal(error.networkLegacyNumericCode, 23);
        assert.equal(diagnostics.maxAttempts, 3);
        assert.equal(diagnostics.transportAttempts, 1);
        assert.equal(diagnostics.retryCount, 0);
        assert.equal(diagnostics.attempts.length, 1);
        assert.equal(diagnostics.attempts[0].retryable, false);
        assert.equal(diagnostics.attempts[0].normalizedErrorCode, "TimeoutError");
        assert.equal(diagnostics.attempts[0].legacyNumericCode, 23);
        assert.equal(diagnostics.attempts[0].errorName, "TimeoutError");
        assert.equal(
          diagnostics.attempts[0].errorMessage,
          "The operation was aborted due to timeout",
        );
        assert.equal(diagnostics.attempts[0].failureType, "request_timeout");
        return true;
      },
    );
  });

  it("reports the attempted Terra repair model and repair deadline on timeout", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OMNIMATH_SOLVER_MODEL = "gpt-5.6-luna";
    process.env.OMNIMATH_REPAIR_MODEL = "gpt-5.6-terra";
    process.env.OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS = "120000";
    const attemptedModels = [];
    const exceptionLogs = [];
    const originalConsoleError = console.error;
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      calls += 1;
      attemptedModels.push(JSON.parse(options.body).model);
      throw domTimeoutError();
    };
    console.error = (...args) => {
      if (args[0] === "[omnimath:openai-exception]") {
        exceptionLogs.push(args[1]);
      }
    };

    try {
      await assert.rejects(
        () => createMathExplanation({
          prompt: "Repair x+7=12",
          originalProblem: "x+7=12",
          debugContext: {
            retryPurpose: "quality-repair",
            requestId: "timeout-role-test",
          },
        }),
        (error) => {
          const diagnostics = error.openAiTransportDiagnostics;
          assert.equal(error.code, "AI_SERVICE_UNAVAILABLE");
          assert.equal(diagnostics.model, "gpt-5.6-terra");
          assert.equal(diagnostics.modelRole, "repair");
          assert.equal(diagnostics.solveMode, "quality-repair");
          assert.equal(diagnostics.timeoutMs, 120000);
          assert.equal(
            diagnostics.timeoutSource,
            "OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS",
          );
          assert.equal(diagnostics.transportAttempts, 1);
          assert.equal(diagnostics.retryCount, 0);
          assert.equal(
            diagnostics.finalInfrastructureFailureType,
            "request_timeout",
          );
          return true;
        },
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(calls, 1);
    assert.deepEqual(attemptedModels, ["gpt-5.6-terra"]);
    assert.equal(exceptionLogs.length, 1);
    assert.equal(exceptionLogs[0].model, "gpt-5.6-terra");
    assert.equal(exceptionLogs[0].modelRole, "repair");
    assert.equal(exceptionLogs[0].solveMode, "quality-repair");
    assert.equal(exceptionLogs[0].timeoutMs, 120000);
    assert.equal(
      exceptionLogs[0].timeoutSource,
      "OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS",
    );
  });

  it("keeps connection-establishment timeouts retryable", () => {
    const error = transportError(
      "UND_ERR_CONNECT_TIMEOUT",
      "Connect Timeout Error",
    );
    const normalized = normalizeOpenAiTransportError(error);

    assert.equal(normalized.normalizedErrorCode, "UND_ERR_CONNECT_TIMEOUT");
    assert.equal(normalized.failureType, "connection_timeout");
    assert.equal(normalized.timeoutScope, "connection_establishment");
    assert.equal(isRetryableOpenAiTransportError(error), true);
  });

  it("keeps ETIMEDOUT classified as a retryable timeout", () => {
    const error = transportError("ETIMEDOUT", "Operation timed out");

    assert.equal(
      classifyOpenAiInfrastructureFailure({ error }),
      "timeout",
    );
    assert.equal(isRetryableOpenAiTransportError(error), true);
  });

  it("keeps ECONNRESET classified as a retryable connection failure", () => {
    const error = transportError("ECONNRESET", "Connection reset by peer");

    assert.equal(
      classifyOpenAiInfrastructureFailure({ error }),
      "connect_failure",
    );
    assert.equal(isRetryableOpenAiTransportError(error), true);
  });

  it("classifies retryable DNS failures without exposing request secrets", () => {
    const error = eaiAgainError();

    assert.equal(isRetryableOpenAiTransportError(error), true);
    assert.equal(classifyOpenAiInfrastructureFailure({ error }), "dns_failure");
  });

  it("does not treat an unexplained numeric code 23 as a DOM timeout", () => {
    const error = Object.assign(new Error("Opaque transport failure"), {
      code: 23,
    });
    const normalized = normalizeOpenAiTransportError(error);

    assert.equal(normalized.normalizedErrorCode, 23);
    assert.equal(normalized.legacyNumericCode, 23);
    assert.equal(normalized.failureType, "connect_failure");
    assert.equal(normalized.timeoutScope, null);
    assert.equal(isRetryableOpenAiTransportError(error), false);
  });

  it("classifies TimeoutError without a numeric code as a request timeout", () => {
    const error = Object.assign(new Error("Request deadline elapsed"), {
      name: "TimeoutError",
    });
    const normalized = normalizeOpenAiTransportError(error);

    assert.equal(normalized.normalizedErrorCode, "TimeoutError");
    assert.equal(normalized.legacyNumericCode, null);
    assert.equal(normalized.failureType, "request_timeout");
    assert.equal(isRetryableOpenAiTransportError(error), true);
  });

  it("preserves a TimeoutError cause chain in diagnostics", () => {
    const cause = Object.assign(new Error("Socket closed after timeout"), {
      code: "ECONNRESET",
    });
    const normalized = normalizeOpenAiTransportError(domTimeoutError(cause));

    assert.deepEqual(normalized.causeChain, [{
      name: "Error",
      code: "ECONNRESET",
      message: "Socket closed after timeout",
    }]);
    assert.equal(normalized.failureType, "request_timeout");
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
