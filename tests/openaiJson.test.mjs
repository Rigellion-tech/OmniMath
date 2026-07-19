import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMathExplanation, parseJsonResponse } from "../server/openai.js";
import { assertFastSolveResponse } from "../server/mathExplanationSchema.js";

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

function compactSolveOutput(problemLatex = "x+1=2") {
  return body(JSON.stringify({
    title: "Compact solve",
    problemLatex,
    steps: [
      {
        id: "s1",
        heading: "Compact final",
        latex: "x=1",
        reasoning: "Compact solve step.",
        anchors: [],
      },
    ],
  }));
}

function requestPromptText(payload) {
  return payload?.input?.[0]?.content?.find((item) => item.type === "input_text")?.text || "";
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
        && error.responseFailureType === "truncated"
        && error.compactRetryable === true
    );
  });

  it("classifies length-finished JSON as truncated", () => {
    assert.throws(
      () => parseJsonResponse(body('{"title":"Cut"', { incomplete_details: { reason: "max_output_tokens" } }), assertObject),
      (error) => error.code === "AI_RESPONSE_TRUNCATED"
        && error.responseFailureType === "truncated"
        && error.compactRetryable === true
    );
  });

  it("classifies malformed complete JSON as a JSON parse failure", () => {
    assert.throws(
      () => parseJsonResponse(body('{"title":}'), assertObject),
      (error) => error.code === "AI_RESPONSE_INVALID"
        && error.responseFailureType === "json_parse"
        && error.compactRetryable === true
    );
  });

  it("classifies assert/schema errors as schema contract failures", () => {
    assert.throws(
      () => parseJsonResponse(body('{"title":"Missing"}'), () => {
        throw Object.assign(new Error("Model response is missing required solve fields."), {
          statusCode: 502,
          code: "AI_RESPONSE_INVALID",
          compactRetryable: true,
        });
      }),
      (error) => error.code === "AI_RESPONSE_INVALID"
        && error.responseFailureType === "schema_contract"
        && error.compactRetryable === true
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
      assert.equal(requests[0].temperature, 0);
      assert.equal(requests[0].top_p, 1);
      assert.equal(requests[1].text.format.name, "math_compact_solve");
      assert.match(requestPromptText(requests[1]), /cut off or incomplete/i);
      assert.doesNotMatch(requestPromptText(requests[1]), /final_answer_splits_into_multiple_unrelated_fragments/);
      assert.equal(requests[1].temperature, 0);
      assert.equal(requests[1].top_p, 1);
      assert.equal(result.runtimeNotice, "Compact explanation generated because the full structured response was too long.");
      assert.equal(result.steps.length, 2);
      assert.equal(result._aiCallCount, 2);
      assert.equal(result._aiUsage.total_tokens, 60);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries with compact schema when the full solve JSON is malformed", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push(payload);
      return jsonResponse(200, requests.length === 1
        ? body('{"title":"Cut","steps":[{"id":"s1"')
        : compactSolveOutput());
    };

    try {
      const result = await createMathExplanation({ prompt: "Solve x+1=2", originalProblem: "x+1=2" });

      assert.equal(requests.length, 2);
      assert.equal(requests[1].text.format.name, "math_compact_solve");
      assert.match(requestPromptText(requests[1]), /cut off or incomplete/i);
      assert.equal(result.runtimeNotice, "Compact explanation generated because the full structured response was too long.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries with compact schema when the full solve fails schema validation", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push(payload);
      return jsonResponse(200, requests.length === 1
        ? body(JSON.stringify({ title: "Missing solve fields" }))
        : compactSolveOutput());
    };

    try {
      const result = await createMathExplanation({ prompt: "Solve x+1=2", originalProblem: "x+1=2" });

      assert.equal(requests.length, 2);
      assert.equal(requests[1].text.format.name, "math_compact_solve");
      assert.match(requestPromptText(requests[1]), /did not match the required solve schema/i);
      assert.equal(result.runtimeNotice, "Compact explanation generated because the full structured response was too long.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not compact retry non-retryable quality-class parse errors", async () => {
    assert.throws(
      () => parseJsonResponse(body('{"title":"Quality invalid"}'), () => {
        throw Object.assign(new Error("Solution failed quality validation."), {
          statusCode: 502,
          code: "AI_SOLUTION_QUALITY_INVALID",
          compactRetryable: false,
        });
      }),
      (error) => error.code === "AI_SOLUTION_QUALITY_INVALID" && error.compactRetryable === false
    );
  });

  it("passes final-answer structure feedback into compact retry", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push(payload);
      if (requests.length === 1) {
        return jsonResponse(200, body(JSON.stringify({
          title: "Bad final field",
          problemLatex: "I=\\int_0^1 x\\,dx",
          steps: [
            {
              id: "s1",
              heading: "Evaluate",
              latex: "I=\\frac{1}{2}",
              reasoning: "Evaluate the integral.",
              anchors: [],
            },
          ],
          finalAnswerLatex: "I'=0\\Rightarrow I=\\frac{1}{2}",
          numericCheck: "",
        })));
      }
      return jsonResponse(200, compactSolveOutput("I=\\int_0^1 x\\,dx"));
    };

    try {
      const result = await createMathExplanation({
        prompt: "Solve I=int_0^1 x dx",
        originalProblem: "I=\\int_0^1 x\\,dx",
      });

      const retryPrompt = requestPromptText(requests[1]);
      assert.equal(requests.length, 2);
      assert.equal(requests[1].text.format.name, "math_compact_solve");
      assert.match(retryPrompt, /final-answer field contract/i);
      assert.match(retryPrompt, /final_answer_contains_derivation_arrow/);
      assert.match(retryPrompt, /exactly one standalone mathematical expression/i);
      assert.match(retryPrompt, /Do not include \\Rightarrow/);
      assert.match(retryPrompt, /Do not include line breaks/);
      assert.match(retryPrompt, /last step latex contains only the final standalone result/i);
      assert.doesNotMatch(retryPrompt, /previous full structured response was cut off/i);
      assert.equal(result.runtimeNotice, "Compact explanation generated because the full structured response was too long.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes the exact multi-fragment final-answer issue into compact retry", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push(payload);
      if (requests.length === 1) {
        return jsonResponse(200, body(JSON.stringify({
          title: "Bad final field",
          problemLatex: "\\int_0^1 x\\,dx",
          steps: [
            {
              id: "s1",
              heading: "Evaluate",
              latex: "I=\\frac{1}{2}",
              reasoning: "Evaluate the integral.",
              anchors: [],
            },
          ],
          finalAnswerLatex: "J=0 \\int_0^1 x\\,dx=\\frac{1}{2}",
          numericCheck: "",
        })));
      }
      return jsonResponse(200, compactSolveOutput("\\int_0^1 x\\,dx"));
    };

    try {
      await createMathExplanation({
        prompt: "Evaluate int_0^1 x dx",
        originalProblem: "\\int_0^1 x\\,dx",
      });

      const retryPrompt = requestPromptText(requests[1]);
      assert.match(retryPrompt, /final_answer_splits_into_multiple_unrelated_fragments/);
      assert.match(retryPrompt, /Do not include multiple unrelated equations/);
      assert.doesNotMatch(retryPrompt, /previous full structured response was cut off/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("classifies final-answer structure failures separately from malformed LaTeX syntax", () => {
    let structureError;
    assert.throws(
      () => parseJsonResponse(body(JSON.stringify({
        title: "Bad final field",
        problemLatex: "I=\\int_0^1 x\\,dx",
        steps: [{
          id: "s1",
          heading: "Evaluate",
          latex: "I=\\frac{1}{2}",
          reasoning: "Evaluate the integral.",
          anchors: [],
        }],
        finalAnswerLatex: "I'=0\\Rightarrow I=\\frac{1}{2}",
        numericCheck: "",
      })), assertFastSolveResponse),
      (error) => {
        structureError = error;
        return true;
      }
    );
    assert.equal(structureError.responseFailureType, "field_structure");
  });
});

describe("OpenAI solver sampling", () => {
  it("passes explicit low-temperature sampling settings on initial solves", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push(payload);
      return jsonResponse(200, fastSolveOutput());
    };

    try {
      await createMathExplanation({
        prompt: "Solve x+1=2",
        originalProblem: "x+1=2",
        debugContext: {
          requestId: "sampling-initial",
          normalizedProblem: "x+1=2",
          promptHash: "prompt-initial",
        },
      });

      assert.equal(requests.length, 1);
      assert.equal(requests[0].temperature, 0);
      assert.equal(requests[0].top_p, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes the same explicit sampling settings on quality repair solves", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push(payload);
      return jsonResponse(200, fastSolveOutput());
    };

    try {
      await createMathExplanation({
        prompt: "Repair the prior invalid solve for x+1=2",
        originalProblem: "x+1=2",
        debugContext: {
          requestId: "sampling-repair",
          normalizedProblem: "x+1=2",
          promptHash: "prompt-repair",
          retryPurpose: "quality-repair",
          attemptType: "repair",
        },
      });

      assert.equal(requests.length, 1);
      assert.equal(requests[0].temperature, 0);
      assert.equal(requests[0].top_p, 1);
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
