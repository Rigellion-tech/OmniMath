import assert from "node:assert/strict";
import test from "node:test";
import { validateGeneratedLatex } from "../server/generatedLatexValidation.js";
import {
  assertCompactSolveResponse,
  assertFastSolveResponse,
} from "../server/mathExplanationSchema.js";

const intervalRegression = "t \\in [0, \\frac{\\pi}{2})";

test("generated LaTeX validation accepts valid interval notation", () => {
  const validIntervals = [
    "[a,b]",
    "(a,b)",
    "[a,b)",
    "(a,b]",
    "[0,\\infty)",
    "(-\\infty,b]",
    intervalRegression,
    "\\left[0,\\frac{\\pi}{2}\\right)",
    "\\left(0,1\\right]",
    "\\bigl[0,1\\bigr)",
  ];

  for (const latex of validIntervals) {
    const result = validateGeneratedLatex(latex, { fieldPath: "test.latex" });
    assert.equal(result.valid, true, latex);
    assert.deepEqual(result.issues, [], latex);
  }
});

test("generated LaTeX validation accepts indexed operators with scoped variables", () => {
  const validIndexedOperators = [
    "\\sum_{n=1}^{\\infty}\\frac{1}{n^2}",
    "\\prod_{k=1}^{m}a_k",
    "\\sum_{n=1}^{\\infty}\\sum_{k=1}^{n}f(n,k)",
    "\\lim_{n\\to\\infty}\\frac{1}{n}",
  ];

  for (const latex of validIndexedOperators) {
    const result = validateGeneratedLatex(latex, { fieldPath: "test.latex" });
    assert.equal(result.valid, true, latex);
    assert.deepEqual(result.issues, [], latex);
  }
});

test("generated LaTeX validation still rejects malformed delimiters and command braces", () => {
  const invalidCases = [
    ["\\frac{\\pi}{2", "unmatched_braces"],
    ["(a+b", "unmatched_delimiters"],
    ["\\left(a+b", "unmatched_left_right"],
    ["a+b]", "unmatched_delimiters"],
    ["([a,b)]", "unmatched_delimiters"],
    ["[a+b)", "unmatched_delimiters"],
    ["[a,,b)", "unmatched_delimiters"],
  ];

  for (const [latex, issue] of invalidCases) {
    const result = validateGeneratedLatex(latex, { fieldPath: "test.latex" });
    assert.equal(result.valid, false, latex);
    assert.equal(result.issues.some((name) => name.includes(issue)), true, `${latex}: ${result.issues.join(",")}`);
  }
});

test("interval regression passes raw, compact, and full solve response validation", () => {
  const full = {
    title: "Interval regression",
    problemLatex: "\\int_0^\\infty f(x)\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Substitute",
        latex: intervalRegression,
        reasoning: "The tangent substitution maps the bounds to a half-open interval.",
        anchors: [],
      },
      {
        id: "s2",
        heading: "Final Answer",
        latex: "I=0",
        reasoning: "State a placeholder final value.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "0",
    numericCheck: "0",
  };

  const assertedFull = assertFastSolveResponse(full, full.problemLatex);
  assert.equal(assertedFull.steps[0].latex, intervalRegression);

  const compact = assertCompactSolveResponse({
    title: "Compact interval regression",
    problemLatex: full.problemLatex,
    steps: full.steps,
  }, full.problemLatex);
  assert.equal(compact.steps[0].latex, intervalRegression);
});
