import test from "node:test";
import assert from "node:assert/strict";
import { assessFinalAnswerPresentation, assessSolutionFinalAnswerPresentations, inspectFinalAnswerRows, normalizeFinalAnswerComparison,
  presentSolutionSteps } from "../src/lib/finalAnswerPresentation.js";
import { makePhase5KktFixture, makePhase5WideMatrixFixture, phase5KktResult,
  phase5KktDuplicatedFinal } from "./fixtures/phase5FinalAnswer.mjs";

const assess = (latex, steps = []) => assessFinalAnswerPresentation({ finalAnswerLatex: latex, steps });

test("row compaction declines TeX definitions and comments with cross-row effects", () => {
  for (const prefix of [String.raw`\def\answer{2}`, "% comment\n"]) {
    const latex = String.raw`\begin{aligned}` + prefix + String.raw`x&=1\\y&=2\end{aligned}`;
    assert.equal(inspectFinalAnswerRows(latex).splittable, false);
  }
});

test("KKT duplicated transcript is suppressed independently of authoritative mathematics", () => {
  const fixture = makePhase5KktFixture();
  const before = JSON.stringify(fixture);
  const plan = assessFinalAnswerPresentation(fixture);
  assert.equal(plan.action, "suppressed");
  assert.equal(plan.duplication.classification, "substantial_derivation");
  assert.equal(plan.duplication.removedRows, 6);
  const projected = presentSolutionSteps(fixture.steps, plan);
  assert.equal(projected.length, 6);
  assert.equal(projected.at(-1).latex, phase5KktResult);
  assert.equal(projected[2], fixture.steps[2]);
  assert.equal(JSON.stringify(fixture), before);
  assert.ok(plan.findings.some((finding) => finding.issue === "final_answer_contains_line_break_command"));
});

test("normal concise scalar/symbolic/vector/matrix/multipart/proof/domain results survive", () => {
  const cases = ["x=2", String.raw`x=\frac{a+b}{c}`, String.raw`v=\begin{bmatrix}1\\2\\3\end{bmatrix}`,
    String.raw`\begin{aligned}\text{(a)}\quad x&=1\\\text{(b)}\quad y&=2\\\text{(c)}\quad z&=3\\\text{(d)}\quad w&=4\\\text{(e)}\quad t&=5\end{aligned}`,
    String.raw`\text{The claim holds for every }n\ge1`,
    String.raw`x=\pm\sqrt{a},\quad a\ge0,\quad x\ne b`,
    String.raw`u\in H_0^1(\Omega),\quad -\Delta u=f\text{ weakly}`, String.raw`\text{No closed form; }x\text{ is the unique root in }(0,1)`];
  for (const latex of cases) {
    const steps = [{ id: "result", heading: "Obtain the result", latex }];
    const plan = assess(latex, steps);
    assert.equal(plan.action, "preserved", latex);
    assert.equal(plan.latex, latex);
    assert.equal(presentSolutionSteps(steps, plan), steps);
  }
  const matrix = assessFinalAnswerPresentation(makePhase5WideMatrixFixture());
  assert.equal(matrix.action, "preserved");
  assert.equal(matrix.size.classification, "structured_matrix_or_system");
});

test("several related equations and warnings remain complete, using local display policy", () => {
  const latex = String.raw`\begin{aligned}x&=1\\y&=2\\x+y&=3\end{aligned}`;
  const warnings = [{ fieldPath: "finalAnswerLatex", warnings: ["final_answer_contains_line_break_command",
    "final_answer_contains_multiple_unrelated_equations", "final_answer_contains_multiple_physical_lines",
    "final_answer_contains_prose", "final_answer_contains_derivation_arrow",
    "final_answer_splits_into_multiple_unrelated_fragments"], issues: [] }];
  const plan = assessFinalAnswerPresentation({ finalAnswerLatex: latex }, { validationFindings: warnings });
  assert.equal(plan.action, "preserved");
  assert.equal(plan.latex, latex);
  assert.equal(plan.overflow, "local_math_block");
  assert.ok(plan.findings.every((finding) => finding.classification));
});

test("format comparison handles wrappers/spacing but never symbolic or text equivalence", () => {
  assert.equal(normalizeFinalAnswerComparison(String.raw`\[ x &= \dfrac{1}{2}\quad \]`), normalizeFinalAnswerComparison(String.raw`x=\tfrac{1}{2}`));
  assert.notEqual(normalizeFinalAnswerComparison("x+x"), normalizeFinalAnswerComparison("2x"));
  assert.notEqual(normalizeFinalAnswerComparison(String.raw`x\text{ when a b}`), normalizeFinalAnswerComparison(String.raw`x\text{ when ab}`));
  const fixture = makePhase5KktFixture();
  fixture.finalAnswerLatex = String.raw`\[` + phase5KktDuplicatedFinal.replace(/=0/gu, " = 0").replace(/\\quad/gu, "\\qquad") + String.raw`\]`;
  fixture.steps.at(-1).latex = fixture.finalAnswerLatex;
  assert.equal(assessFinalAnswerPresentation(fixture).action, "suppressed");
});

