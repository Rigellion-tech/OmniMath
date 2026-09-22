import test from "node:test";
import assert from "node:assert/strict";

const openAi = await import("../server/openai.js");

function captureInfo(callback) {
  const original = console.info;
  const entries = [];
  console.info = (...args) => entries.push(args);
  try {
    callback();
  } finally {
    console.info = original;
  }
  return entries;
}

test("candidate telemetry is bounded and excludes solution content", () => {
  const previous = process.env.OMNIMATH_SOLVE_ACCEPTANCE_TELEMETRY;
  process.env.OMNIMATH_SOLVE_ACCEPTANCE_TELEMETRY = "true";
  try {
    const entries = captureInfo(() => openAi.logSolveCandidateOutcome({
      requestId: "req-1",
      attemptId: "req-1:initial",
      candidateId: "candidate-1",
      solveMode: "solver",
      model: "gpt-test",
      providerCompletionStatus: "completed",
      truncationState: "complete",
      fatalFindings: ["missing_required_fields"],
      recoverableFindings: ["normalized_wrapper"],
      warnings: ["presentation_variant"],
      retryReason: "schema_contract",
      selectedForUi: true,
      outcome: "selected_for_ui",
    }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0][0], "[omnimath:solve-candidate-outcome]");
    const payload = entries[0][1];
    assert.equal(payload.requestId, "req-1");
    assert.deepEqual(payload.fatalFindings, ["missing_required_fields"]);
    assert.equal("prompt" in payload, false);
    assert.equal("latex" in payload, false);
    assert.equal("canonicalProblemInput" in payload, false);
  } finally {
    if (previous === undefined) delete process.env.OMNIMATH_SOLVE_ACCEPTANCE_TELEMETRY;
    else process.env.OMNIMATH_SOLVE_ACCEPTANCE_TELEMETRY = previous;
  }
});

test("candidate telemetry can be disabled", () => {
  const previous = process.env.OMNIMATH_SOLVE_ACCEPTANCE_TELEMETRY;
  process.env.OMNIMATH_SOLVE_ACCEPTANCE_TELEMETRY = "false";
  try {
    assert.deepEqual(captureInfo(() => openAi.logSolveCandidateOutcome({ requestId: "req-2" })), []);
  } finally {
    if (previous === undefined) delete process.env.OMNIMATH_SOLVE_ACCEPTANCE_TELEMETRY;
    else process.env.OMNIMATH_SOLVE_ACCEPTANCE_TELEMETRY = previous;
  }
});

test("local canonical input probe matches the serialized provider payload", async () => {
  const priorProbe = process.env.OMNIMATH_DEBUG_CANONICAL_INPUT;
  const priorKey = process.env.OPENAI_API_KEY;
  const priorFetch = globalThis.fetch;
  const priorInfo = console.info;
  const entries = [];
  const payloads = [];
  process.env.OMNIMATH_DEBUG_CANONICAL_INPUT = "true";
  process.env.OPENAI_API_KEY = "test-key";
  console.info = (...args) => { if (args[0] === "[omnimath:canonical-input-probe]") entries.push(args[1]); };
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async text() {
        return JSON.stringify({
          status: "completed",
          output_text: JSON.stringify({
            title: "Solve",
            problemLatex: "x+y=3",
            steps: [{ id: "s1", heading: "Solve", latex: "(x,y)=(1,2)", reasoning: "Use both equations.", anchors: [] }],
            finalAnswerLatex: "(x,y)=(1,2)",
            numericCheck: "",
          }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      },
    };
  };
  try {
    await openAi.createMathExplanation({
      prompt: "Solve x+y=3",
      originalProblem: "x+y=3",
      debugContext: { requestId: "canonical-probe-test", inputSource: "typed", normalizedProblem: "x+y=3" },
    });
    assert.equal(payloads.length, 1);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].canonicalProblemInput, { problemText: "x+y=3", source: "typed" });
    assert.equal(entries[0].canonicalTextOccurrencesInProviderInput, 1);
    assert.match(entries[0].providerInputHash, /^[a-f0-9]{16}$/u);
    assert.equal(payloads[0].input[0].content[0].text, "Solve x+y=3");
  } finally {
    if (priorProbe === undefined) delete process.env.OMNIMATH_DEBUG_CANONICAL_INPUT;
    else process.env.OMNIMATH_DEBUG_CANONICAL_INPUT = priorProbe;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
    globalThis.fetch = priorFetch;
    console.info = priorInfo;
  }
});
