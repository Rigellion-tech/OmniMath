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
