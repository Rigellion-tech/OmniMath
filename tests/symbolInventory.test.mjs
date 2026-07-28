import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectGeneratedMath } from "../server/generatedMathCollector.js";
import { analyzeSubstitutionConsistency } from "../server/mathValidationAnalysis.js";
import { analyzeSymbolOrigins } from "../server/symbolInventory.js";
import { validateSolutionQuality } from "../server/solutionValidation.js";

const regressionIntegralProblem = "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx";

function solution(finalAnswerLatex, steps = []) {
  return {
    title: "Symbol test",
    expression: "x^2",
    finalAnswerLatex,
    finalAnswer: finalAnswerLatex,
    steps,
  };
}

describe("symbol origin diagnostics", () => {
  it("treats summation indices as locally bound only within generated math fields", () => {
    const result = solution("\\sum_{n=1}^{\\infty}\\frac{1}{n^2}", [
      { math: "\\sum_{n=1}^{\\infty}\\frac{1}{n^2}", summary: "Use a convergent series." },
    ]);
    const analysis = analyzeSymbolOrigins("Evaluate the series.", result);

    assert.equal(analysis.unexplainedSymbols.includes("n"), false);
    assert.ok(analysis.boundSymbolProvenance.some((binding) => (
      binding.command === "sum" && binding.symbol === "n" && binding.fieldPath === "steps[0].math"
    )));
  });

  it("binds product indices without accepting free upper-limit or coefficient symbols", () => {
    const analysis = analyzeSymbolOrigins("Evaluate the product.", solution("P", [
      { math: "\\prod_{k=1}^{m} a_k", summary: "Use indexed product notation." },
    ]));

    assert.equal(analysis.unexplainedSymbols.includes("k"), false);
    assert.ok(analysis.unexplainedSymbols.includes("m"));
    assert.ok(analysis.unexplainedSymbols.includes("a"));
  });

  it("accepts product notation when non-index symbols are already part of the problem", () => {
    const analysis = analyzeSymbolOrigins("a,m", solution("P", [
      { math: "\\prod_{k=1}^{m} a_k", summary: "Use indexed product notation." },
    ]));

    assert.equal(analysis.unexplainedSymbols.includes("k"), false);
    assert.equal(analysis.unexplainedSymbols.includes("m"), false);
    assert.equal(analysis.unexplainedSymbols.includes("a"), false);
  });

  it("handles nested summations with different locally bound indices", () => {
    const nested = "\\sum_{n=1}^{\\infty}\\sum_{k=1}^{n} f(n,k)";
    const analysis = analyzeSymbolOrigins("f", solution(nested, [
      { math: nested, summary: "Use nested sums." },
    ]));

    assert.equal(analysis.unexplainedSymbols.includes("n"), false);
    assert.equal(analysis.unexplainedSymbols.includes("k"), false);
    assert.equal(analysis.boundSymbolProvenance.filter((binding) => binding.symbol === "n").length > 0, true);
    assert.equal(analysis.boundSymbolProvenance.filter((binding) => binding.symbol === "k").length > 0, true);
  });

  it("still rejects the same index symbol when it is reused outside a bound field", () => {
    const analysis = analyzeSymbolOrigins("Evaluate the series.", solution("0", [
      { math: "\\sum_{n=1}^{\\infty}\\frac{1}{n^2}", summary: "Use a bound summation index." },
      { math: "2n+1=3", summary: "Reuse the index as a free later equation." },
    ]));

    assert.ok(analysis.fieldReports.some((field) => (
      field.fieldPath === "steps[1].math" && field.unexplainedSymbols.includes("n")
    )));
    assert.ok(analysis.unexplainedSymbols.includes("n"));
  });

  it("does not tokenize ordinary English prose as generated math symbols", () => {
    const result = solution("1", [
      {
        label: "Now simplify",
        title: "No new notation",
        summary: "An ordinary sentence contains the letter n many times.",
        plainExplanation: "Nothing in this prose is an inline math fragment.",
        math: "1",
      },
    ]);
    const collected = collectGeneratedMath(result);
    const analysis = analyzeSymbolOrigins("Evaluate 1.", result);

    assert.equal(collected.some((field) => /label|title|summary|plainExplanation/u.test(field.fieldPath)), false);
    assert.equal(analysis.unexplainedSymbols.includes("n"), false);
  });

  it("collects prose fields only when they contain confident inline math fragments", () => {
    const result = solution("1", [
      {
        label: "Use \\(\\sum_{n=1}^{\\infty}\\frac{1}{n^2}\\)",
        title: "Series step",
        summary: "The inline math \\(\\sum_{n=1}^{\\infty}\\frac{1}{n^2}\\) binds n.",
        plainExplanation: "Ordinary prose after the math does not add variables.",
        math: "1",
      },
    ]);
    const collected = collectGeneratedMath(result);
    const analysis = analyzeSymbolOrigins("Evaluate 1.", result);

    assert.ok(collected.some((field) => field.fieldPath === "steps[0].label"));
    assert.ok(collected.some((field) => field.fieldPath === "steps[0].summary"));
    assert.equal(analysis.unexplainedSymbols.includes("n"), false);
  });

  it("lets presentation fragments inherit same-step summation bindings without defining coefficients", () => {
    const result = solution("0.754693", [
      {
        math: "\\ln(\\cos \\theta)=-\\sum_{n=1}^{\\infty}\\frac{(2^{2n}-1)|B_{2n}|}{2n(2n)!}(2\\theta)^{2n}",
        summary: "Use Bernoulli numbers \\(B_{2n}\\) in the displayed series.",
        lines: [
          { latex: "\\ln(\\cos \\theta)=-\\sum_{n=1}^{\\infty}" },
          { latex: "\\frac{(2^{2n}-1)|B_{2n}|}{2n(2n)!}(2\\theta)^{2n}" },
        ],
      },
    ]);
    const analysis = analyzeSymbolOrigins(regressionIntegralProblem, result);

    assert.equal(analysis.unexplainedSymbols.includes("n"), false);
    assert.equal(analysis.unexplainedSymbols.includes("B"), true);
    assert.ok(analysis.fieldReports.some((field) => (
      field.fieldPath === "steps[0].summary"
      && field.symbols.some((item) => item.symbol === "n" && item.classification === "bound_by_step_math_context")
    )));
    assert.ok(analysis.fieldReports.some((field) => (
      field.fieldPath === "steps[0].lines[1].latex"
      && field.symbols.some((item) => item.symbol === "n" && item.classification === "bound_by_step_math_context")
    )));
  });

  it("does not let a previous summation binding explain a later isolated subscript", () => {
    const result = solution("0", [
      {
        math: "\\sum_{n=1}^{\\infty}\\frac{1}{n^2}",
        summary: "Use a bound index.",
      },
      {
        summary: "Later mention \\(B_{2n}\\) without a local summation context.",
        math: "1",
      },
    ]);
    const analysis = analyzeSymbolOrigins("Evaluate a series.", result);

    assert.equal(analysis.unexplainedSymbols.includes("n"), true);
    assert.equal(analysis.unexplainedSymbols.includes("B"), true);
  });

  it("still accepts a plain integration constant C", () => {
    const finalAnswerLatex = "\\int x\\,dx=\\frac{x^2}{2}+C";
    const analysis = analyzeSymbolOrigins("\\int x\\,dx", solution(finalAnswerLatex, [
      { math: finalAnswerLatex, summary: "State the antiderivative." },
    ]));

    assert.equal(analysis.unexplainedSymbols.includes("C"), false);
  });

  it("rejects indexed coefficient families that use C without introduction", () => {
    const result = solution("\\sum_{k=1}^{\\infty} C_k", [
      { math: "\\sum_{k=1}^{\\infty} C_k", summary: "Use an unspecified coefficient family." },
    ]);
    const analysis = analyzeSymbolOrigins("Evaluate a series.", result);

    assert.equal(analysis.unexplainedSymbols.includes("k"), false);
    assert.equal(analysis.unexplainedSymbols.includes("C"), true);
  });

  it("classifies legitimate dummy variables as locally bound", () => {
    const result = solution("\\int_0^1 t^2\\,dt", [
      { math: "\\int_0^1 t^2\\,dt", summary: "Use a dummy variable." },
    ]);
    const analysis = analyzeSymbolOrigins("\\int_0^1 x^2\\,dx", result);

    assert.equal(analysis.unexplainedSymbols.includes("t"), false);
    assert.ok(analysis.fieldReports.some((field) => (
      field.symbols.some((item) => item.symbol === "t" && item.classification === "bound_locally")
    )));
  });

  it("classifies legitimate substitution variables as explicitly introduced", () => {
    const result = solution("u^2+1", [
      { math: "u=\\sin x", summary: "Define the substitution." },
      { math: "u^2+1", summary: "Rewrite using the substitution." },
    ]);
    const analysis = analyzeSymbolOrigins("\\sin^2 x+1", result);

    assert.equal(analysis.unexplainedSymbols.includes("u"), false);
    assert.ok(analysis.explicitDefinitions.includes("u"));
  });

  it("classifies tangent-substitution theta as introduced before later use", () => {
    const result = solution("\\frac{\\pi}{2}\\ln^2 2", [
      { math: "x=\\tan\\theta", summary: "Introduce the substitution variable." },
      { math: "I=-2\\int_0^{\\pi/2}\\theta\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta", summary: "Rewrite using theta." },
      { math: "\\frac{\\pi}{2}\\ln^2 2", summary: "State the value." },
    ]);
    const analysis = analyzeSymbolOrigins(regressionIntegralProblem, result);

    assert.equal(analysis.unexplainedSymbols.includes("\\theta"), false);
    assert.ok(analysis.explicitDefinitions.includes("\\theta"));
  });

  it("binds tangent-substitution theta from every generated math field layout", () => {
    const problem = regressionIntegralProblem;
    const fieldLayouts = [
      { name: "math", step: { math: "x=\\tan\\theta" } },
      { name: "latex", step: { latex: "x=\\tan\\theta" } },
      { name: "equationLatex", step: { equationLatex: "x=\\tan\\theta" } },
      { name: "lines[].latex", step: { lines: [{ latex: "x=\\tan\\theta" }] } },
    ];

    for (const { name, step } of fieldLayouts) {
      const result = solution("\\frac{\\pi}{2}\\ln^2 2", [
        step,
        { math: "-\\ln(\\cos\\theta)=\\sum_{n=1}^\\infty\\frac{(\\sin\\theta)^{2n}}{2n}", summary: "Use theta after the substitution." },
        { math: "I=\\frac{\\pi}{2}\\ln^2 2", summary: "State the checked value." },
      ]);
      const analysis = analyzeSymbolOrigins(problem, result);

      assert.equal(analysis.unexplainedSymbols.includes("\\theta"), false, name);
      assert.ok(analysis.explicitDefinitions.includes("\\theta"), name);
    }
  });

  it("treats a visible heading-only tangent substitution as a generated math definition", () => {
    const result = solution("\\frac{\\pi}{2}\\ln^2 2", [
      {
        heading: "Substitution x = tanθ",
        math: "I=\\int_0^{\\pi/2}\\frac{\\ln(\\sec^2\\theta)\\theta}{\\tan\\theta}\\,d\\theta",
        summary: "The visible heading introduces theta, but the generated math field only uses it.",
      },
      {
        math: "-\\ln(\\cos\\theta)=\\sum_{n=1}^\\infty\\frac{(\\sin\\theta)^{2n}}{2n}",
        summary: "A later split line uses theta without a local differential.",
      },
    ]);
    const analysis = analyzeSymbolOrigins(regressionIntegralProblem, result);

    assert.equal(analysis.unexplainedSymbols.includes("\\theta"), false);
    assert.equal(analysis.fieldReports.some((field) => field.fieldPath === "steps[0].heading"), true);
    assert.ok(analysis.explicitDefinitions.includes("\\theta"));
  });

  it("rejects theta when it is used before the substitution introduces it", () => {
    const result = solution("\\frac{\\pi}{2}\\ln^2 2", [
      { math: "I=\\theta+1", summary: "Use theta too early." },
      { math: "x=\\tan\\theta", summary: "Introduce the substitution variable later." },
      { math: "\\frac{\\pi}{2}\\ln^2 2", summary: "State the value." },
    ]);
    const analysis = analyzeSymbolOrigins(regressionIntegralProblem, result);

    assert.ok(analysis.fieldReports[0].unexplainedSymbols.includes("\\theta"));
    assert.ok(analysis.unexplainedSymbols.includes("\\theta"));
  });

  it("shares heading tangent-substitution math across symbol and substitution validators", () => {
    const result = solution("\\frac{\\pi}{2}\\ln^2 2", [
      {
        heading: "Substitution x = tanθ",
        math: "I=-2\\int_0^{\\pi/2}\\frac{\\theta\\ln(\\cos\\theta)}{\\tan\\theta}\\,d\\theta",
        summary: "Rewrite the integral after the substitution.",
      },
    ]);
    const collected = collectGeneratedMath(result);
    const collectedPaths = collected.map((field) => field.fieldPath);
    const symbolAnalysis = analyzeSymbolOrigins(regressionIntegralProblem, result);
    const substitutionAnalysis = analyzeSubstitutionConsistency(result, regressionIntegralProblem);

    assert.ok(collected.some((field) => field.fieldPath === "steps[0].heading" && field.normalized === "x = tan\\theta"));
    assert.equal(symbolAnalysis.unexplainedSymbols.includes("\\theta"), false);
    assert.equal(substitutionAnalysis.issue, null);
    assert.equal(substitutionAnalysis.verificationStatus, "supported");
    assert.deepEqual(symbolAnalysis.fieldReports.map((field) => field.fieldPath), collectedPaths);
    assert.deepEqual(substitutionAnalysis.generatedMathFieldPaths, collectedPaths);
  });

  it("shares math-field tangent-substitution math across symbol and substitution validators", () => {
    const result = solution("\\frac{\\pi}{2}\\ln^2 2", [
      {
        heading: "Substitution",
        math: "x=\\tan\\theta,\\quad I=-2\\int_0^{\\pi/2}\\theta\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta",
        summary: "Rewrite the integral after the substitution.",
      },
    ]);
    const collected = collectGeneratedMath(result);
    const collectedPaths = collected.map((field) => field.fieldPath);
    const symbolAnalysis = analyzeSymbolOrigins(regressionIntegralProblem, result);
    const substitutionAnalysis = analyzeSubstitutionConsistency(result, regressionIntegralProblem);

    assert.ok(collected.some((field) => field.fieldPath === "steps[0].math" && field.normalized.includes("x=\\tan\\theta")));
    assert.equal(symbolAnalysis.unexplainedSymbols.includes("\\theta"), false);
    assert.equal(substitutionAnalysis.issue, null);
    assert.equal(substitutionAnalysis.verificationStatus, "supported");
    assert.deepEqual(symbolAnalysis.fieldReports.map((field) => field.fieldPath), collectedPaths);
    assert.deepEqual(substitutionAnalysis.generatedMathFieldPaths, collectedPaths);
  });

  it("rejects unexplained delta in accepted equation fields", () => {
    assert.throws(() => validateSolutionQuality(solution("x+\\delta", [
      { math: "x+\\delta", summary: "Introduce an unexplained symbol." },
    ]), { problem: "x+1" }), /Solution failed quality validation/);
  });

  it("treats derivative and differential notation as operators, not unexplained d symbols", () => {
    const cases = [
      {
        problem: "\\frac{d}{dx}(x^2)",
        finalAnswerLatex: "\\frac{d}{dx}(x^2)=2x",
      },
      {
        problem: "y=x^2",
        finalAnswerLatex: "\\frac{d^2y}{dx^2}=2",
      },
      {
        problem: "y=x^3",
        finalAnswerLatex: "\\frac{d^3y}{dx^3}=6",
      },
      {
        problem: "y=x^2",
        finalAnswerLatex: "d^2y/dx^2=2",
      },
      {
        problem: "y=x^2",
        finalAnswerLatex: "\\frac{dy}{dx}=2x",
      },
      {
        problem: "f(x)=x^2",
        finalAnswerLatex: "f'(x)=2x",
      },
      {
        problem: "f(x,y)=x^2+y",
        finalAnswerLatex: "\\frac{\\partial f}{\\partial x}=2x",
      },
      {
        problem: "f(x,y)=x^2y",
        finalAnswerLatex: "\\frac{\\partial^2 f}{\\partial x\\partial y}=2x",
      },
      {
        problem: "f(x)=x^2",
        finalAnswerLatex: "\\frac{d^2}{dx^2}f(x)=2",
      },
      {
        problem: "\\int_0^1 x\\,dx",
        finalAnswerLatex: "\\int_0^1 x\\,dx=\\frac{1}{2}",
      },
      {
        problem: "\\int_0^1 t\\,\\mathrm{d}t",
        finalAnswerLatex: "\\int_0^1 t\\,\\mathrm{d}t=\\frac{1}{2}",
      },
    ];

    for (const item of cases) {
      const result = solution(item.finalAnswerLatex, [
        { math: item.finalAnswerLatex, summary: "Use standard derivative or differential notation." },
      ]);
      const analysis = analyzeSymbolOrigins(item.problem, result);
      assert.equal(analysis.unexplainedSymbols.includes("d"), false, item.finalAnswerLatex);
      assert.doesNotThrow(() => validateSolutionQuality(result, { problem: item.problem }), item.finalAnswerLatex);
    }
  });

  it("still rejects free algebraic d when it is not derivative notation", () => {
    assert.throws(() => validateSolutionQuality(solution("y=d+x", [
      { math: "y=d+x", summary: "Introduce an unexplained constant d." },
    ]), { problem: "y=x+1" }), /Solution failed quality validation/);

    for (const finalAnswerLatex of ["d^2+x", "x+d", "\\det(D)=1"]) {
      const analysis = analyzeSymbolOrigins("x", solution(finalAnswerLatex, [
        { math: finalAnswerLatex, summary: "Use a free d symbol." },
      ]));
      assert.equal(analysis.unexplainedSymbols.includes("d") || analysis.unexplainedSymbols.includes("D"), true, finalAnswerLatex);
    }
  });
});
