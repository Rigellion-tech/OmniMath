import assert from "node:assert/strict";
import katex from "katex";
import { describe, it } from "node:test";
import {
  assertCompactSolveResponse,
  assertFastSolveResponse,
  convertFastSolveToMathExplanation,
  sanitizeGeneratedLatex,
} from "../server/mathExplanationSchema.js";
import { finalizeSolveCandidate } from "../server/solveCandidateLifecycle.js";
import { inspectSolveCandidateStructure } from "../server/solveCandidateStructure.js";
import { normalizeSolveResponse } from "../src/api/mathClient.js";
import { makeFastResponse, solutionAcceptanceCorpus } from "./fixtures/solutionAcceptanceCorpus.mjs";

function makeWrapperProbe() {
  return makeFastResponse({
    problemLatex: "$$x=1$$",
    finalAnswerLatex: "\\(x=1\\)",
    steps: ["\\[x=1\\]", "$$x=1$$"],
  });
}

function renderFinal(candidate) {
  assert.doesNotThrow(() => katex.renderToString(candidate.finalAnswerLatex, {
    throwOnError: true,
    strict: "ignore",
    displayMode: true,
  }));
}

describe("general solution acceptance corpus", () => {
  it("covers every requested mathematical domain", () => {
    assert.deepEqual(solutionAcceptanceCorpus.map(({ domain }) => domain), [
      "algebra", "calculus", "multivariable-calculus", "linear-algebra", "odes", "pdes",
      "probability-statistics", "optimization", "numerical-methods", "vector-calculus",
      "complex-analysis", "mathematical-physics", "thermodynamics", "matrices-tensors",
      "systems", "piecewise",
    ]);
  });

  it("uses a populated math field when an optional earlier field is empty", () => {
    const inspection = inspectSolveCandidateStructure({
      finalAnswerLatex: "x=1",
      steps: [{ id: "step-1", latex: "", math: "x=1" }],
    });
    assert.equal(inspection.usable, true);
  });

  it("keeps a control space at the end of a physical line when stacking an answer", () => {
    const finalAnswer = sanitizeGeneratedLatex(String.raw`x\ ` + "\ny", { stackPhysicalLines: true });
    assert.equal(finalAnswer, String.raw`\begin{gathered}x\ \\y\end{gathered}`);
    renderFinal({ finalAnswerLatex: finalAnswer });
  });

  for (const entry of solutionAcceptanceCorpus) {
    it(`${entry.domain}: accepts unchanged, converts, finalizes, and renders`, () => {
      const asserted = assertFastSolveResponse(entry.unchanged, entry.unchanged.problemLatex);
      const compact = assertCompactSolveResponse({ ...entry.unchanged, steps: entry.unchanged.steps }, entry.unchanged.problemLatex);
      assert.equal(asserted.steps.length, entry.unchanged.steps.length);
      assert.equal(compact.steps.length, entry.unchanged.steps.length);
      const explanation = convertFastSolveToMathExplanation(asserted, { originalProblem: entry.unchanged.problemLatex });
      const finalized = finalizeSolveCandidate(explanation, { problem: entry.unchanged.problemLatex });
      assert.equal(finalized.candidateAcceptance.accepted, true);
      renderFinal(asserted);
    });

    it(`${entry.domain}: normalizes harmless wrappers and remains usable`, () => {
      const asserted = assertFastSolveResponse(entry.normalized, entry.normalized.problemLatex);
      assert.equal(/^\\(?:\(|\[)|^\$\$|\\(?:\)|\])$/.test(asserted.finalAnswerLatex), false);
      const wrapperProbe = makeWrapperProbe();
      const probe = assertFastSolveResponse(wrapperProbe, wrapperProbe.problemLatex);
      assert.equal(probe.problemLatex, "x=1");
      assert.equal(probe.finalAnswerLatex, "x=1");
      const client = normalizeSolveResponse({ result: {
        steps: asserted.steps.map((s) => ({ id: s.id, math: s.latex, summary: s.reasoning })),
        finalAnswerLatex: asserted.finalAnswerLatex,
      } });
      assert.equal(client.steps.length, asserted.steps.length);
      const converted = convertFastSolveToMathExplanation(asserted);
      const finalized = finalizeSolveCandidate(converted, { problem: asserted.problemLatex });
      assert.equal(finalized.candidateAcceptance.accepted, true);
      const ui = normalizeSolveResponse(converted);
      assert.ok(typeof ui.finalAnswer === "string" && ui.finalAnswer.trim());
      assert.equal(ui.steps.length, asserted.steps.length);
      assert.ok(ui.steps.every((step) => typeof step.math === "string" && step.math.trim()));
      renderFinal({ finalAnswerLatex: ui.finalAnswer });
    });

    it(`${entry.domain}: accepts related multiline or multi-expression answers`, () => {
      const asserted = assertFastSolveResponse(entry.warned, entry.warned.problemLatex);
      const inspection = inspectSolveCandidateStructure(asserted);
      assert.equal(inspection.usable, true);
      assert.equal(inspection.warnings.some((warning) => warning.includes("final_answer_contains_multiple_unrelated_equations")), true);
      const finalized = finalizeSolveCandidate(convertFastSolveToMathExplanation(asserted), { problem: asserted.problemLatex });
      assert.equal(finalized.candidateAcceptance.accepted, true);
      assert.equal(asserted.finalAnswerLatex, entry.warned.finalAnswerLatex);
      renderFinal(asserted);
    });

    it(`${entry.domain}: rejects genuinely malformed output`, () => {
      assert.throws(
        () => {
          const parsed = assertFastSolveResponse(entry.rejected, entry.rejected.problemLatex);
          finalizeSolveCandidate(convertFastSolveToMathExplanation(parsed), { problem: entry.rejected.problemLatex });
        },
      );
    });
  }
});
