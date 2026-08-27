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
  it("recognizes multi-argument and colon-equals definitions before later uses", () => {
    const result = solution("I", [
      {
        math: "a,b\\in\\mathbb{R};\ns\\in\\mathbb{R};\nI:=1;\nJ:=I+1;\nF(a,b):=a+b;\nL(a,b):=F(a,b);\n\\Gamma(s):=\\int_0^\\infty y^{s-1}e^{-y}\\,dy;\nz:=J",
        summary: "Define the auxiliary quantities.",
      },
      {
        math: "K:=J+L(a,b)+F(a,b)+\\Gamma(s)+z",
        summary: "Use only previously defined symbols.",
      },
    ]);
    const analysis = analyzeSymbolOrigins("Evaluate an integral.", result);

    for (const symbol of ["I", "J", "K", "F", "L", "z", "a", "b", "s", "y"]) {
      assert.equal(analysis.unexplainedSymbols.includes(symbol), false, symbol);
    }
  });

  it("does not retroactively accept symbols used before their definition", () => {
    const analysis = analyzeSymbolOrigins("Evaluate an integral.", solution("I", [
      { math: "J=I+1", summary: "Use I too early." },
      { math: "I:=1", summary: "Define I later." },
    ]));

    assert.ok(analysis.fieldReports.some((field) => (
      field.fieldPath === "steps[0].math" && field.unexplainedSymbols.includes("I")
    )));
  });

  it("recognizes definitions on later rows of one aligned field", () => {
    const aligned = String.raw`\begin{aligned}
I&:=1\\
a,b&\in\mathbb{R}\\
F(a,b)&:=a+b\\
J&:=I+F(a,b)
\end{aligned}`;
    const analysis = analyzeSymbolOrigins("Evaluate an integral.", solution("J", [
      { math: aligned, summary: "Define I and F before constructing J." },
      { math: "K:=J+F(a,b)", summary: "Use the aligned definitions later." },
    ]));

    for (const symbol of ["I", "F", "a", "b", "J", "K"]) {
      assert.equal(analysis.unexplainedSymbols.includes(symbol), false, symbol);
    }
  });

  it("continues to reject symbols that are never defined", () => {
    const analysis = analyzeSymbolOrigins("Evaluate an integral.", solution("I", [
      { math: "I:=Q+1", summary: "Q has no definition." },
    ]));
    assert.equal(analysis.unexplainedSymbols.includes("Q"), true);
  });

  it("recognizes an explicit number-set declaration before a free parameter use", () => {
    const analysis = analyzeSymbolOrigins("Evaluate an integral.", solution("1", [
      { math: "n\\in\\mathbb{N}", summary: "Declare the integer parameter." },
      { math: "\\int_0^{\\pi/2}t\\cot t\\sin^{2n}t\\,dt", summary: "Use the declared parameter." },
    ]));

    assert.equal(analysis.unexplainedSymbols.includes("n"), false);
    assert.equal(analysis.unexplainedSymbols.includes("N"), false);
    assert.ok(analysis.explicitDefinitions.includes("n"));
  });

  it("recognizes the live named-integral and inequality-domain declarations", () => {
    const analysis = analyzeSymbolOrigins("Evaluate the given integral.", solution("1", [
      { math: "\\mathcal I\\ \\text{denotes the given integral}", summary: "Name the target integral." },
      { math: "a,b>0,\\quad a\\ne b", summary: "Declare the positive parameters." },
      { math: "\\mathcal I+a+b", summary: "Use the declarations later." },
    ]));

    for (const symbol of ["I", "a", "b"]) {
      assert.equal(analysis.unexplainedSymbols.includes(symbol), false, symbol);
      assert.ok(analysis.explicitDefinitions.includes(symbol), symbol);
    }
  });

  it("recognizes function parameters and bounded domains in the live identities", () => {
    const analysis = analyzeSymbolOrigins("Evaluate an integral.", solution("1", [
      {
        math: "\\operatorname{Li}_2(z):=\\sum_{n=1}^{\\infty}\\frac{z^n}{n^2}=-\\int_0^z\\frac{\\ln(1-u)}{u}\\,du,\\qquad 0\\le z\\le1",
        summary: "Define the dilogarithm and its parameter.",
      },
      {
        math: "y^2=\\frac{\\pi^2}{3}+4\\sum_{n=1}^{\\infty}\\frac{(-1)^n\\cos(ny)}{n^2},\\qquad -\\pi\\le y\\le\\pi",
        summary: "State the Fourier identity on its declared domain.",
      },
    ]));

    for (const symbol of ["z", "y"]) {
      assert.equal(analysis.unexplainedSymbols.includes(symbol), false, symbol);
      assert.ok(analysis.explicitDefinitions.includes(symbol), symbol);
    }
    assert.equal(analysis.unexplainedSymbols.includes("n"), false);
    assert.equal(analysis.unexplainedSymbols.includes("u"), false);
  });

  it("binds an ordinary derivative variable locally without defining it globally", () => {
    const analysis = analyzeSymbolOrigins("Evaluate an identity.", solution("1", [
      {
        math: "\\frac{d}{du}\\left(\\operatorname{Li}_2(u)+u^2\\right)=0",
        summary: "Differentiate with respect to u.",
      },
      { math: "u+v", summary: "Reuse both letters without a later binding." },
    ]));

    assert.ok(analysis.fieldReports[0].symbols.some((item) => (
      item.symbol === "u" && item.classification === "bound_locally"
    )));
    assert.ok(analysis.fieldReports[1].unexplainedSymbols.includes("u"));
    assert.ok(analysis.fieldReports[1].unexplainedSymbols.includes("v"));
    assert.equal(analysis.explicitDefinitions.includes("u"), false);
  });

  it("does not treat unrelated equations as declarations or apply later definitions retroactively", () => {
    const undefinedCases = ["I+1=2", "a+b=1", "z^2+1", "u+v"];
    for (const math of undefinedCases) {
      const analysis = analyzeSymbolOrigins("Evaluate 1.", solution("1", [
        { math, summary: "Use symbols without a declaration." },
      ]));
      assert.notDeepEqual(analysis.unexplainedSymbols, [], math);
    }

    const ordered = analyzeSymbolOrigins("Evaluate 1.", solution("1", [
      { math: "y+1=4", summary: "Use y before introducing it." },
      { math: "y=3", summary: "Define y only afterward." },
    ]));
    assert.ok(ordered.fieldReports[0].unexplainedSymbols.includes("y"));
  });

  it("accepts beta notation and its parameters only after an explicit math definition", () => {
    const defined = analyzeSymbolOrigins("Evaluate an integral.", solution("1", [
      { math: "a=1,\\quad b=1", summary: "Declare the values used below." },
      { math: "B(a,b):=2\\int_0^{\\pi/2}\\sin^{a-1}t\\cos^{b-1}t\\,dt", summary: "Define the beta function with local parameters." },
      { math: "\\frac12B(a/2,b/2)", summary: "Use the defined notation." },
    ]));
    for (const symbol of ["B", "a", "b"]) {
      assert.equal(defined.unexplainedSymbols.includes(symbol), false, symbol);
    }

    const undefinedSymbols = analyzeSymbolOrigins("Evaluate an integral.", solution("1", [
      { math: "\\frac12B(a/2,b/2)", summary: "Use beta notation without defining it." },
    ]));
    for (const symbol of ["B", "a", "b"]) {
      assert.equal(undefinedSymbols.unexplainedSymbols.includes(symbol), true, symbol);
    }
  });

  it("supports table-driven persistent introduction forms without letter-specific rules", () => {
    const cases = [
      { name: "direct inverse function", problem: "x", math: "t=\\arctan x", introduced: "t" },
      { name: "direct polynomial", problem: "x", math: "u=x^2", introduced: "u" },
      { name: "numeric constant", problem: "x", math: "a=2", introduced: "a" },
      { name: "named integral", problem: "f(x)", math: "C=\\int_0^1f(x)\\,dx", introduced: "C" },
      { name: "reverse inverse function", problem: "x", math: "\\arctan x=t", introduced: "t" },
      { name: "reverse polynomial", problem: "x", math: "x^2=u", introduced: "u" },
      { name: "colon equals", problem: "x", math: "w:=x+1", introduced: "w" },
      { name: "coloneqq", problem: "x", math: "\\lambda\\coloneqq2", introduced: "\\lambda" },
      { name: "definitional equivalence", problem: "x", math: "c\\equiv x+1", introduced: "c", heading: "Define c" },
      { name: "function definition", problem: "1", math: "F(x)=x^2", introduced: "F" },
      { name: "mapsto function", problem: "1", math: "f:t\\mapsto t^2", introduced: "f" },
    ];

    for (const item of cases) {
      const analysis = analyzeSymbolOrigins(item.problem, solution("1", [
        { heading: item.heading || "Definition", math: item.math, summary: "Introduce the notation." },
        { math: `${item.introduced}+1`, summary: "Use the persistent symbol later." },
      ]));
      assert.equal(analysis.unexplainedSymbols.includes(item.introduced), false, item.name);
      assert.ok(analysis.explicitDefinitions.includes(item.introduced), item.name);
    }
  });

  it("recognizes general change-of-variable structure including the reconstructed v failure", () => {
    const cases = [
      { problem: "u", math: "u=(1-v)/(1+v)", symbol: "v" },
      { problem: "x", math: "x=\\tan t", symbol: "t" },
      { problem: "z", math: "z=e^{i\\theta}", symbol: "\\theta" },
    ];
    for (const item of cases) {
      const analysis = analyzeSymbolOrigins(item.problem, solution("1", [
        { heading: "Change of variable", math: item.math, summary: "Make the substitution." },
        { math: `${item.symbol}^2+1`, summary: "Use the new variable later." },
      ]));
      assert.equal(analysis.unexplainedSymbols.includes(item.symbol), false, item.math);
      assert.ok(analysis.provenanceDiagnostics.some((record) => (
        record.symbol === item.symbol && record.provenanceCategory === "substitution_variable"
      )), item.math);
    }
  });

  it("extracts explicit prose parameter and named-constant declarations conservatively", () => {
    const declarations = [
      { prose: "Let a,b>0", use: "a+b", symbols: ["a", "b"] },
      { prose: "for n\\in\\mathbb N", use: "n+1", symbols: ["n"] },
      { prose: "where C is a constant", use: "C+1", symbols: ["C"] },
      { prose: "take \\lambda>0", use: "\\lambda+1", symbols: ["\\lambda"] },
      { prose: "let r_1,r_2 be the roots", use: "r^2", symbols: ["r"] },
    ];
    for (const item of declarations) {
      const analysis = analyzeSymbolOrigins("1", solution("1", [
        { math: "1", summary: item.prose },
        { math: item.use, summary: "Use the declared parameter." },
      ]));
      for (const symbol of item.symbols) {
        assert.equal(analysis.unexplainedSymbols.includes(symbol), false, `${item.prose}:${symbol}`);
        assert.ok(analysis.explicitDefinitions.includes(symbol), `${item.prose}:${symbol}`);
      }
    }
  });

  it("keeps function parameters local while promoting only the function name", () => {
    const forms = [
      { definition: "F(x)=x^2", functionName: "F", parameter: "x" },
      { definition: "f:t\\mapsto t^2", functionName: "f", parameter: "t" },
      { definition: "\\operatorname{Li}_2(z):=\\sum_{k=1}^{\\infty}z^k/k^2", functionName: null, parameter: "z" },
    ];
    for (const item of forms) {
      const analysis = analyzeSymbolOrigins("1", solution("1", [
        { math: item.definition, summary: "Define the function." },
        { math: `${item.parameter}+1`, summary: "Improperly reuse the local parameter." },
      ]));
      assert.ok(analysis.fieldReports.find((field) => field.fieldPath === "steps[0].math")?.symbols.some((record) => (
        record.symbol === item.parameter && record.provenanceCategory === "function_parameter"
      )), item.definition);
      assert.ok(analysis.fieldReports.find((field) => field.fieldPath === "steps[1].math")?.unexplainedSymbols.includes(item.parameter), item.definition);
      if (item.functionName) assert.ok(analysis.explicitDefinitions.includes(item.functionName), item.definition);
    }
  });

  it("classifies integral, sum, product, limit, set-builder, and quantified binders as local", () => {
    const cases = [
      { math: "\\int_0^1 f(t)\\,dt", symbol: "t", problem: "f" },
      { math: "\\sum_{k=1}^{4}k^2", symbol: "k", problem: "1" },
      { math: "\\prod_{j=1}^{4}j", symbol: "j", problem: "1" },
      { math: "\\lim_{x\\to0}x", symbol: "x", problem: "1" },
      { math: "\\{x:x>0\\}", symbol: "x", problem: "1" },
      { math: "\\forall x\\;x=x", symbol: "x", problem: "1" },
      { math: "\\exists y\\;y>0", symbol: "y", problem: "1" },
    ];
    for (const item of cases) {
      const analysis = analyzeSymbolOrigins(item.problem, solution("1", [
        { math: item.math, summary: "Use a local binder." },
      ]));
      assert.equal(analysis.unexplainedSymbols.includes(item.symbol), false, item.math);
      assert.ok(analysis.fieldReports[0].symbols.some((record) => (
        record.symbol === item.symbol && record.provenanceCategory === "bound_local"
      )), item.math);
    }
  });

  it("normalizes indexed, styled, and prime notation to the underlying symbol", () => {
    const analysis = analyzeSymbolOrigins("v+x+z+\\theta", solution("1", [
      { math: "\\mathbf v+\\vec v+\\hat x+\\bar z+x_0+\\theta_1", summary: "Use styled and indexed forms." },
      { math: "v'+x''+z'", summary: "Use prime notation without creating prime symbols." },
    ]));
    assert.deepEqual(analysis.unexplainedSymbols, []);
    for (const symbol of ["v", "x", "z", "\\theta"]) assert.ok(analysis.generatedSymbols.includes(symbol));
  });

  it("supports structurally clear multiple introductions", () => {
    const analysis = analyzeSymbolOrigins("x+y", solution("1", [
      { math: "u=x+y,\\quad v=x-y", summary: "Define two coordinates." },
      { math: "a,b>0", summary: "Declare two parameters." },
      { math: "r_1,r_2=x", summary: "Name a root family." },
      { math: "u+v+a+b+r", summary: "Use every introduced symbol." },
    ]));
    assert.deepEqual(analysis.unexplainedSymbols, []);
    for (const symbol of ["u", "v", "a", "b", "r"]) assert.ok(analysis.explicitDefinitions.includes(symbol), symbol);
  });

  it("preserves critical negative relations and mixed valid/invalid expressions", () => {
    const cases = [
      { problem: "x", math: "x+q=7", unexplained: "q" },
      { problem: "x", math: "q+x=7", unexplained: "q" },
      { problem: "f(x)", math: "f(x)+z=0", unexplained: "z" },
      { problem: "x+y", math: "x^2+y^2=z^2", unexplained: "z" },
      { problem: "x", math: "x+Q", unexplained: "Q" },
      { problem: "x", math: "u=x+q", unexplained: "q", introduced: "u" },
    ];
    for (const item of cases) {
      const analysis = analyzeSymbolOrigins(item.problem, solution("1", [
        { math: item.math, summary: "Assert the relation without defining the extra symbol." },
      ]));
      assert.ok(analysis.unexplainedSymbols.includes(item.unexplained), item.math);
      if (item.introduced) assert.ok(analysis.explicitDefinitions.includes(item.introduced), item.math);
    }
  });

  it("enforces final-answer, later-step, local-scope, and within-field ordering", () => {
    const onlyFinal = analyzeSymbolOrigins("x", solution("q=x+1", []));
    assert.ok(onlyFinal.unexplainedSymbols.includes("q"));

    const later = analyzeSymbolOrigins("x", solution("1", [
      { math: "u+x", summary: "Use u too soon." },
      { math: "u=x^2", summary: "Define u later." },
    ]));
    assert.ok(later.fieldReports.find((field) => field.fieldPath === "steps[0].math")?.unexplainedSymbols.includes("u"));

    for (const definition of ["\\int_0^1t\\,dt", "F(t)=t^2"]) {
      const scoped = analyzeSymbolOrigins("1", solution("1", [
        { math: definition, summary: "Use a local binder." },
        { math: "t+1", summary: "Leak it into a later step." },
      ]));
      assert.ok(scoped.fieldReports.find((field) => field.fieldPath === "steps[1].math")?.unexplainedSymbols.includes("t"), definition);
    }

    const ordered = analyzeSymbolOrigins("x", solution("1", [
      { math: "u=x^2;u+1", summary: "Define before use." },
    ]));
    assert.equal(ordered.unexplainedSymbols.includes("u"), false);
    const reversed = analyzeSymbolOrigins("x", solution("1", [
      { math: "u+1;u=x^2", summary: "Use before definition." },
    ]));
    assert.ok(reversed.unexplainedSymbols.includes("u"));

    const proseOrdered = analyzeSymbolOrigins("x", solution("1", [
      { math: "x", summary: "Let $u=x^2$. Then $u+1$." },
    ]));
    assert.equal(proseOrdered.unexplainedSymbols.includes("u"), false);
    const proseReversed = analyzeSymbolOrigins("x", solution("1", [
      { math: "x", summary: "$u+1$. Let $u=x^2$." },
    ]));
    assert.ok(proseReversed.fieldReports.find((field) => field.value === "u+1")?.unexplainedSymbols.includes("u"));
  });

  it("does not turn a random prose-heading letter into math provenance", () => {
    const analysis = analyzeSymbolOrigins("x", solution("x", [
      { heading: "Part n discusses the next calculation", math: "x+1", summary: "Ordinary prose." },
    ]));
    assert.equal(analysis.generatedSymbols.includes("n"), false);
    assert.equal(analysis.unexplainedSymbols.includes("n"), false);
  });

  it("is metamorphic under consistent renaming of introduced and unexplained symbols", () => {
    for (const symbol of ["t", "u", "v", "w", "\\theta"]) {
      const introduced = analyzeSymbolOrigins("x", solution("1", [
        { heading: "Change of variable", math: `x=(1-${symbol})/(1+${symbol})`, summary: "Make the substitution." },
        { math: `${symbol}^2+1`, summary: "Use it later." },
      ]));
      assert.equal(introduced.unexplainedSymbols.includes(symbol), false, `introduced:${symbol}`);

      const unexplained = analyzeSymbolOrigins("x", solution("1", [
        { math: `x+${symbol}=7`, summary: "Assert an unrelated equation." },
      ]));
      assert.ok(unexplained.unexplainedSymbols.includes(symbol), `unexplained:${symbol}`);
    }
  });

  it("reports bounded first-seen, introduction, type, and scope diagnostics", () => {
    const analysis = analyzeSymbolOrigins("x", solution("1", [
      { heading: "Substitution", math: "u=x^2", summary: "Introduce u." },
      { math: "u+q", summary: "Use one known and one unknown symbol." },
    ]));
    const introduced = analysis.provenanceDiagnostics.find((record) => record.symbol === "u");
    const unknown = analysis.provenanceDiagnostics.find((record) => record.symbol === "q");
    assert.equal(introduced?.introducedAt?.introductionType, "direct_substitution");
    assert.equal(introduced?.scope, "persistent");
    assert.equal(unknown?.provenanceCategory, "undefined_free_symbol");
    assert.match(unknown?.unexplainedAt?.reason || "", /not present/u);
    assert.ok((introduced?.firstSeen?.evidence.length || 0) <= 160);
  });

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

  it("introduces a substitution variable from either equation orientation", () => {
    const variants = [
      "\\arctan x=t",
      "t=\\arctan x",
      "u=x^2",
      "x^2=u",
      "x=\\tan t",
    ];

    for (const math of variants) {
      const introduced = math.includes("u") ? "u" : "t";
      const analysis = analyzeSymbolOrigins("x", solution("1", [
        { math, summary: "Introduce a substitution variable." },
      ]));

      assert.equal(analysis.unexplainedSymbols.includes(introduced), false, math);
      assert.ok(analysis.explicitDefinitions.includes(introduced), math);
    }
  });

  it("carries a reverse-oriented arctangent substitution into later fields", () => {
    const result = solution("\\frac{\\pi}{2}\\ln^2 2", [
      { math: "\\arctan x=t", summary: "Introduce t." },
      { math: "1+x^2=\\sec^2 t", summary: "Rewrite using t." },
      { math: "t\\mapsto\\pi/2-t", summary: "Reflect t." },
    ]);
    const analysis = analyzeSymbolOrigins(regressionIntegralProblem, result);

    assert.equal(analysis.unexplainedSymbols.includes("t"), false);
    assert.ok(analysis.explicitDefinitions.includes("t"));
    for (const fieldPath of ["steps[1].math", "steps[2].math"]) {
      const field = analysis.fieldReports.find((report) => report.fieldPath === fieldPath);
      assert.equal(field?.unexplainedSymbols.includes("t"), false, fieldPath);
    }
  });

  it("does not infer a definition from a general equation side", () => {
    const analysis = analyzeSymbolOrigins("x", solution("1", [
      { math: "x+q=7", summary: "Use an unexplained symbol." },
    ]));

    assert.equal(analysis.unexplainedSymbols.includes("q"), true);
    assert.equal(analysis.explicitDefinitions.includes("q"), false);
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

  it("does not report grouped differential operators as unexplained d symbols", () => {
    const variants = [
      "d(\\ln \\sin t)=\\cot t\\,dt",
      "d (\\ln \\sin t)=\\cot t\\,dt",
      "d\\left(\\ln \\sin t\\right)=\\cot t\\,dt",
      "d \\left(\\ln \\sin t\\right)=\\cot t\\,dt",
    ];

    for (const finalAnswerLatex of variants) {
      const analysis = analyzeSymbolOrigins("t", solution(finalAnswerLatex, [
        { math: finalAnswerLatex, summary: "Differentiate the grouped expression." },
      ]));
      assert.equal(analysis.unexplainedSymbols.includes("d"), false, finalAnswerLatex);
      assert.equal(analysis.unexplainedSymbols.includes("t"), false, finalAnswerLatex);
    }
  });

  it("recognizes spaced grouped named-function differentials without globally whitelisting d", () => {
    const variants = [
      "d\\!\\left[\\operatorname{Li}_2(\\sin^2 t)\\right]",
      "d \\left[\\operatorname{Li}_2(\\sin^2 t)\\right]",
      "d\\left(\\operatorname{Li}_2(\\sin^2 t)\\right)",
      "d\\left[\\Gamma(t)\\right]",
    ];

    for (const finalAnswerLatex of variants) {
      const analysis = analyzeSymbolOrigins("t", solution(finalAnswerLatex, [
        { math: finalAnswerLatex, summary: "Differentiate the grouped named function." },
      ]));
      assert.equal(analysis.unexplainedSymbols.includes("d"), false, finalAnswerLatex);
      assert.equal(analysis.unexplainedSymbols.includes("t"), false, finalAnswerLatex);
    }
  });

  it("preserves free d validation and explicit d definitions", () => {
    for (const finalAnswerLatex of ["d+1=5", "d+x=5", "d(x+1)", "d[x+1]"]) {
      const analysis = analyzeSymbolOrigins("x", solution(finalAnswerLatex, [
        { math: finalAnswerLatex, summary: "Use the equation." },
      ]));
      assert.ok(analysis.unexplainedSymbols.includes("d"), finalAnswerLatex);
    }

    for (const finalAnswerLatex of ["d=5", "d=x+1"]) {
      const analysis = analyzeSymbolOrigins("x", solution(finalAnswerLatex, [
        { math: finalAnswerLatex, summary: "Define d explicitly." },
      ]));
      assert.equal(analysis.unexplainedSymbols.includes("d"), false, finalAnswerLatex);
      assert.ok(analysis.explicitDefinitions.includes("d"), finalAnswerLatex);
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
