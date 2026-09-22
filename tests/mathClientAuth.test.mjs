import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  explainImageProblem,
  explainProblem,
  extractImageProblem,
  solveExtractedProblem,
} from "../src/api/mathClient.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("math API auth headers", () => {
  it("requests a fresh Clerk token immediately before long solve requests", async () => {
    const events = [];
    const getTokenOptions = [];
    const getToken = async (options) => {
      events.push("getToken");
      getTokenOptions.push(options);
      return `token-${getTokenOptions.length}`;
    };

    globalThis.fetch = async (url, options = {}) => {
      events.push(`fetch:${url}`);
      assert.match(options.headers?.Authorization || "", /^Bearer token-/);
      return new Response(JSON.stringify({ steps: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await explainProblem({ problem: "x^2", history: [], getToken });
    await solveExtractedProblem({ problem: "x^2", extraction: {}, getToken });
    await extractImageProblem({
      file: new Blob(["image"], { type: "image/png" }),
      prompt: "extract",
      getToken,
    });
    await explainImageProblem({
      file: new Blob(["image"], { type: "image/png" }),
      prompt: "solve",
      getToken,
    });

    assert.deepEqual(getTokenOptions, [
      { skipCache: true },
      { skipCache: true },
      { skipCache: true },
      { skipCache: true },
      { skipCache: true },
    ]);
    assert.deepEqual(events, [
      "getToken",
      "fetch:/api/explain",
      "getToken",
      "fetch:/api/solve-extracted-problem",
      "getToken",
      "fetch:/api/extract-image-problem",
      "getToken",
      "fetch:/api/extract-image-problem",
      "getToken",
      "fetch:/api/solve-extracted-problem",
    ]);
  });
});