test("nested systems and matrix rows are indivisible inside outer aligned", () => {
  const rows = inspectFinalAnswerRows(String.raw`\begin{aligned}A&=\begin{bmatrix}a&b\\c&d\end{bmatrix}\\x&=\begin{cases}1&t>0\\0&t\le0\end{cases}\end{aligned}`);
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.malformed, false);
  assert.equal(inspectFinalAnswerRows(String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`).rows.length, 1);
  assert.equal(inspectFinalAnswerRows(String.raw`\begin{aligned}a&=1\\[2pt]b&=2\end{aligned}`).splittable, false);
  assert.equal(inspectFinalAnswerRows(String.raw`\begin{aligned}a&=1\\[2pt]b&=2\end{aligned}`).malformed, false);
});

test("compaction preserves novel domain/branch/residual assumptions and clears old owners", () => {
  const fixture = makePhase5KktFixture();
  const caveat = String.raw`\text{Assume }a>0,\quad x\in\{\sqrt a,-\sqrt a\},\quad r_s\ne0`;
  fixture.finalAnswerLatex = phase5KktDuplicatedFinal;
  // Add the caveat at the outer closing environment, never a nested row.
  fixture.finalAnswerLatex = fixture.finalAnswerLatex.slice(0, -String.raw`\end{aligned}`.length) + String.raw`\\` + caveat + String.raw`\end{aligned}`;
  Object.assign(fixture.steps.at(-1), { latex: fixture.finalAnswerLatex, chunks: [{ id: "stale-owner" }], tokens: [{ id: "stale-token" }], lines: [{ id: "old-line" }], semanticTree: { id: "old" }, reasoning: "This is one Newton iterate, not a converged optimum." });
  const plan = assessFinalAnswerPresentation(fixture);
  assert.equal(plan.action, "compacted");
  assert.ok(plan.latex.includes(caveat));
  assert.ok(plan.latex.includes(phase5KktResult));
  assert.ok(!plan.latex.includes("\\mathcal L"));
  const projected = presentSolutionSteps(fixture.steps, plan);
  assert.equal(projected.at(-1).id, fixture.steps.at(-1).id);
  assert.deepEqual(projected.at(-1).chunks, []);
  assert.deepEqual(projected.at(-1).tokens, []);
  assert.equal(projected.at(-1).lines.length, 1);
  assert.equal(projected.at(-1).lines[0].latex, plan.latex);
  assert.deepEqual(projected.at(-1).lines[0].tokens, []);
  assert.notEqual(projected.at(-1).lines[0].id, "old-line");
  assert.equal(projected.at(-1).semanticTree, null);
  assert.equal(projected.at(-1).reasoning, "This is one Newton iterate, not a converged optimum.");
});

test("two substantial repeated steps are detected without flagging a concise last result", () => {
  const fixture = makePhase5KktFixture();
  const rows = [fixture.steps[2].latex, fixture.steps[3].latex];
  fixture.finalAnswerLatex = String.raw`\begin{aligned}` + rows.join(String.raw`\\`) + String.raw`\end{aligned}`;
  fixture.steps.at(-1).latex = fixture.finalAnswerLatex;
  const plan = assessFinalAnswerPresentation(fixture);
  assert.equal(plan.action, "suppressed");
  assert.equal(plan.duplication.matchedStepIds.length, 2);
});

test("one giant nonterminal intermediate uses disclosure fallback without deleting math", () => {
  const giant = phase5KktDuplicatedFinal;
  const steps = [{ id: "system", heading: "Construct the intermediate system", latex: giant },
    { id: "result", heading: "Conclude", latex: "x=1" },
    { id: "final", heading: "Final Answer", latex: giant }];
  const plan = assess(giant, steps);
  assert.equal(plan.action, "fallback");
  assert.equal(plan.duplication.classification, "giant_intermediate_copy");
  assert.equal(plan.originalRetained, true);
  assert.equal(plan.latex, giant);
  assert.equal(presentSolutionSteps(steps, plan).length, 2);
});

test("unstructured transcript is disclosed rather than rewritten by regex", () => {
  const fixture = makePhase5KktFixture();
  const raw = fixture.steps.slice(0, 6).map((step) => step.latex).join(String.raw`\quad`);
  const plan = assess(raw, fixture.steps.slice(0, 6));
  assert.equal(plan.action, "fallback");
  assert.equal(plan.latex, raw);
  assert.equal(plan.originalRetained, true);
});

test("malformed, absent and detached fields have explicit non-provider fallbacks", () => {
  assert.equal(assess(String.raw`x=\frac{1}{`).reason, "malformed_final_answer");
  assert.equal(assess("").reason, "absent_final_answer");
  const detached = assessFinalAnswerPresentation({ finalAnswerLatex: "x=1,a" }, {
    validationFindings: ["finalAnswerLatex:detached_final_answer_fragment"],
  });
  assert.equal(detached.reason, "detached_result_fragment");
  const invalid = assessFinalAnswerPresentation({ finalAnswerLatex: "x=1" }, {
    validationFindings: [{ fieldPath: "finalAnswerLatex", warnings: [], issues: ["katex_parse_failed:1:bad"] }],
  });
  assert.equal(invalid.reason, "malformed_final_answer");
});

test("ordinary and progressive final-card publication use identical projection without role guesses", () => {
  const ordinary = makePhase5KktFixture();
  const progressive = { steps: ordinary.steps };
  const a = assessFinalAnswerPresentation(ordinary);
  const b = assessFinalAnswerPresentation(progressive);
  assert.equal(a.action, b.action);
  assert.equal(a.latex, b.latex);
  assert.deepEqual(presentSolutionSteps(ordinary.steps, a), presentSolutionSteps(progressive.steps, b));
  const concise = [{ id: "final-but-derivation", label: "Evaluate the system", latex: "x=1", role: "final", lines: [{ role: "final_answer" }] }];
  const plan = assess("x=1", concise);
  assert.deepEqual(plan.finalStepIds, []);
  assert.equal(presentSolutionSteps(concise, plan), concise);
});

test("suppression retains unique final prose qualifications for display", () => {
  const fixture = makePhase5KktFixture();
  fixture.steps.at(-1).reasoning = "Only one Newton iterate is claimed; stationarity has not converged.";
  const plan = assessFinalAnswerPresentation(fixture);
  assert.equal(plan.action, "suppressed");
  assert.ok(plan.retainedFinalText.some((entry) => entry.text === fixture.steps.at(-1).reasoning));
});

test("suppression retains standalone final text-line branches while avoiding repeated derivation prose", () => {
  const fixture = makePhase5KktFixture();
  const sharedText = "The equality constraint residual is zero.";
  const branchText = "For the positive branch only, assume a>0; the Newton step is not a converged optimum.";
  fixture.steps[5].lines = [{ id: "result-caveat", kind: "text", text: sharedText, tokens: [] }];
  fixture.steps.at(-1).lines = [
    { id: "final-shared-caveat", kind: "text", text: ` ${sharedText} `, tokens: [] },
    { id: "final-branch", kind: "text", text: branchText, tokens: [{ id: "stale-prose-token" }] },
    { id: "final-branch-again", kind: "text", text: branchText, tokens: [] },
  ];
  const before = JSON.stringify(fixture);
  const plan = assessFinalAnswerPresentation(fixture);
  assert.equal(plan.action, "suppressed");
  assert.equal(plan.retainedFinalText.filter(({ text }) => text === branchText).length, 1);
  assert.equal(plan.retainedFinalText.some(({ text }) => text === sharedText), false);
  assert.equal(JSON.stringify(plan.retainedFinalText).includes("stale-prose-token"), false);
  assert.equal(presentSolutionSteps(fixture.steps, plan).some(({ id }) => id === "final-answer"), false);
  assert.equal(JSON.stringify(fixture), before);
});

test("compaction rebuilds fresh math/text lines while preserving standalone branch caveats", () => {
  const fixture = makePhase5KktFixture();
  fixture.finalAnswerLatex = fixture.finalAnswerLatex.slice(0, -String.raw`\end{aligned}`.length)
    + String.raw`\\\text{One iterate only}\end{aligned}`;
  const branchText = "Assume the positive branch a>0; stationarity is not asserted.";
  Object.assign(fixture.steps.at(-1), { latex: fixture.finalAnswerLatex, lines: [
    { id: "old-math", kind: "math", latex: "stale", tokens: [{ id: "stale-owner" }] },
    { id: "old-branch", kind: "text", text: branchText, tokens: [{ id: "stale-prose" }] },
  ] });
  const before = JSON.stringify(fixture);
  const plan = assessFinalAnswerPresentation(fixture);
  assert.equal(plan.action, "compacted");
  const projected = presentSolutionSteps(fixture.steps, plan).at(-1);
  assert.equal(projected.lines.length, 2);
  assert.equal(projected.lines[0].latex, plan.latex);
  assert.equal(projected.lines[1].text, branchText);
  assert.deepEqual(projected.lines.map(({ tokens }) => tokens), [[], []]);
  assert.equal(JSON.stringify(projected.lines).includes("stale"), false);
  assert.equal(JSON.stringify(projected.lines).includes("old-branch"), false);
  assert.equal(JSON.stringify(fixture), before);
  assert.deepEqual(projected.lines, presentSolutionSteps(fixture.steps, plan).at(-1).lines);
});

test("a concise declared field cannot conceal a duplicate final-card transcript", () => {
  const fixture = makePhase5KktFixture();
  fixture.finalAnswerLatex = phase5KktResult;
  const plans = assessSolutionFinalAnswerPresentations(fixture);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].action, "preserved");
  assert.equal(plans[1].action, "suppressed");
  const projected = plans.reduce((steps, plan) => presentSolutionSteps(steps, plan), fixture.steps);
  assert.equal(projected.length, 6);
  assert.equal(projected.at(-1).latex, phase5KktResult);
});

test("long derivation-arrow sequence gets safe disclosure; short proof implication survives", () => {
  const long = "f(x)=" + Array.from({ length: 40 }, (_, index) => `a_${index}x^${index}`).join("+")
    + String.raw`\Rightarrow f'(x)=0\Rightarrow x=1`;
  assert.equal(assess(long).action, "fallback");
  assert.equal(assess(long).latex, long);
  assert.equal(assess(String.raw`x>1\Rightarrow x^2>1`).action, "preserved");
});

test("matrix cell separators carry mathematical identity through duplicate comparison", () => {
  const a = String.raw`A=\begin{bmatrix}1&23\\4&56\end{bmatrix}`;
  const b = String.raw`A=\begin{bmatrix}12&3\\45&6\end{bmatrix}`;
  assert.notEqual(normalizeFinalAnswerComparison(a), normalizeFinalAnswerComparison(b));
  const fixture = makePhase5KktFixture();
  fixture.steps[3].latex = fixture.steps[3].latex.replace("12&0", "1&20");
  const plan = assessFinalAnswerPresentation(fixture);
  assert.equal(plan.action, "compacted");
  assert.ok(plan.latex.includes("12&0"));
});

test("field-only novel results become a fresh stable summary while shared result stays unduplicated", () => {
  const steps = [{ id: "derive", heading: "Compute", latex: "x+1=3" }];
  const plan = assess("x=2", steps);
  assert.equal(plan.summaryRequired, true);
  const projected = presentSolutionSteps(steps, plan);
  assert.equal(projected.length, 2);
  assert.equal(projected.at(-1).latex, "x=2");
  assert.equal(projected.at(-1).id, presentSolutionSteps(steps, plan).at(-1).id);
  assert.equal(steps.length, 1);
  const shared = [{ id: "result", heading: "Compute", latex: "x=2" }];
  assert.equal(assess("x=2", shared).summaryRequired, false);
  assert.equal(presentSolutionSteps(shared, assess("x=2", shared)), shared);
});

test("compacted field-only novel qualifications are visible and assessed once", () => {
  const fixture = makePhase5KktFixture({ includeFinalStep: false });
  fixture.finalAnswerLatex = fixture.finalAnswerLatex.slice(0, -String.raw`\end{aligned}`.length) + String.raw`\\\text{Only one Newton iterate}\end{aligned}`;
  const plans = assessSolutionFinalAnswerPresentations(fixture);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].action, "compacted");
  assert.equal(plans[0].summaryRequired, true);
  const projected = presentSolutionSteps(fixture.steps, plans[0]);
  assert.ok(projected.at(-1).latex.includes("Only one Newton iterate"));
  const headed = makePhase5KktFixture();
  headed.finalAnswerLatex = fixture.finalAnswerLatex;
  headed.steps.at(-1).latex = fixture.finalAnswerLatex;
  assert.equal(assessSolutionFinalAnswerPresentations(headed).length, 1);
});

test("control-word boundaries and nested operator/text bodies cannot merge into false duplicates", () => {
  assert.notEqual(normalizeFinalAnswerComparison(String.raw`\sin h`), normalizeFinalAnswerComparison(String.raw`\sinh`));
  assert.equal(normalizeFinalAnswerComparison(String.raw`\sin h`), normalizeFinalAnswerComparison(String.raw`\sin\,h`));
  assert.notEqual(normalizeFinalAnswerComparison(String.raw`\alpha b`), normalizeFinalAnswerComparison(String.raw`\alphab`));
  assert.notEqual(normalizeFinalAnswerComparison(String.raw`\operatorname{a b}(x)`), normalizeFinalAnswerComparison(String.raw`\operatorname{ab}(x)`));
  assert.notEqual(normalizeFinalAnswerComparison(String.raw`x\text{ if {a b}>0}`), normalizeFinalAnswerComparison(String.raw`x\text{ if {ab}>0}`));
  assert.ok(normalizeFinalAnswerComparison(String.raw`x\text{ if {a b}>0}`).includes("{a b}"));
});
