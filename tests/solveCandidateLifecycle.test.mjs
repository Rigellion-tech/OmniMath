import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessSolveCandidate, finalizeSolveCandidate } from "../server/solveCandidateLifecycle.js";
import { decideCandidateAcceptance } from "../server/solveAcceptancePolicy.js";
import { annotateMathExplanation } from "../server/mathAnnotator.js";
import { convertFastSolveToMathExplanation, convertImageSolveToMathExplanation } from "../server/mathExplanationSchema.js";
import { normalizeSolveResponse } from "../src/api/mathClient.js";
import { classifySolveCandidate, decideSolveFailureAction } from "../server/app.js";

const candidate = (latex = "x^2=4", answer = "x=2") => ({ title: "Candidate", steps: [{ id: "s1", math: latex, summary: "Reasoning is not a proof." }], finalAnswerLatex: answer });
describe("shared candidate lifecycle", () => {
  for (const state of ["verified", "numerically_supported", "inconclusive", "contradicted"]) it(`evidence-only acceptance for ${state}`, () => {
    const decision = decideCandidateAcceptance({ structural: { usable: true }, verification: { summary: { hasContradiction: state === "contradicted", counts: { [state]: 1 } } } });
    assert.equal(decision.action, "accept"); assert.equal(decision.mathematicalCorrectness, "not_established"); assert.equal(decision.repairRequested, false); assert.equal(decision.escalationRequested, false);
  });
  it("rejects structurally unusable candidates before verification", () => {
    const r = assessSolveCandidate({ steps: [], finalAnswerLatex: "1" });
    assert.equal(r.acceptance.action, "reject"); assert.equal(r.verification, null);
    assert.throws(() => finalizeSolveCandidate({}), (e) => e.code === "AI_RESPONSE_INVALID");
  });
  it("rejects solver steps that contain only invisible LaTeX layout commands", () => {
    assert.throws(
      () => finalizeSolveCandidate(candidate(String.raw`\quad`, "1")),
      (error) => error.code === "AI_RESPONSE_INVALID"
        && error.solutionIssues?.includes("steps[0].math:empty_visible_math"),
    );
  });
  it("keeps smash content visible for structural acceptance", () => {
    assert.doesNotThrow(() => finalizeSolveCandidate(candidate(String.raw`\smash{x}`, "x")));
  });
  it("rejects malformed step LaTeX before it reaches the browser renderer", () => {
    assert.throws(
      () => finalizeSolveCandidate(candidate(String.raw`x=\foo{`, "1")),
      (error) => error.code === "AI_RESPONSE_INVALID"
        && error.solutionIssues?.some((issue) => issue.startsWith("steps[0].math:katex_parse_failed:")),
    );
  });
  it("legacy ledger and failure policy agree with the common structural boundary", () => {
    const r = classifySolveCandidate({ result: { steps: [], finalAnswerLatex: "1" } });
    assert.equal(r.accepted, false); assert.equal(decideSolveFailureAction({ candidate: r }).action, "response_generation_failure");
  });
  it("lack of capability is accepted with explicit inconclusive coverage", () => {
    const r = finalizeSolveCandidate(candidate(String.raw`\operatorname{Li}_2(x)`, String.raw`\operatorname{Li}_2(1)`), { problem: "Evaluate a special function." });
    assert.equal(r.candidateAcceptance.accepted, true); assert.equal(r.verification.summary.counts.inconclusive, 2);
  });
  it("checks the final root against the submitted equation", () => {
    const r = finalizeSolveCandidate(candidate("x^2=4", "x=3"), { problem: "x^2=4" });
    assert.equal(r.verification.checks.at(-1).state, "contradicted"); assert.equal(r.verification.checks.at(-1).linkedInput, "x^2=4");
    assert.equal(r.candidateAcceptance.accepted, true); assert.match(r.candidateAcceptance.reason, /contradiction_evidence/u);
  });
  it("ordinary equations are not treated as universal identities", () => {
    const r = finalizeSolveCandidate(candidate(), { problem: "x^2=4" });
    assert.equal(r.verification.checks[0].state, "inconclusive"); assert.equal(r.verification.checks.at(-1).state, "verified");
    assert.equal(r.verification.summary.solutionCorrectness, "not_established");
  });
  it("does not verify TeX scripts using a different plain-infix interpretation", () => {
    const r = finalizeSolveCandidate(candidate("2^10=1024", "2^{-1}=1/2"));
    assert.equal(r.verification.checks[0].state, "inconclusive");
    assert.equal(r.verification.checks.at(-1).state, "verified");
    const signed = finalizeSolveCandidate(candidate("2^-1=1/2", "2^{10}=1024"));
    assert.equal(signed.verification.checks[0].state, "inconclusive");
    assert.equal(signed.verification.checks.at(-1).state, "verified");
    const badBound = finalizeSolveCandidate(candidate("50", "50"), { problem: String.raw`\int_0^10 x\,dx` });
    assert.equal(badBound.verification.checks.at(-1).state, "inconclusive");
    const groupedBound = finalizeSolveCandidate(candidate("50", "50"), { problem: String.raw`\int_0^{10} x\,dx` });
    assert.equal(groupedBound.verification.checks.at(-1).state, "verified");
  });
  it("verifies explicit antiderivative steps", () => {
    const r = finalizeSolveCandidate(candidate(String.raw`\int cos(2*x)\,dx=sin(2*x)/2+C`, "sin(2*x)/2+C"), { problem: String.raw`\int cos(2*x)\,dx` });
    assert.deepEqual(r.verification.checks.map((c) => c.state), ["verified", "verified"]);
    assert.equal(r.verification.coverage.proseChecked, false);
  });
  it("checks a named derivative only against an explicit prior definition", () => {
    const r = finalizeSolveCandidate(candidate("F'(x)=3*x^2", "F'(x)=3*x^2"), { problem: "F(x)=x^3" });
    assert.equal(r.verification.checks[0].state, "verified"); assert.equal(r.verification.checks[0].definitionField, "input");
    const unbound = finalizeSolveCandidate(candidate("F'(x)=3*x^2", "1"), { problem: "Find a derivative." });
    assert.equal(unbound.verification.checks[0].state, "inconclusive");
  });
  it("links a final definite-integral value to input instead of provider problem text", () => {
    const r = candidate("1=1", "1/2"); r.problemLatex = String.raw`\int_0^1 1\,dx`;
    const assessment = assessSolveCandidate(r, { problem: String.raw`\int_0^1 x\,dx` });
    assert.equal(assessment.verification.checks.at(-1).state, "verified");
    assert.equal(assessment.verification.checks.at(-1).exactIntegral, "1/2");
  });
  it("links matching integral labels without treating arbitrary assignments as answers", () => {
    const problem = String.raw`I=\int_0^1 x\,dx`;
    const r = finalizeSolveCandidate(candidate("I=1/2", "I=1/2"), { problem });
    assert.equal(r.verification.checks.at(-1).state, "verified");
    const wrongLabel = finalizeSolveCandidate(candidate("J=1/2", "J=1/2"), { problem });
    assert.equal(wrongLabel.verification.checks.at(-1).state, "inconclusive");
  });
  it("preserves source assumptions and does not trust provider-created evidence", () => {
    const r = candidate("x/x=1", "1"); r.verification = { state: "verified" }; r.assumptions = [{ variable: "x", relation: "!=", value: "0" }];
    const out = finalizeSolveCandidate(r, { problem: "x/x" });
    assert.equal(out.verification.checks[0].state, "inconclusive"); assert.deepEqual(out.verification.input.assumptions, []);
  });
  it("retains trusted caller assumptions in every check", () => {
    const assumptions = [{ variable: "x", relation: "!=", value: "0" }];
    const r = finalizeSolveCandidate(candidate("x/x=1", "1"), { problem: "x/x", assumptions });
    assert.equal(r.verification.checks[0].state, "verified"); assert.deepEqual(r.verification.checks[0].assumptions, assumptions);
  });
  it("retains OCR display context even when canonical math omits prose assumptions", () => {
    const r = finalizeSolveCandidate(candidate(), { problem: "x^2=4", problemText: "Solve x^2=4 for positive real x." });
    assert.equal(r.verification.input.displayText, "Solve x^2=4 for positive real x.");
    assert.equal(r.verification.input.proseAssumptionsParsed, false);
  });
  it("adds metadata without editing steps or hidden provider usage", () => {
    const r = candidate(); const original = structuredClone(r); const steps = r.steps;
    Object.defineProperty(r, "_aiCallCount", { value: 1 });
    assert.equal(finalizeSolveCandidate(r, { problem: "x^2=4" }), r);
    assert.equal(r.steps, steps); assert.deepEqual(r.steps, original.steps); assert.equal(r._aiCallCount, 1);
    assert.doesNotThrow(() => JSON.stringify(r));
  });
  it("survives annotation, JSON, frontend normalization and reevaluation", () => {
    const r = finalizeSolveCandidate(candidate(), { problem: "x^2=4" });
    const normalized = normalizeSolveResponse(JSON.parse(JSON.stringify(annotateMathExplanation(r))));
    assert.deepEqual(normalized.verification, r.verification);
    const before = structuredClone(r.verification); finalizeSolveCandidate(r, { problem: "x^2=4" }); assert.deepEqual(r.verification, before);
  });
  it("image and fast schemas converge on identical mathematical checks", () => {
    const problem = String.raw`\int_0^1 x\,dx`;
    const fast = convertFastSolveToMathExplanation({ title: "Integral", problemLatex: problem, steps: [{ id: "step-1", heading: "Final answer", latex: "1/2", reasoning: "Evaluate.", anchors: [] }], finalAnswerLatex: "1/2", numericCheck: "" });
    const image = convertImageSolveToMathExplanation({ title: "Integral", extractedProblemLatex: problem, extractedProblemText: "Evaluate.", steps: [{ title: "Final answer", equationLatex: "1/2", explanation: "Evaluate.", tokens: [] }], finalAnswerLatex: "1/2", numericCheck: "" });
    const a = finalizeSolveCandidate(fast, { problem }); const b = finalizeSolveCandidate(image, { problem });
    assert.deepEqual(a.verification.checks, b.verification.checks);
  });
  it("records field budget truncation as inconclusive", () => {
    const r = candidate(); r.steps = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, math: "1=1" }));
    assert.equal(finalizeSolveCandidate(r).verification.checks.at(-1).reason, "candidate_field_budget_exceeded");
  });
});
