import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMathExplanation, parseJsonResponse } from "../server/openai.js";
import { assertCompactSolveResponse, assertFastSolveResponse } from "../server/mathExplanationSchema.js";

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

function fastSolveOutput(problemLatex = "x+1=2", extra = {}) {
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
  }), extra);
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

function compactTrailingSideCalculationOutput(problemLatex = "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx") {
  return {
    title: "Compact solve with trailing side calculation",
    problemLatex,
    steps: [
      {
        id: "s1",
        heading: "Substitute",
        latex: "x=\\tan\\theta",
        reasoning: "Introduce theta.",
        anchors: [],
      },
      {
        id: "s2",
        heading: "Final Answer",
        latex: "\\frac{\\pi}{2}\\ln^2 2",
        reasoning: "State the final value.",
        anchors: [],
      },
      {
        id: "s3",
        heading: "Check endpoint",
        latex: "0",
        reasoning: "A side calculation should not become finalAnswerLatex.",
        anchors: [],
      },
    ],
  };
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

function responseWithoutText({
  id = "resp_no_text",
  model = "gpt-5.6-luna",
  status = "completed",
  incompleteReason = null,
  refusal = "",
  usage = {
    input_tokens: 12,
    output_tokens: 34,
    total_tokens: 46,
    output_tokens_details: { reasoning_tokens: 30 },
  },
} = {}) {
  const output = refusal
    ? [{
        id: "msg_refusal",
        type: "message",
        status,
        content: [{ type: "refusal", refusal }],
      }]
    : [{
        id: "rs_reasoning",
        type: "reasoning",
        status,
        summary: [{ type: "summary_text", text: "sensitive reasoning must not be diagnosed" }],
      }, {
        id: "msg_metadata",
        type: "message",
        status,
        content: [{ type: "diagnostic_metadata", data: "sensitive content must not be diagnosed" }],
      }];

  return {
    id,
    object: "response",
    model,
    status,
    output,
    usage,
    ...(incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {}),
  };
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
  it("preserves max-output reasoning-only diagnostics when the compact retry also fails", async () => {
    const originalFetch = globalThis.fetch;
    const originalModel = process.env.OMNIMATH_SOLVER_MODEL;
    process.env.OMNIMATH_SOLVER_MODEL = "gpt-5.6-luna";
    const requests = [];
    const capturedFailures = [];
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) {
        return jsonResponse(200, responseWithoutText({
          id: "resp_reasoning_incomplete",
          status: "incomplete",
          incompleteReason: "max_output_tokens",
          usage: {
            input_tokens: 101,
            output_tokens: 6500,
            total_tokens: 6601,
            output_tokens_details: { reasoning_tokens: 6500 },
          },
        }));
      }
      return jsonResponse(200, responseWithoutText({
        id: "resp_compact_no_text",
        usage: {
          input_tokens: 55,
          output_tokens: 21,
          total_tokens: 76,
          output_tokens_details: { reasoning_tokens: 20 },
        },
      }));
    };

    try {
      let finalError;
      await assert.rejects(
        createMathExplanation({
          prompt: "Solve x+1=2",
          originalProblem: "x+1=2",
          debugContext: { requestId: "reasoning-only-max-output" },
          onGeneratedResponseFailure(details) {
            capturedFailures.push(details);
          },
        }),
        (error) => {
          finalError = error;
          return true;
        }
      );

      assert.equal(requests.length, 2);
      assert.equal(requests[1].text.format.name, "math_compact_solve");
      assert.equal(capturedFailures.length, 2);

      const initialError = capturedFailures[0].error;
      const initialDiagnostics = initialError._omniOpenAiDiagnostics;
      assert.equal(initialError.code, "AI_RESPONSE_TRUNCATED");
      assert.equal(initialError.responseFailureType, "truncated");
      assert.notEqual(initialError.code, "AI_RESPONSE_INVALID");
      assert.equal(initialError._aiCallCount, 1);
      assert.equal(initialError._aiUsage.total_tokens, 6601);
      assert.equal(initialDiagnostics.requestId, "reasoning-only-max-output");
      assert.equal(initialDiagnostics.responseId, "resp_reasoning_incomplete");
      assert.equal(initialDiagnostics.responseModel, "gpt-5.6-luna");
      assert.equal(initialDiagnostics.responseStatus, "incomplete");
      assert.equal(initialDiagnostics.providerHttpStatus, 200);
      assert.equal(initialDiagnostics.incompleteReason, "max_output_tokens");
      assert.equal(initialDiagnostics.providerCallCount, 1);
      assert.deepEqual(initialDiagnostics.responseShape.outputItemTypes, ["reasoning", "message"]);
      assert.deepEqual(initialDiagnostics.responseShape.contentItemTypes, ["diagnostic_metadata"]);
      assert.equal(initialDiagnostics.responseShape.outputTextPresent, false);
      assert.equal(initialDiagnostics.responseShape.refusalPresent, false);

      assert.equal(finalError.code, "AI_RESPONSE_INVALID");
      assert.equal(finalError.responseFailureType, "missing_text");
      assert.equal(finalError._aiCallCount, 2);
      assert.equal(finalError._aiUsage.total_tokens, 6677);
      assert.equal(finalError._omniOpenAiDiagnostics.requestId, "reasoning-only-max-output");
      assert.equal(finalError._omniOpenAiDiagnostics.responseId, "resp_compact_no_text");
      assert.equal(finalError._omniOpenAiDiagnostics.providerCallCount, 1);
      assert.equal(finalError._omniOpenAiDiagnostics.responseShape.outputTextPresent, false);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalModel === undefined) delete process.env.OMNIMATH_SOLVER_MODEL;
      else process.env.OMNIMATH_SOLVER_MODEL = originalModel;
    }
  });

  it("retains redacted diagnostics for an unclassified successful no-text response", async () => {
    const originalFetch = globalThis.fetch;
    const responseBody = responseWithoutText({ id: "resp_unclassified_no_text" });
    globalThis.fetch = async () => jsonResponse(200, responseBody);

    try {
      let failure;
      await assert.rejects(
        createMathExplanation({
          prompt: "Solve x+1=2",
          originalProblem: "x+1=2",
          image: {
            filename: "redacted.png",
            contentType: "image/png",
            buffer: Buffer.from([0]),
          },
          debugContext: { requestId: "unclassified-no-text" },
        }),
        (error) => {
          failure = error;
          return error.code === "AI_RESPONSE_INVALID";
        }
      );

      const diagnostics = failure._omniOpenAiDiagnostics;
      const serializedShape = JSON.stringify(diagnostics.responseShape);
      assert.equal(failure.responseFailureType, "missing_text");
      assert.equal(failure._aiCallCount, 1);
      assert.equal(failure._aiUsage.total_tokens, 46);
      assert.equal(diagnostics.requestId, "unclassified-no-text");
      assert.equal(diagnostics.responseId, "resp_unclassified_no_text");
      assert.equal(diagnostics.responseModel, "gpt-5.6-luna");
      assert.equal(diagnostics.responseStatus, "completed");
      assert.equal(diagnostics.providerHttpStatus, 200);
      assert.equal(diagnostics.providerCallCount, 1);
      assert.deepEqual(diagnostics.responseShape.outputItemTypes, ["reasoning", "message"]);
      assert.deepEqual(diagnostics.responseShape.contentItemTypes, ["diagnostic_metadata"]);
      assert.equal(diagnostics.responseShape.outputTextPresent, false);
      assert.equal(diagnostics.responseShape.outputTextType, null);
      assert.equal(diagnostics.responseShape.refusalPresent, false);
      assert.equal(Object.hasOwn(diagnostics, "promptText"), false);
      assert.equal(Object.hasOwn(diagnostics, "modelInputMessages"), false);
      assert.doesNotMatch(serializedShape, /sensitive reasoning/);
      assert.doesNotMatch(serializedShape, /sensitive content/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("classifies a no-text refusal before the generic missing-text failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse(200, responseWithoutText({
      id: "resp_refusal",
      refusal: "The request was declined.",
    }));

    try {
      let failure;
      await assert.rejects(
        createMathExplanation({
          prompt: "Solve x+1=2",
          originalProblem: "x+1=2",
          debugContext: { requestId: "refusal-no-text" },
        }),
        (error) => {
          failure = error;
          return error.code === "AI_REQUEST_REFUSED";
        }
      );

      assert.equal(failure._aiCallCount, 1);
      assert.equal(failure._aiUsage.total_tokens, 46);
      assert.equal(failure._omniOpenAiDiagnostics.requestId, "refusal-no-text");
      assert.equal(failure._omniOpenAiDiagnostics.responseId, "resp_refusal");
      assert.equal(failure._omniOpenAiDiagnostics.responseShape.refusalPresent, true);
      assert.deepEqual(failure._omniOpenAiDiagnostics.responseShape.contentItemTypes, ["refusal"]);
      assert.doesNotMatch(
        JSON.stringify(failure._omniOpenAiDiagnostics.responseShape),
        /The request was declined/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("logs a no-text provider response without blocking parser-driven compact recovery", async () => {
    const originalFetch = globalThis.fetch;
    const originalInfo = console.info;
    const responseLogs = [];
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(200, calls === 1
        ? responseWithoutText({ id: "resp_logged_no_text" })
        : compactSolveOutput());
    };
    console.info = (...args) => {
      if (args[0] === "[omnimath:openai-response]") responseLogs.push(args[1]);
    };

    try {
      const result = await createMathExplanation({
        prompt: "Solve x+1=2",
        originalProblem: "x+1=2",
        debugContext: { requestId: "logger-no-text" },
      });

      assert.equal(calls, 2);
      assert.equal(result._aiCallCount, 2);
      assert.equal(result.runtimeNotice, "Compact explanation generated because the full structured response was too long.");
      assert.equal(responseLogs[0].responseId, "resp_logged_no_text");
      assert.equal(responseLogs[0].outputChars, 0);
      assert.equal(responseLogs[0].responseShape.outputTextPresent, false);
      assert.deepEqual(responseLogs[0].responseShape.outputItemTypes, ["reasoning", "message"]);
    } finally {
      globalThis.fetch = originalFetch;
      console.info = originalInfo;
    }
  });

  it("retries with compact schema when a long solve response is truncated", async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = {
      OMNIMATH_SOLVER_MODEL: process.env.OMNIMATH_SOLVER_MODEL,
    };
    process.env.OMNIMATH_SOLVER_MODEL = "gpt-4.1-mini";
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
      if (originalEnv.OMNIMATH_SOLVER_MODEL === undefined) delete process.env.OMNIMATH_SOLVER_MODEL;
      else process.env.OMNIMATH_SOLVER_MODEL = originalEnv.OMNIMATH_SOLVER_MODEL;
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

  it("rejects compact responses whose trailing step is not the final answer", () => {
    assert.throws(
      () => assertCompactSolveResponse(compactTrailingSideCalculationOutput()),
      /must end with a final answer step/
    );
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
    const originalEnv = {
      OMNIMATH_SOLVER_MODEL: process.env.OMNIMATH_SOLVER_MODEL,
    };
    process.env.OMNIMATH_SOLVER_MODEL = "gpt-4.1-mini";
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
      if (originalEnv.OMNIMATH_SOLVER_MODEL === undefined) delete process.env.OMNIMATH_SOLVER_MODEL;
      else process.env.OMNIMATH_SOLVER_MODEL = originalEnv.OMNIMATH_SOLVER_MODEL;
    }
  });

  it("passes the same explicit sampling settings on quality repair solves", async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = {
      OMNIMATH_REPAIR_MODEL: process.env.OMNIMATH_REPAIR_MODEL,
    };
    process.env.OMNIMATH_REPAIR_MODEL = "gpt-4.1-mini";
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
      if (originalEnv.OMNIMATH_REPAIR_MODEL === undefined) delete process.env.OMNIMATH_REPAIR_MODEL;
      else process.env.OMNIMATH_REPAIR_MODEL = originalEnv.OMNIMATH_REPAIR_MODEL;
    }
  });

  it("sends reasoning effort and omits sampling for reasoning repair models", async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = {
      OMNIMATH_REPAIR_MODEL: process.env.OMNIMATH_REPAIR_MODEL,
      OMNIMATH_REPAIR_REASONING_EFFORT: process.env.OMNIMATH_REPAIR_REASONING_EFFORT,
    };
    process.env.OMNIMATH_REPAIR_MODEL = "o4-mini";
    process.env.OMNIMATH_REPAIR_REASONING_EFFORT = "high";
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
          requestId: "reasoning-repair",
          normalizedProblem: "x+1=2",
          promptHash: "prompt-repair",
          retryPurpose: "quality-repair",
          attemptType: "repair",
        },
      });

      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, "o4-mini");
      assert.deepEqual(requests[0].reasoning, { effort: "high" });
      assert.equal(Object.hasOwn(requests[0], "temperature"), false);
      assert.equal(Object.hasOwn(requests[0], "top_p"), false);
      assert.equal(requests[0].text.format.strict, true);
      assert.equal(requests[0].text.format.type, "json_schema");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnv.OMNIMATH_REPAIR_MODEL === undefined) delete process.env.OMNIMATH_REPAIR_MODEL;
      else process.env.OMNIMATH_REPAIR_MODEL = originalEnv.OMNIMATH_REPAIR_MODEL;
      if (originalEnv.OMNIMATH_REPAIR_REASONING_EFFORT === undefined) delete process.env.OMNIMATH_REPAIR_REASONING_EFFORT;
      else process.env.OMNIMATH_REPAIR_REASONING_EFFORT = originalEnv.OMNIMATH_REPAIR_REASONING_EFFORT;
    }
  });

  it("does not send unsupported reasoning effort values", async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = {
      OMNIMATH_SOLVER_MODEL: process.env.OMNIMATH_SOLVER_MODEL,
      OMNIMATH_SOLVER_REASONING_EFFORT: process.env.OMNIMATH_SOLVER_REASONING_EFFORT,
    };
    process.env.OMNIMATH_SOLVER_MODEL = "o4-mini";
    process.env.OMNIMATH_SOLVER_REASONING_EFFORT = "xhigh";
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return jsonResponse(200, fastSolveOutput());
    };

    try {
      await createMathExplanation({
        prompt: "Solve x+1=2",
        originalProblem: "x+1=2",
        debugContext: {
          requestId: "reasoning-unsupported",
          normalizedProblem: "x+1=2",
          promptHash: "prompt",
        },
      });

      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, "o4-mini");
      assert.equal(Object.hasOwn(requests[0], "reasoning"), false);
      assert.equal(Object.hasOwn(requests[0], "temperature"), false);
      assert.equal(Object.hasOwn(requests[0], "top_p"), false);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnv.OMNIMATH_SOLVER_MODEL === undefined) delete process.env.OMNIMATH_SOLVER_MODEL;
      else process.env.OMNIMATH_SOLVER_MODEL = originalEnv.OMNIMATH_SOLVER_MODEL;
      if (originalEnv.OMNIMATH_SOLVER_REASONING_EFFORT === undefined) delete process.env.OMNIMATH_SOLVER_REASONING_EFFORT;
      else process.env.OMNIMATH_SOLVER_REASONING_EFFORT = originalEnv.OMNIMATH_SOLVER_REASONING_EFFORT;
    }
  });

  it("preserves provider reasoning token usage details", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return jsonResponse(200, fastSolveOutput("x+1=2", {
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          output_tokens_details: { reasoning_tokens: 7 },
          total_tokens: 33,
        },
      }));
    };

    try {
      const result = await createMathExplanation({ prompt: "Solve x+1=2", originalProblem: "x+1=2" });

      assert.equal(requests.length, 1);
      assert.equal(result._aiUsage.input_tokens, 11);
      assert.equal(result._aiUsage.output_tokens, 22);
      assert.equal(result._aiUsage.output_tokens_details.reasoning_tokens, 7);
      assert.equal(result._aiUsage.total_tokens, 33);
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
