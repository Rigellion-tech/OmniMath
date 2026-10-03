import assert from "node:assert/strict";
import { test } from "node:test";
import katex from "katex";
import { assertFastSolveResponse, convertFastSolveToMathExplanation } from "../server/mathExplanationSchema.js";
import { inspectSolveCandidateStructure } from "../server/solveCandidateStructure.js";
import { finalizeSolveCandidate } from "../server/solveCandidateLifecycle.js";
import { normalizeSolveResponse } from "../src/api/mathClient.js";
import { makePhase5KktFixture, phase5KktDuplicatedFinal, phase5KktResult, makePhase5WideMatrixFixture, phase5WideMatrixResult } from "./fixtures/phase5FinalAnswer.mjs";

test("Phase 5 incident fixture carries usable KKT mathematics and deterministic presentation warnings", () => {
  const fixture = makePhase5KktFixture();
  const parsed = assertFastSolveResponse(fixture, fixture.problemLatex);
  const structural = inspectSolveCandidateStructure(parsed);
  assert.equal(structural.usable, true);
  for (const warning of ["final_answer_contains_line_break_command", "final_answer_contains_multiple_unrelated_equations"]) {
    assert.ok(structural.warnings.includes(`finalAnswerLatex:${warning}`));
  }
  const finalized = finalizeSolveCandidate(convertFastSolveToMathExplanation(parsed), { problem: fixture.problemLatex });
  assert.equal(finalized.candidateAcceptance.accepted, true);
  // Canonical evidence must remain unchanged even when the presentation projection suppresses repetition.
  const normalized = normalizeSolveResponse(finalized);
  assert.equal(normalized.finalAnswer, phase5KktDuplicatedFinal);
  assert.equal(normalized.steps.find(step => step.id === "result").math, phase5KktResult);
  assert.equal(normalized.steps.find(step => step.id === "final-answer").math, phase5KktDuplicatedFinal);
  assert.doesNotThrow(() => katex.renderToString(phase5KktDuplicatedFinal, { throwOnError: true, strict: "ignore", displayMode: true }));
});

test("Phase 5 wide matrix is a single complete result, even when its matrix uses row breaks", () => {
  const fixture = makePhase5WideMatrixFixture();
  const parsed = assertFastSolveResponse(fixture, fixture.problemLatex);
  assert.equal(inspectSolveCandidateStructure(parsed).usable, true);
  assert.equal(parsed.finalAnswerLatex, phase5WideMatrixResult);
  assert.doesNotThrow(() => katex.renderToString(parsed.finalAnswerLatex, { throwOnError: true, strict: "ignore", displayMode: true }));
});
