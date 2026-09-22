import assert from "node:assert/strict";
import { test } from "node:test";
import { convertFastSolveToMathExplanation } from "../server/mathExplanationSchema.js";
import { assertSolveCandidateStructure } from "../server/solveCandidateStructure.js";
import { withSolveDiagnosticContext } from "../server/solveDiagnosticContext.js";
import { normalizeSolveResponse } from "../src/api/mathClient.js";

const providerCandidate = (latex) => ({
  title: "Boundary fixture",
  problemLatex: "x+1=2",
  steps: [
    { id: "s1", heading: "Start", latex: "x+1=2", reasoning: "Start.", anchors: [] },
    { id: "s2", heading: "Subtract", latex, reasoning: "Subtract one.", anchors: [] },
    { id: "s3", heading: "Final answer", latex: "x=1", reasoning: "Result.", anchors: [] },
  ],
  finalAnswerLatex: "x=1",
  numericCheck: "",
});

for (const value of ["", " \n\t ", String.raw`\phantom{x}`]) {
  test(`provider-to-converter rejects empty visible math ${JSON.stringify(value)}`, (t) => {
    const events = [];
    t.mock.method(console, "error", (label, event) => events.push({ label, ...event }));
    withSolveDiagnosticContext({ requestId: "blank-provider", endpoint: "/api/explain" }, () => {
      assert.throws(() => convertFastSolveToMathExplanation(providerCandidate(value)), (error) => (
        error.code === "AI_RESPONSE_INVALID"
        && error.requestId === "blank-provider"
        && error.solutionDiagnostics.some((diagnostic) => diagnostic.type === "provider_empty" && diagnostic.index === 1)
      ));
    });
    assert.ok(events.some((event) => event.outcome === "provider_empty" && event.requestId === "blank-provider"));
  });
}

test("fault-injected normalization loss is rejected at the production boundary with source index and request correlation", (t) => {
  const events = [];
  t.mock.method(console, "error", (label, event) => events.push({ label, ...event }));
  const sourceSteps = [{ math: "x+1=2" }, { math: "x=1" }];
  // Inject a broken transform at the boundary. This does not claim that the
  // current normalizer erases this expression (or that Sep 11 did so).
  const transformed = { finalAnswerLatex: "x=1", steps: [sourceSteps[0], { math: "" }] };
  withSolveDiagnosticContext({ requestId: "blank-normalized" }, () => {
    assert.throws(() => assertSolveCandidateStructure(transformed, { stage: "normalization", sourceSteps }), (error) => (
      error.solutionDiagnostics.some((diagnostic) => diagnostic.type === "normalization_emptied" && diagnostic.index === 1)
      && error.requestId === "blank-normalized"
    ));
  });
  assert.equal(events[0].outcome, "normalization_emptied");
  assert.equal(events[0].requestId, "blank-normalized");
});

test("post-annotation acceptance rejects an empty retained step at that boundary", (t) => {
  const events = [];
  t.mock.method(console, "error", (label, event) => events.push({ label, ...event }));
  assert.throws(() => assertSolveCandidateStructure({ steps: [{ math: "" }], finalAnswerLatex: "1" }, {
    stage: "post_annotation",
    requestId: "blank-annotation",
  }), (error) => error.solutionDiagnostics[0].type === "accepted_empty");
  assert.equal(events[0].stage, "post_annotation");
  assert.equal(events[0].requestId, "blank-annotation");
});

test("client normalization retains malformed middle positions and emits received-boundary failure", (t) => {
  const events = [];
  t.mock.method(console, "error", (label, event) => events.push({ label, ...event }));
  const normalized = normalizeSolveResponse({ requestId: "blank-client", steps: [{ math: "x" }, null, { math: "1" }] });
  assert.equal(normalized.steps.length, 3);
  assert.equal(normalized.steps[1].renderBoundaryError.index, 1);
  assert.equal(events[0].outcome, "accepted_empty");
  assert.equal(events[0].requestId, "blank-client");
});
