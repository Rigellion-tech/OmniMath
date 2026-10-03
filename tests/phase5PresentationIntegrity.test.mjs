import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { assertFastSolveResponse, convertFastSolveToMathExplanation } from "../server/mathExplanationSchema.js";
import { finalizeSolveCandidate } from "../server/solveCandidateLifecycle.js";
import { normalizeSolveResponse } from "../src/api/mathClient.js";
import { assessFinalAnswerPresentation, assessSolutionFinalAnswerPresentations, normalizeFinalAnswerComparison, presentSolutionSteps } from "../src/lib/finalAnswerPresentation.js";
import { applyProgressiveSolveEvent, createFullResponseEvents, createProgressiveSolveState, progressiveProblemFromState, PROGRESSIVE_EVENT_TYPES } from "../src/lib/progressiveSolve.js";
import { makePhase5KktFixture, phase5KktDuplicatedFinal, phase5KktResult } from "./fixtures/phase5FinalAnswer.mjs";

function candidate() {
  const fixture = makePhase5KktFixture();
  return finalizeSolveCandidate(convertFastSolveToMathExplanation(assertFastSolveResponse(fixture)), {
    problem: fixture.problemLatex, requestId: "phase5-offline", candidateId: "phase5-candidate",
  });
}

test("presentation never weakens required final mathematics or logs the raw result", () => {
  for (const finalAnswerLatex of ["", String.raw`x=\frac{1}{`]) {
    assert.throws(() => assertFastSolveResponse(makePhase5KktFixture({ finalAnswerLatex })),
      (error) => error.code === "AI_RESPONSE_INVALID");
  }
  const records = [];
  const originalInfo = console.info;
  try {
    console.info = (event, details) => { if (event === "[omnimath:final-answer-presentation]") records.push(details); };
    candidate();
  } finally {
    console.info = originalInfo;
  }
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.requestId, "phase5-offline");
  assert.equal(record.candidateId, "phase5-candidate");
  assert.equal(record.action, "suppressed");
  assert.equal(record.originalRetained, false);
  assert.ok(record.findings.some((finding) => finding.issue === "final_answer_contains_multiple_unrelated_equations"));
  assert.equal(record.duplication.classification, "substantial_derivation");
  assert.ok(record.finalCardAnnotatedTokens.count > 0);
  assert.ok(!JSON.stringify(record).includes(phase5KktDuplicatedFinal));
  assert.equal(Object.hasOwn(record, "latex"), false);
});

test("recorded server final-field warnings retain their consequence when the UI recomputes presentation", () => {
  const fixture = makePhase5KktFixture({ finalAnswerLatex: "x=1,a" });
  const finalized = finalizeSolveCandidate(convertFastSolveToMathExplanation(assertFastSolveResponse(fixture)));
  // Exercise the diagnostic transport contract explicitly. The active chain
  // splitter does not classify this particular string as a detached fragment.
  finalized.finalAnswerPresentation = assessFinalAnswerPresentation(finalized, {
    validationFindings: ["finalAnswerLatex:detached_final_answer_fragment"],
  });
  const normalized = normalizeSolveResponse(JSON.parse(JSON.stringify(finalized)));
  const plan = assessFinalAnswerPresentation(normalized, {
    validationFindings: normalized.finalAnswerPresentation.findings.map(({ issue }) => issue),
  });
  assert.deepEqual(plan.findings, normalized.finalAnswerPresentation.findings);
  assert.ok(plan.findings.some(({ issue }) => issue === "detached_final_answer_fragment"));
  assert.equal(plan.action, "fallback");
  assert.equal(plan.action, normalized.finalAnswerPresentation.action);
});

test("accepted canonical evidence survives JSON/frontend normalization while redundant final owners leave the projection", () => {
  const finalized = candidate();
  assert.equal(finalized.candidateAcceptance.accepted, true);
  assert.equal(finalized.candidateAcceptance.repairRequested, false);
  const normalized = normalizeSolveResponse(JSON.parse(JSON.stringify(finalized)));
  const before = JSON.stringify(normalized);
  const projected = presentSolutionSteps(normalized.steps, normalized.finalAnswerPresentation);
  assert.equal(normalized.finalAnswerPresentation.action, "suppressed");
  assert.equal(normalized.finalAnswer, phase5KktDuplicatedFinal);
  assert.equal(JSON.stringify(normalized), before);
  assert.equal(projected.length, 6);
  assert.equal(projected.some(step => step.id === "final-answer"), false);
  assert.equal(projected.find(step => step.id === "result").math, phase5KktResult);
  projected.forEach((step, index) => assert.equal(step, normalized.steps[index]));
});

