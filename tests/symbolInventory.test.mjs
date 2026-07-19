import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeSymbolOrigins } from "../server/symbolInventory.js";
import { validateSolutionQuality } from "../server/solutionValidation.js";

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
