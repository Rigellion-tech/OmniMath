import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessSolveCandidate, finalizeSolveCandidate } from "../server/solveCandidateLifecycle.js";
import { decideAssuranceRecovery, finalizeAssuranceSelection, selectAssuranceCandidate } from "../server/mathAssurancePolicy.js";
import { assuranceCorpus } from "./fixtures/assuranceCorpus.mjs";

describe("bounded mathematical assurance corpus", () => {
  for (const fixture of assuranceCorpus) it(fixture.name, () => {
    const result = finalizeSolveCandidate(structuredClone(fixture.candidate), {
      problem: fixture.problem, candidateId: fixture.name, routeAttemptId: "route:1",
    });
    assert.equal(result.candidateAcceptance.accepted, true);
    assert.equal(result.assurance.status, fixture.expected.status);
    assert.equal(result.assurance.summary.solutionCorrectness, "not_established");
    assert.equal(result.assurance.candidateId, fixture.name);
    assert.ok(result.assurance.checks.every((check) => check.candidateId === fixture.name
      && check.verificationAttemptId === `${fixture.name}:verification:1`));
    const decision = decideAssuranceRecovery({ assurance: result.assurance,
      routeAttemptCount: 1, deadlineRemaining: true, escalationAvailable: true });
    assert.equal(decision.action, fixture.expected.recoveryBehavior === "one_shared_route_if_available"
      ? "escalate" : "present");
    if (["deterministic_contradiction", "deterministic_internal_contradiction"]
      .includes(fixture.expected.evidence)) {
      assert.ok(result.assurance.findings.some((finding) => finding.classification
        === "deterministic_supported_check" && finding.applicability === fixture.expected.applicability));
    } else if (fixture.expected.evidence === "deterministic_input_linked_final_pass") {
      assert.ok(result.assurance.checks.some((check) => check.scope === "input_linked"
        && check.fieldPath.startsWith("finalAnswer") && check.outcome === "passed"
        && check.applicability === fixture.expected.applicability));
    } else {
      assert.equal(result.assurance.summary.inputLinkedFinalPass, false);
    }
  });
});

