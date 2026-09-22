import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildProvenanceFollowupPrompt,
  createGeneralFollowupFallback,
  followupCorrelation,
  normalizeProvenanceSnapshot,
} from "../server/followupProvenance.js";

function matrixSnapshot(overrides = {}) {
  return {
    version: 1,
    target: {
      semanticId: "step-6:adjugate:r2c2:value-20",
      targetId: "step-6:adjugate:r2c2:value-20",
      stepId: "step-6",
      sourceRange: { start: 31, end: 33 },
      sourceText: "20",
      role: "matrix-entry",
      type: "number",
      parentExpression: String.raw`A^{-1}=\frac1{52}\operatorname{adj}(A)`,
      selectedNode: { id: "value-20", type: "number", role: "matrix-entry", source: "20", start: 31, end: 33 },
      ancestors: [{ id: "adj-r2c2", type: "matrix-cell", role: "adjugate-entry", source: "20" }],
    },
    origin: {
      problemId: "inverse-a",
      problemText: String.raw`Find the inverse of A=\begin{bmatrix}4&1&2\\0&3&1\\0&2&5\end{bmatrix}`,
      solutionRevision: "solution-r4",
      stepIndex: 5,
      stepId: "step-6",
      stepTitle: "Form the inverse from the adjugate",
      currentStep: {
        id: "step-6",
        math: String.raw`A^{-1}=\frac1{52}\operatorname{adj}(A)`,
        reasoning: "Divide the adjugate by the determinant.",
      },
      branchId: "inverse-main",
    },
    evidence: {
      steps: [
        { index: 0, id: "step-1", math: String.raw`A=\begin{bmatrix}4&1&2\\0&3&1\\0&2&5\end{bmatrix}`, reasoning: "Read the original entries.", branchId: "inverse-main" },
        { index: 1, id: "step-2", math: String.raw`\det(A)=52`, reasoning: "Expand the determinant.", branchId: "inverse-main" },
        { index: 2, id: "step-3", math: String.raw`M_{22}=\begin{bmatrix}4&2\\0&5\end{bmatrix}`, reasoning: "Delete row 2 and column 2.", branchId: "inverse-main" },
        { index: 3, id: "step-4", math: String.raw`C_{22}=(-1)^{2+2}(4\cdot5-2\cdot0)=20`, reasoning: "Evaluate the minor determinant and apply the cofactor sign.", branchId: "inverse-main" },
        { index: 4, id: "step-5", math: String.raw`\operatorname{adj}(A)_{22}=C_{22}=20`, reasoning: "Transpose the cofactor matrix; this diagonal entry stays at (2,2).", branchId: "inverse-main" },
        { index: 5, id: "step-6", math: String.raw`A^{-1}=\det(A)^{-1}\operatorname{adj}(A)`, reasoning: "Use the inverse formula.", branchId: "inverse-main" },
      ],
      relevantInputs: ["the original matrix entries used by the selected minor"],
      assumptions: [String.raw`\det(A)\ne0`],
    },
    confidence: { kind: "explicit" },
    ...overrides,
  };
}

