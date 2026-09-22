import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROVENANCE_EVIDENCE_STEP_LIMIT,
  buildFollowupPayload,
  buildProvenanceSnapshot,
  getConversationId,
  getTargetRevision,
} from "../src/lib/explanationProvenance.js";

function matrixProblem(stepCount = 3) {
  return {
    id: "matrix-session",
    expression: "Find the inverse of A under the stated invertibility assumption.",
    assumptions: ["det(A) is nonzero"],
    steps: Array.from({ length: stepCount }, (_, index) => ({
      id: `step-${index}`,
      label: `Step ${index}`,
      math: index === 1 ? "\\operatorname{adj}(A)=\\begin{bmatrix}20&2\\\\20&4\\end{bmatrix}" : `q_${index}=q_${index - 1}+1`,
      reasoning: `Reasoning for dependency ${index}`,
      branchId: index > 1 ? "positive-branch" : null,
    })),
  };
}

function selectedTwenty(problem, targetId, sourceRange) {
  const token = {
    id: targetId,
    semanticNodeId: targetId,
    role: "matrixEntry",
    type: "number",
    source: "20",
    sourceRange,
    parentExpression: problem.steps[1].math,
    ancestors: [{ id: `${targetId}-cofactor`, role: "cofactor", type: "group", source: "C_{12}" }],
  };
  return {
    id: `window-${targetId}`,
    referenceId: targetId,
    referenceType: "token",
    stepId: "step-1",
    selectedText: "20",
    selectedTokens: [token],
    context: {
      problem,
      solution: problem,
      stepId: "step-1",
      stepTitle: "Step 1",
      currentStep: problem.steps[1],
    },
  };
}

describe("explanation provenance snapshot", () => {
  it("distinguishes repeated identical values by semantic occurrence and source range", () => {
    const problem = matrixProblem();
    const first = buildProvenanceSnapshot({ item: selectedTwenty(problem, "entry-r1c1", { start: 41, end: 43 }), problem });
    const second = buildProvenanceSnapshot({ item: selectedTwenty(problem, "entry-r2c1", { start: 48, end: 50 }), problem });

    assert.equal(first.target.sourceText, "20");
    assert.equal(second.target.sourceText, "20");
    assert.notEqual(first.target.targetId, second.target.targetId);
    assert.notDeepEqual(first.target.sourceRange, second.target.sourceRange);
    assert.notEqual(getConversationId(first), getConversationId(second));
    assert.notEqual(getTargetRevision(first), getTargetRevision(second));
    assert.equal(first.target.ancestors[0].role, "cofactor");
  });

  it("retains the selected step in a bounded, ordered long-distance evidence window", () => {
    const problem = matrixProblem(PROVENANCE_EVIDENCE_STEP_LIMIT + 20);
    const selectedIndex = PROVENANCE_EVIDENCE_STEP_LIMIT + 10;
    const item = selectedTwenty(problem, "deep-result", { start: 3, end: 5 });
    item.stepId = `step-${selectedIndex}`;
    item.context.stepId = item.stepId;
    item.context.currentStep = problem.steps[selectedIndex];

    const snapshot = buildProvenanceSnapshot({ item, problem });
    const indices = snapshot.evidence.steps.map((step) => step.index);

    assert.equal(snapshot.evidence.steps.length, PROVENANCE_EVIDENCE_STEP_LIMIT);
    assert.ok(indices.includes(selectedIndex));
    assert.deepEqual(indices, [...indices].sort((left, right) => left - right));
    assert.equal(snapshot.origin.stepIndex, selectedIndex);
    assert.equal(snapshot.origin.branchId, "positive-branch");
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(problem.steps[selectedIndex]), false);
  });

  it("hands the displayed lazy explanation and immutable ownership envelope to follow-up", () => {
    const problem = matrixProblem();
    const item = selectedTwenty(problem, "entry-r1c1", { start: 41, end: 43 });
    const provenanceSnapshot = buildProvenanceSnapshot({ item, problem });
    const request = {
      requestId: "request-1",
      conversationId: getConversationId(provenanceSnapshot),
      targetRevision: getTargetRevision(provenanceSnapshot),
    };
    const payload = buildFollowupPayload({
      request,
      provenanceSnapshot,
      item,
      problem,
      displayedExplanation: "20 is the cofactor-derived adjugate entry shown here.",
      question: "How did you find 20?",
      history: [{ role: "assistant", text: "Earlier answer" }],
    });

    assert.equal(payload.pinnedExplanation, "20 is the cofactor-derived adjugate entry shown here.");
    assert.equal(payload.requestId, request.requestId);
    assert.equal(payload.conversationId, request.conversationId);
    assert.equal(payload.targetRevision, request.targetRevision);
    assert.equal(payload.provenanceSnapshot.target.targetId, "entry-r1c1");
    assert.equal(payload.provenanceSnapshot.origin.stepId, "step-1");
    assert.equal(payload.provenanceSnapshot.evidence.steps.length, 3);
  });

  it("does not attribute a missing originating step to step zero", () => {
    const problem = matrixProblem();
    const item = selectedTwenty(problem, "orphan-entry", { start: 1, end: 3 });
    item.stepId = "missing-step";
    item.context.stepId = "missing-step";
    item.context.currentStep = null;

    const snapshot = buildProvenanceSnapshot({ item, problem });

    assert.equal(snapshot.origin.stepIndex, null);
    assert.equal(snapshot.origin.currentStep, null);
    assert.equal(snapshot.confidence.kind, "insufficient");
    assert.equal(snapshot.evidence.steps[0].index, 0);
  });
});