describe("assurance decision and applicability", () => {
  const candidate = (step, final) => ({ title: "Claim", steps: [{ id: "s", math: step,
    summary: "A mathematical step." }], finalAnswerLatex: final });
  it("keeps structure, assurance and recovery independent", () => {
    assert.equal(assessSolveCandidate({ steps: [] }).assurance, null);
    const correct = finalizeSolveCandidate(candidate("x^2=4", "x=2"), { problem: "x^2=4" });
    const wrong = finalizeSolveCandidate(candidate("x^2=4", "x=3"), { problem: "x^2=4" });
    assert.equal(correct.assurance.status, "supported_checks_passed");
    assert.equal(wrong.candidateAcceptance.accepted, true);
    assert.equal(decideAssuranceRecovery({ assurance: wrong.assurance, routeAttemptCount: 1,
      deadlineRemaining: true, escalationAvailable: true }).action, "escalate");
    assert.equal(decideAssuranceRecovery({ assurance: wrong.assurance, routeAttemptCount: 2,
      deadlineRemaining: true, escalationAvailable: true }).action, "present_unresolved");
  });
  it("does not elevate incidental true equalities or provider definitions", () => {
    const incidental = finalizeSolveCandidate(candidate("1=1", "x"), { problem: "Find x." });
    assert.equal(incidental.assurance.status, "inconclusive");
    const internal = finalizeSolveCandidate(candidate("F(x)=x^3", "F'(x)=3*x^2"),
      { problem: "Discuss a function." });
    assert.notEqual(internal.assurance.status, "supported_checks_passed");
  });
  it("keeps numerical disagreement heuristic and ignores it for recovery", () => {
    const result = finalizeSolveCandidate(candidate("1=1", "sin(1)=2"), { problem: "Estimate a sine." });
    const numerical = result.assurance.checks.find((check) => check.classification === "heuristic_warning");
    assert.ok(numerical);
    assert.notEqual(result.assurance.status, "contradiction_detected");
  });
  it("does not promote an uncertified comparison after exact polynomial integration", () => {
    const numericalClaim = finalizeSolveCandidate(candidate("1=1", "sin(1)"), {
      problem: String.raw`\int_0^1 x\,dx`,
    });
    assert.equal(numericalClaim.verification.checks.at(-1).method, "exact_polynomial_integration");
    assert.equal(numericalClaim.verification.checks.at(-1).comparisonMethod, "numerical_counterexample");
    assert.equal(numericalClaim.assurance.checks.at(-1).classification, "heuristic_warning");
    assert.notEqual(numericalClaim.assurance.status, "contradiction_detected");
    assert.equal(decideAssuranceRecovery({ assurance: numericalClaim.assurance,
      routeAttemptCount: 1, deadlineRemaining: true, escalationAvailable: true }).action, "present");

    const exactWrong = finalizeSolveCandidate(candidate("1=1", "3/4"), {
      problem: String.raw`\int_0^1 x\,dx`,
    });
    assert.equal(exactWrong.verification.checks.at(-1).comparisonMethod, "exact_rational_evaluation");
    assert.equal(exactWrong.assurance.status, "contradiction_detected");
  });
  it("guards unparsed restrictions and trusted assumptions", () => {
    const restricted = finalizeSolveCandidate(candidate("x^2=4", "x=3"), {
      problem: "x^2=4", problemText: "Solve x^2=4 under a stated branch condition.",
    });
    assert.notEqual(restricted.assurance.status, "contradiction_detected");
    const providerCondition = candidate("x^2=4", "x=3");
    providerCondition.conditions = "under a branch condition";
    assert.notEqual(finalizeSolveCandidate(providerCondition, { problem: "x^2=4" }).assurance.status,
      "contradiction_detected");
    const correctButConditional = candidate("x^2=4", "x=2");
    correctButConditional.conditions = "x>0";
    assert.equal(finalizeSolveCandidate(correctButConditional, { problem: "x^2=4" }).assurance.status,
      "inconclusive");
  });
  it("ranks evidence and retains earlier candidate on ties or repeated contradiction", () => {
    const one = finalizeSolveCandidate(candidate("1=1", "x=3"),
      { problem: "x^2=4", candidateId: "one", routeAttemptId: "route:1" });
    const two = finalizeSolveCandidate(candidate("1=1", "x=5"),
      { problem: "x^2=4", candidateId: "two", routeAttemptId: "route:2" });
    const items = [one, two].map((result) => ({ result, assurance: result.assurance }));
    const selected = selectAssuranceCandidate(items);
    assert.equal(selected.result, one);
    finalizeAssuranceSelection(selected, items, true);
    assert.equal(one.assurance.unresolvedContradiction, true);
    assert.deepEqual(one.assurance.history.map((entry) => entry.candidateId), ["one", "two"]);
  });
  it("detects targeted exact scalar mutations while leaving matrix mutations inconclusive", () => {
    const mutations = [
      { problem: "F(x)=x^3", final: "F'(x)=-3*x^2", mutation: "sign" },
      { problem: "F(x)=x^3", final: "F'(x)=2*x^2", mutation: "coefficient" },
      { problem: "F(x)=x^3", final: "F'(x)=3*x^3", mutation: "exponent" },
      { problem: String.raw`\int_0^2 x\,dx`, final: "1/2", mutation: "bound" },
      { problem: "x^2=4", final: "x=3", mutation: "final numeric" },
    ];
    for (const mutation of mutations) {
      const result = finalizeSolveCandidate(candidate("1=1", mutation.final),
        { problem: mutation.problem });
      assert.equal(result.assurance.status, "contradiction_detected", mutation.mutation);
    }
    const matrix = finalizeSolveCandidate(candidate(
      String.raw`A=\begin{pmatrix}1&0\\0&1\end{pmatrix}`,
      String.raw`A=\begin{pmatrix}1&0\\0&2\end{pmatrix}`),
      { problem: "Solve Ax=b" });
    assert.equal(matrix.assurance.status, "inconclusive");
  });
  it("does not turn equivalent forms, branches, or related systems into contradictions", () => {
    const derivativeForms = [
      "x^2+2*x^2", "2*x^2+x^2", "x^2+x^2+x^2", "x*(x+x+x)", "x*x*3",
      String.raw`3x^{2}`,
    ];
    for (const form of derivativeForms) {
      const result = finalizeSolveCandidate(candidate(`F'(x)=${form}`, `F'(x)=${form}`),
        { problem: "F(x)=x^3" });
      assert.notEqual(result.assurance.status, "contradiction_detected", form);
    }
    for (const branch of ["x=2", "x=-2"]) {
      const result = finalizeSolveCandidate(candidate("x^2=4", branch), { problem: "x^2=4" });
      assert.notEqual(result.assurance.status, "contradiction_detected", branch);
    }
    const related = finalizeSolveCandidate(candidate("x+y=2", "x-y=0"),
      { problem: "Solve the system x+y=2, x-y=0" });
    assert.notEqual(related.assurance.status, "contradiction_detected");
  });
});