describe("follow-up provenance snapshots", () => {
  it("preserves the matrix-20 occurrence, origin, cofactor evidence, and problem", () => {
    const body = {
      provenanceSnapshot: matrixSnapshot(),
      targetId: "step-6:adjugate:r2c2:value-20",
      stepId: "step-6",
      question: "how did you find 20?",
      pinnedExplanation: "20 is the selected adjugate entry.",
    };
    const { prompt, snapshot } = buildProvenanceFollowupPrompt(body, []);

    assert.equal(snapshot.target.sourceText, "20");
    assert.match(prompt, /step-6:adjugate:r2c2:value-20/);
    const evidence = JSON.parse(prompt.match(/ORDERED COMPACT STEP EVIDENCE\n([^\n]+)/)?.[1]);
    assert.equal(evidence.find((step) => step.id === "step-4")?.math, String.raw`C_{22}=(-1)^{2+2}(4\cdot5-2\cdot0)=20`);
    assert.match(prompt, /Find the inverse of A=/);
    assert.match(prompt, /reconstruction and label it as reconstruction/);
    assert.match(prompt, /Correct a false premise/);
  });

  it("distinguishes repeated visible values by occurrence id and rejects mismatches", () => {
    const snapshot = matrixSnapshot();
    snapshot.target.sourceText = "2";
    snapshot.target.semanticId = "step-6:matrix:r2c1:two";
    snapshot.target.targetId = "step-6:matrix:r2c1:two";

    const normalized = normalizeProvenanceSnapshot(snapshot, {
      targetId: "step-6:matrix:r2c1:two",
      selectedText: "2",
    });
    assert.equal(normalized.target.targetId, "step-6:matrix:r2c1:two");
    assert.throws(() => normalizeProvenanceSnapshot(snapshot, {
      targetId: "step-2:determinant:two",
    }), /target identity does not match/);
  });

  it("retains a distant selected origin step without malformed prefix-sliced JSON", () => {
    const snapshot = matrixSnapshot();
    snapshot.origin.stepIndex = 35;
    snapshot.origin.stepId = "step-36";
    snapshot.origin.currentStep = { id: "step-36", math: "z=987654321", reasoning: "Use the quantity established at step 2." };
    snapshot.target.stepId = "step-36";
    snapshot.evidence.steps = Array.from({ length: 40 }, (_, index) => ({
      index,
      id: `step-${index + 1}`,
      math: index === 35 ? "z=987654321" : `q_${index}=${index}`,
      reasoning: index === 1 ? "This is the distant dependency used at step 36." : `Evidence ${index}`,
    }));

    const { prompt } = buildProvenanceFollowupPrompt({
      provenanceSnapshot: snapshot,
      stepId: "step-36",
      question: "where did this come from?",
    }, []);
    const evidenceText = prompt.match(/ORDERED COMPACT STEP EVIDENCE\n([^\n]+)/)?.[1];

    assert.ok(prompt.length < 24_000);
    assert.doesNotThrow(() => JSON.parse(evidenceText));
    assert.match(evidenceText, /step-36/);
    assert.match(evidenceText, /step-1/);
    assert.match(prompt, /z=987654321/);
  });

  it("validates version, range, confidence, evidence shape, and step consistency", () => {
    const cases = [
      [matrixSnapshot({ version: 2 }), {}, /Unsupported/],
      [{ ...matrixSnapshot(), target: { ...matrixSnapshot().target, sourceRange: { start: 9, end: 2 } } }, {}, /half-open range/],
      [{ ...matrixSnapshot(), confidence: { kind: "certain-ish" } }, {}, /confidence.kind is invalid/],
      [{ ...matrixSnapshot(), evidence: { steps: "not-an-array" } }, {}, /evidence.steps must be an array/],
      [matrixSnapshot(), { stepId: "unrelated-step" }, /step identity does not match/],
    ];
    cases.forEach(([snapshot, body, expected]) => {
      assert.throws(() => normalizeProvenanceSnapshot(snapshot, body), expected);
    });
  });

  it("accepts a pinned concept snapshot with explicitly insufficient step provenance", () => {
    const snapshot = matrixSnapshot();
    snapshot.target = { ...snapshot.target, type: "related-concept", stepId: "" };
    snapshot.origin = { ...snapshot.origin, stepId: "", stepIndex: null, currentStep: null };
    snapshot.evidence = { steps: [], relevantInputs: [], assumptions: [] };
    snapshot.confidence = { kind: "insufficient" };

    const normalized = normalizeProvenanceSnapshot(snapshot);
    assert.equal(normalized.origin.stepId, "");
    assert.equal(normalized.confidence.kind, "insufficient");
  });

  it("uses a numeral-independent fallback and states insufficient provenance", () => {
    const body = {
      selectedText: "20",
      stepId: "step-6",
      stepTitle: "Adjugate",
      currentStep: { math: "adj(A)_{21}=20" },
      pinnedExplanation: "20 is an adjugate entry.",
      question: "how did you find 20?",
    };
    const answer = createGeneralFollowupFallback(body, [], "offline fixture");
    assert.match(answer, /selected occurrence `20`/);
    assert.match(answer, /adj\(A\)_\{21\}=20/);
    assert.match(answer, /cannot establish a deeper origin/);
    assert.doesNotMatch(answer, /The 3/);
  });

  it("keeps conversation history and correlation values in the request contract", () => {
    const body = {
      provenanceSnapshot: matrixSnapshot(),
      question: "why is the sign positive?",
      requestId: "followup-request-8",
      conversationId: "conversation-a",
      targetRevision: 12,
    };
    const { prompt } = buildProvenanceFollowupPrompt(body, [
      { role: "user", text: "how did you get it?" },
      { role: "assistant", text: "It comes from the signed cofactor." },
    ]);
    assert.deepEqual(followupCorrelation(body), {
      requestId: "followup-request-8",
      conversationId: "conversation-a",
      targetRevision: 12,
    });
    assert.match(prompt, /signed cofactor/);
    assert.match(prompt, /latest assistant-introduced intermediate/);
    assert.match(prompt, /Do not agree that an operation, sign, formula, source, or theorem occurred/);
  });
});
