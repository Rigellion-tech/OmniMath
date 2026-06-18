import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMathExplanation, parseJsonResponse } from "../server/openai.js";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.OPENAI_RETRY_BASE_DELAY_MS = "1";

function body(outputText, extra = {}) {
  return {
    output_text: outputText,
    model: "test-model",
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
    },
    ...extra,
  };
}

function assertObject(value) {
  assert.equal(typeof value, "object");
  return value;
}

function fastSolveOutput(problemLatex = "x+1=2") {
  return body(JSON.stringify({
    title: "Solve equation",
    problemLatex,
    steps: [
      {
        id: "s1",
        heading: "Subtract 1",
        latex: "x=1",
        reasoning: "Subtract 1 from both sides.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "x=1",
    numericCheck: "",
  }));
}

function jsonResponse(status, payload, statusText = status === 200 ? "OK" : "Error") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function transientFetchError(code, message = code) {
  return Object.assign(new TypeError("fetch failed"), {
    cause: { code, message },
  });
}

describe("openai JSON parsing", () => {
  it("parses valid JSON", () => {
    const parsed = parseJsonResponse(body('{"title":"Ok"}'), assertObject);
    assert.equal(parsed.title, "Ok");
  });

  it("strips markdown JSON fences", () => {
    const parsed = parseJsonResponse(body('```json\n{"title":"Fenced"}\n```'), assertObject);
    assert.equal(parsed.title, "Fenced");
  });

  it("extracts the first complete JSON object before trailing text", () => {
    const parsed = parseJsonResponse(body('{"title":"Done"}\nextra commentary'), assertObject);
    assert.equal(parsed.title, "Done");
  });

  it("does not reconstruct clearly truncated JSON", () => {
    assert.throws(
      () => parseJsonResponse(body('{"title":"Cut","steps":[{"id":"s1"'), assertObject),
      (error) => error.code === "AI_RESPONSE_INVALID"
    );
  });

  it("classifies length-finished JSON as truncated", () => {
    assert.throws(
      () => parseJsonResponse(body('{"title":"Cut"', { incomplete_details: { reason: "max_output_tokens" } }), assertObject),
      (error) => error.code === "AI_RESPONSE_TRUNCATED"
    );
  });
});

describe("createMathExplanation compact fallback", () => {
  it("retries with compact schema when a long solve response is truncated", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push(payload);
      if (requests.length === 1) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          async text() {
            return JSON.stringify(body('{"title":"Stokes","problemLatex":"\\\\iint_S", "steps":[', {
              incomplete_details: { reason: "max_output_tokens" },
            }));
          },
        };
      }

      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return JSON.stringify(body(JSON.stringify({
            title: "Stokes compact",
            problemLatex: "\\iint_S(\\nabla\\times\\mathbf{F})\\cdot\\mathbf{n}\\,dS",
            steps: [
              {
                id: "s1",
                heading: "Use Stokes",
                latex: "\\iint_S(\\nabla\\times\\mathbf{F})\\cdot\\mathbf{n}\\,dS=\\oint_C\\mathbf{F}\\cdot d\\mathbf{r}",
                reasoning: "Use Stokes' theorem to move to the boundary curve.",
                anchors: [],
              },
              {
                id: "s2",
                heading: "Final compact form",
                latex: "\\oint_C\\mathbf{F}\\cdot d\\mathbf{r}",
                reasoning: "This is the compact boundary integral form.",
                anchors: [],
              },
            ],
          })));
        },
      };
    };

    try {
      const result = await createMathExplanation({
        prompt: "Solve this long Stokes theorem vector field problem with curl and a surface integral.",
        originalProblem: "\\iint_S(\\nabla\\times\\mathbf{F})\\cdot\\mathbf{n}\\,dS",
      });

      assert.equal(requests.length, 2);
      assert.equal(requests[0].max_output_tokens >= 6500, true);
      assert.equal(requests[1].text.format.name, "math_compact_solve");
      assert.equal(result.runtimeNotice, "Compact explanation generated because the full structured response was too long.");
      assert.equal(result.steps.length, 2);
      assert.equal(result._aiCallCount, 2);
      assert.equal(result._aiUsage.total_tokens, 60);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenAI transient retry handling", () => {
  it("retries ECONNRESET once and returns the successful solver response", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw transientFetchError("ECONNRESET", "socket hang up");
      return jsonResponse(200, fastSolveOutput());
    };

    try {
      const result = await createMathExplanation({ prompt: "Solve x+1=2", originalProblem: "x+1=2" });
      assert.equal(calls, 2);
      assert.equal(result.finalAnswerLatex, "x=1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries an Undici connect timeout before succeeding", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        throw transientFetchError("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error");
      }
      return jsonResponse(200, fastSolveOutput("\\frac{d}{dx}x^2"));
    };

    try {
      const result = await createMathExplanation({
        prompt: "Differentiate x^2",
        originalProblem: "\\frac{d}{dx}x^2",
      });
      assert.equal(calls, 2);
      assert.equal(result.finalAnswerLatex, "x=1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry non-transient provider validation errors", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(400, {
        error: {
          type: "invalid_request_error",
          code: "invalid_request_error",
          message: "Invalid schema.",
        },
      }, "Bad Request");
    };

    try {
      await assert.rejects(
        createMathExplanation({ prompt: "Solve x+1=2", originalProblem: "x+1=2" }),
        (error) => {
          assert.equal(error.code, "AI_SERVICE_ERROR");
          assert.equal(error.providerStatus, 400);
          return true;
        }
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns AI_SERVICE_UNAVAILABLE with a public message after final network failure", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw transientFetchError("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error");
    };

    try {
      await assert.rejects(
        createMathExplanation({ prompt: "Solve x+1=2", originalProblem: "x+1=2" }),
        (error) => {
          assert.equal(calls, 3);
          assert.equal(error.code, "AI_SERVICE_UNAVAILABLE");
          assert.equal(error.statusCode, 503);
          assert.equal(error.publicMessage, "The AI service is temporarily unreachable. Check your internet connection and try again.");
          assert.equal(error.networkCauseCode, "UND_ERR_CONNECT_TIMEOUT");
          assert.match(error.networkCauseMessage, /Connect Timeout/i);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
