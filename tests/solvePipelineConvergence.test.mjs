import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  explainProblem,
  solveCanonicalProblem,
  solveExtractedProblem,
} from "../src/api/mathClient.js";
import { createCanonicalProblemPayload } from "../src/lib/canonicalProblem.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function successfulResponse(problem) {
  return new Response(JSON.stringify({
    problem,
    expression: problem,
    steps: [{ id: "s1", math: "x=1", summary: "Solve." }],
    finalAnswerLatex: "x=1",
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("canonical solve client convergence", () => {
  it("uses one request builder for identical typed and OCR canonical problem text", async () => {
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return successfulResponse(JSON.parse(options.body).problemInput.problemText);
    };
    const getToken = async () => "test-token";
    const problem = "Solve x + 2 = 3.";
    const history = [{ role: "user", text: "Use an algebraic method." }];

    await explainProblem({ problem, history, getToken });
    await solveExtractedProblem({
      problem,
      canonicalProblem: createCanonicalProblemPayload({
        canonicalText: problem,
        canonicalLatex: "x+2=3",
        source: "ocr-reviewed",
        extractionConfidence: 91,
      }),
      extraction: { imageHash: "image-a", confidence: 91 },
      history,
      getToken,
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.body.problemInput.problemText), [problem, problem]);
    assert.deepEqual(requests.map((request) => request.body.problemInput.source), ["typed", "ocr"]);
    assert.equal(requests[0].body.canonicalProblem.contentHash, requests[1].body.canonicalProblem.contentHash);
    assert.deepEqual(requests[0].body.history, requests[1].body.history);
    assert.equal(requests[1].body.problemInput.sourceMetadata.extraction.imageHash, "image-a");
    assert.equal(requests[0].options.method, requests[1].options.method);
    assert.deepEqual(Object.keys(requests[0].body).sort(), Object.keys(requests[1].body).sort());
  });

  it("passes the same cancellation primitive for typed and OCR solves", async () => {
    const signals = [];
    globalThis.fetch = async (_url, options) => {
      signals.push(options.signal);
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return successfulResponse("x=1");
    };
    const getToken = async () => "test-token";
    const typedController = new AbortController();
    const ocrController = new AbortController();
    typedController.abort();
    ocrController.abort();

    await assert.rejects(
      explainProblem({ problem: "x=1", history: [], getToken, signal: typedController.signal }),
      (error) => error.name === "AbortError",
    );
    await assert.rejects(
      solveExtractedProblem({ problem: "x=1", extraction: {}, getToken, signal: ocrController.signal }),
      (error) => error.name === "AbortError",
    );
    assert.deepEqual(signals, [typedController.signal, ocrController.signal]);
  });

  it("keeps request diagnostics source-aware without changing canonical solver text", async () => {
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return successfulResponse("y=2");
    };
    const canonicalProblem = createCanonicalProblemPayload({ canonicalText: "y=2", source: "ocr-direct" });
    await solveCanonicalProblem({
      canonicalProblem,
      sourceMetadata: {
        solveDecision: "direct",
        extraction: { imageSource: { imageHash: "safe-image-hash" } },
      },
      getToken: async () => "test-token",
    });

    assert.equal(request.body.problemInput.problemText, "y=2");
    assert.equal(request.body.problemInput.source, "ocr");
    assert.equal(request.body.problemInput.sourceMetadata.extraction.imageSource.imageHash, "safe-image-hash");
    assert.match(request.body.debugRequestId, /^canonical-solve-/);
  });
});