test("compaction cannot retain the old final step semantic owners or anchors", () => {
  const fixture = makePhase5KktFixture();
  // Add a genuinely novel caveat at the outermost row level; keep it verbatim.
  fixture.finalAnswerLatex = fixture.finalAnswerLatex.slice(0, -"\\end{aligned}".length)
    + String.raw`\\\text{one Newton step only}\end{aligned}`;
  const final = fixture.steps.at(-1);
  final.latex = fixture.finalAnswerLatex;
  Object.assign(final, { chunks: [{ id: "old-chunk", display: "stale" }], lines: [{ id: "old-line", latex: "stale" }],
    expressions: [{ id: "old-expression", tokens: [{ id: "stale-owner" }] }], tokens: [{ id: "stale-owner" }],
    anchors: [{ id: "stale-anchor" }], semanticTree: { id: "stale-tree" }, semanticNodes: [{ id: "stale-owner" }] });
  const before = JSON.stringify(fixture);
  const plan = assessFinalAnswerPresentation(fixture);
  assert.equal(plan.action, "compacted");
  assert.match(plan.latex, /one Newton step only/u);
  const projected = presentSolutionSteps(fixture.steps, plan);
  const remediated = projected.at(-1);
  assert.notEqual(remediated, final);
  for (const field of ["chunks", "expressions", "tokens", "anchors", "semanticNodes"]) assert.deepEqual(remediated[field], []);
  assert.equal(remediated.lines.length, 1);
  assert.equal(remediated.lines[0].kind, "math");
  assert.equal(remediated.lines[0].latex, plan.latex);
  assert.deepEqual(remediated.lines[0].tokens, []);
  assert.equal(remediated.lines.some(({ id }) => id === "old-line"), false);
  assert.equal(remediated.semanticTree, null);
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(projected.slice(0, -1).every((step, index) => step === fixture.steps[index]), true);
});

test("progressive final-answer projection preserves every immutable authoritative prefix step", () => {
  const finalized = candidate();
  const identity = { requestId: "phase5-stream", attemptId: "attempt-1", sessionId: "session-1", conversationId: "conversation-1" };
  const events = createFullResponseEvents(JSON.parse(JSON.stringify(finalized)), identity);
  let state = createProgressiveSolveState();
  let published;
  for (const event of events) {
    if (event.type === PROGRESSIVE_EVENT_TYPES.FINAL_ANSWER) published = state.completedSteps;
    const next = applyProgressiveSolveEvent(state, event);
    assert.equal(next.accepted, true);
    state = next.state;
  }
  assert.equal(state.status, "complete");
  assert.equal(state.completedSteps, published);
  assert.ok(state.completedSteps.every(Object.isFrozen));
  const problem = progressiveProblemFromState(state);
  assert.deepEqual(problem.finalAnswerPresentation, finalized.finalAnswerPresentation);
  const before = JSON.stringify(problem.steps);
  const projected = presentSolutionSteps(problem.steps, problem.finalAnswerPresentation);
  assert.equal(projected.length, 6);
  assert.equal(JSON.stringify(problem.steps), before);
  assert.equal(problem.steps.at(-1).math, phase5KktDuplicatedFinal);
  assert.deepEqual(projected.map(step => step.id), presentSolutionSteps(finalized.steps, finalized.finalAnswerPresentation).map(step => step.id));
});

test("Markdown export preserves a unique structured branch caveat after result compaction", async () => {
  const source = await readFile(new URL("../src/components/math/ExportButton.jsx", import.meta.url), "utf8");
  // Execute the production export helper without loading React or browser-only
  // PDF dependencies. Assert the exported artifact rather than its source text.
  const helper = source.slice(source.indexOf("function buildMarkdownExport("), source.indexOf("export default function ExportButton("));
  const buildMarkdownExport = runInNewContext(`${helper}\nbuildMarkdownExport`, {
    assessSolutionFinalAnswerPresentations, normalizeFinalAnswerComparison, presentSolutionSteps,
  });
  const fixture = makePhase5KktFixture();
  const caveat = "This correction applies only to the branch x > 0; one Newton step is not convergence.";
  const latex = fixture.finalAnswerLatex.slice(0, -String.raw`\end{aligned}`.length)
    + String.raw`\\\rho=0\end{aligned}`;
  const final = fixture.steps.at(-1);
  fixture.finalAnswerLatex = latex;
  final.latex = latex;
  final.lines = [{ id: "original-branch-owner", kind: "text", text: caveat, tokens: [{ id: "old-owner" }] }];
  assert.equal(assessFinalAnswerPresentation(fixture).action, "compacted");
  const exported = buildMarkdownExport(fixture);
  assert.ok(exported.includes(caveat));
  assert.ok(exported.includes(String.raw`\rho=0`));
  assert.ok(!exported.includes("old-owner"));
});
