import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCompactSolveResponse,
  assertFastSolveResponse,
} from "../server/mathExplanationSchema.js";

function candidate({
  latex = "F(a)=1",
  reasoning = "Apply the stated identity.",
  finalAnswerLatex = "F(a)=1",
} = {}) {
  return {
    title: "Structurally valid solve",
    problemLatex: "I(a)=\\int_0^1 f(x,a)\\,dx",
    steps: [{
      id: "step-1",
      heading: "Evaluate",
      latex,
      reasoning,
      anchors: [],
    }],
    finalAnswerLatex,
    numericCheck: "",
  };
}

describe("structural solve acceptance", () => {
  it("accepts a candidate containing newly introduced symbols", () => {
    const parsed = assertFastSolveResponse(candidate({
      latex: "I(a)=G(a)+C",
      finalAnswerLatex: "I(a)=G(a)+C",
    }));
    assert.equal(parsed.finalAnswerLatex, "I(a)=G(a)+C");
  });

  it("accepts a candidate using a special function", () => {
    const parsed = assertFastSolveResponse(candidate({
      latex: "I(a)=\\operatorname{Li}_2(-a)",
      finalAnswerLatex: "I(a)=\\operatorname{Li}_2(-a)",
    }));
    assert.equal(parsed.finalAnswerLatex, "I(a)=\\operatorname{Li}_2(-a)");
  });

  it("accepts an unsupported-looking identity", () => {
    const parsed = assertFastSolveResponse(candidate({
      latex: "\\int_0^1 f(x)\\,dx=\\pi^3",
      finalAnswerLatex: "\\pi^3",
    }));
    assert.equal(parsed.steps[0].latex, "\\int_0^1 f(x)\\,dx=\\pi^3");
  });

  it("retains the frontend response shape", () => {
    const parsed = assertFastSolveResponse(candidate());
    assert.deepEqual(Object.keys(parsed), [
      "title",
      "problemLatex",
      "steps",
      "finalAnswerLatex",
      "numericCheck",
    ]);
    assert.equal(Array.isArray(parsed.steps), true);
  });

  it("keeps compact retry acceptance structural instead of presentation-based", () => {
    const parsed = assertCompactSolveResponse({
      title: "Compact",
      problemLatex: "x+1=2",
      steps: [{
        id: "step-1",
        heading: "Check",
        latex: "x=1",
        reasoning: "This is structurally usable even without a special final heading.",
        anchors: [],
      }],
    });
    assert.equal(parsed.finalAnswerLatex, "x=1");
  });

  it("rejects missing required structural fields", () => {
    assert.throws(
      () => assertFastSolveResponse({ title: "Missing", problemLatex: "x=1", steps: [] }),
      (error) => error.code === "AI_RESPONSE_INVALID"
        && error.responseFailureType === "schema_contract",
    );
  });
});
