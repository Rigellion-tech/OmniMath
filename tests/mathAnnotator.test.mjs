import assert from "node:assert/strict";
import { describe, it } from "node:test";
import katex from "katex";
import {
  annotateExpression,
  annotateMathExplanation,
  hasCompleteTokenHierarchy,
  hierarchicalTokensEnabled,
  normalizeMathText,
  renderMathLatex,
} from "../src/lib/mathAnnotator.js";

function flattenTokens(tokens = []) {
  return tokens.flatMap((token) => [token, ...flattenTokens(token.children)]);
}

function tokenLatex(expression) {
  return flattenTokens(expression.tokens).map((token) => token.latex);
}

describe("mathAnnotator", () => {
  it("adds hierarchical token contract fields without removing legacy fields", () => {
    const expression = annotateExpression({
      id: "expr-contract",
      latex: "3x+45=67",
      role: "equation",
      problemId: "contract",
    });
    const root = expression.tokens[0];
    const coefficient = flattenTokens(expression.tokens).find((token) => token.latex === "3");

    assert.equal(root.kind, "equation");
    assert.equal(root.rawText, "3x+45=67");
    assert.deepEqual(root.sourceRange, { start: 0, end: root.end });
    assert.equal(typeof root.explanationId, "string");
    assert.equal(coefficient.role, "coefficient");
    assert.equal(coefficient.kind, "coefficient");
    assert.equal(coefficient.children.length, 0);
  });

  it("keeps the parent token as the fallback target when hierarchy parsing is disabled or unsafe", () => {
    const previous = process.env.VITE_ENABLE_HIERARCHICAL_TOKENS;
    process.env.VITE_ENABLE_HIERARCHICAL_TOKENS = "false";
    try {
      assert.equal(hierarchicalTokensEnabled(), false);
      const disabled = annotateExpression({ id: "expr-disabled", latex: "3x+45=67" });
      assert.equal(disabled.tokens.length, 1);
      assert.equal(disabled.tokens[0].children.length, 0);
      assert.equal(disabled.tokens[0].latex, "3x+45=67");
    } finally {
      if (previous === undefined) delete process.env.VITE_ENABLE_HIERARCHICAL_TOKENS;
      else process.env.VITE_ENABLE_HIERARCHICAL_TOKENS = previous;
    }

    const unsafe = annotateExpression({ id: "expr-unsafe", latex: "\\frac{x" });
    assert.equal(unsafe.tokens.length, 1);
    assert.ok(Array.isArray(unsafe.tokens[0].children));
  });

  it("supports required algebra interaction targets", () => {
    const expression = annotateExpression({
      id: "expr-algebra-targets",
      latex: "3x + 45 = 67",
      role: "equation",
      problemId: "targets",
    });
    const latex = tokenLatex(expression);

    for (const target of ["3x+45=67", "3x", "3", "x", "45", "67"]) {
      assert.ok(latex.includes(target), target);
    }
  });

  it("supports required vector-calculus interaction targets from unicode math", () => {
    const expression = annotateExpression({
      id: "expr-vector-targets",
      latex: "∬_S (∇ × F) · n dS = 18π",
      role: "equation",
      problemId: "targets",
    });
    const latex = tokenLatex(expression);

    for (const target of ["S", "\\nabla\\times F", "\\nabla", "F", "n", "dS", "18\\pi"]) {
      assert.ok(latex.includes(target), target);
    }
    assert.equal(expression.tokens[0].role, "equation");
  });

  it("normalizes common OCR and plaintext math variants", () => {
    assert.equal(normalizeMathText("0 <= theta <= 2 pi"), "0\\le\\theta\\le2\\pi");
    assert.equal(normalizeMathText("sqrt(3) >= phi"), "\\sqrt{3}\\ge\\phi");
    assert.equal(normalizeMathText("rho^2 + pi"), "\\rho^2+\\pi");
  });

  it("preserves text command spacing and repairs malformed generated commands", () => {
    const malformed = "\\text{and}V\\text{isthesolidregioninsi\\,de}\\z=9";

    assert.equal(normalizeMathText("\\text{and } V"), "\\text{and } V");
    assert.equal(normalizeMathText("\\text{ is the solid region inside }"), "\\text{ is the solid region inside }");
    assert.equal(normalizeMathText("\\text{Let } C \\text{ be}"), "\\text{Let } C \\text{ be}");
    assert.equal(normalizeMathText("\\text{where } S"), "\\text{where } S");
    assert.equal(normalizeMathText("\\text{ expressed as }"), "\\text{ expressed as }");
    assert.equal(
      normalizeMathText("\\quad \\text{Non-symmetric terms vanish by symmetry.}"),
      "\\quad \\text{Non-symmetric terms vanish by symmetry.}"
    );
    assert.equal(normalizeMathText(malformed), "\\text{and } V \\text{ is the solid region inside } z=9");
    assert.equal(renderMathLatex("z = 9 - x^2 - y^2"), "z=9-x^{2}-y^{2}");
    assert.equal(renderMathLatex("x^2 \\cosz"), "x^{2}\\cos z");
    assert.equal(renderMathLatex(malformed).includes("\\z"), false);
    assert.equal(renderMathLatex(malformed).includes("isthesolidregioninside"), false);
  });

  it("normalizes visual render math into valid KaTeX latex", () => {
    assert.equal(renderMathLatex("z = 2/3"), "z=\\frac{2}{3}");
    assert.equal(renderMathLatex("rho = (2/3) / cos(phi)"), "\\rho=\\frac{\\frac{2}{3}}{\\cos \\phi}");
    assert.equal(renderMathLatex("(2/3) / cos(phi) <= rho <= 4"), "\\frac{\\frac{2}{3}}{\\cos \\phi}\\le\\rho\\le4");
    assert.equal(renderMathLatex("phi = pi/4"), "\\phi=\\frac{\\pi}{4}");
    assert.equal(renderMathLatex("0 <= phi <= pi/4"), "0\\le\\phi\\le\\frac{\\pi}{4}");
    assert.equal(renderMathLatex("rho^4 sin(phi)"), "\\rho^{4}\\sin \\phi");
    assert.equal(renderMathLatex("\\int rho^4 drho = rho^5 / 5"), "\\int \\rho^{4}\\,d\\rho=\\frac{\\rho^{5}}{5}");
    assert.equal(renderMathLatex("\\int_0^{pi/4} sin(phi) dphi"), "\\int_{0}^{\\frac{\\pi}{4}} \\sin \\phi\\,d\\phi");
    assert.equal(renderMathLatex("\\sinx"), "\\sin x");
    assert.equal(renderMathLatex("\\cosx"), "\\cos x");
    assert.equal(renderMathLatex("\\tanx"), "\\tan x");
    assert.equal(renderMathLatex("d/dx (x^2 \\sin x)"), "\\frac{d}{dx} \\left(x^{2}\\sin x\\right)");
    assert.equal(renderMathLatex("d/dx sin(x^3)"), "\\frac{d}{dx} \\sin x^{3}");
    assert.equal(renderMathLatex("\\int x e^x dx"), "\\int xe^{x}\\,dx");
    assert.equal(renderMathLatex("x^2+y^2+z^2 \\le 16"), "x^{2}+y^{2}+z^{2}\\le16");
  });

  it("preserves cdot command boundaries throughout hierarchical token construction", () => {
    const latex = "\\int_0^{\\pi/2} \\frac{\\ln(1+\\tan^2 t) \\cdot t}{\\tan t(1+\\tan^2 t)} \\cdot \\sec^2 t \\,dt";
    const expression = annotateExpression({ id: "expr-cdot-boundary", latex });
    const tokenLatexValues = flattenTokens(expression.tokens).map((token) => token.latex);

    assert.equal(expression.latex, latex);
    assert.equal(tokenLatexValues.some((value) => /\\cdott\b/u.test(value)), false);
    assert.equal(tokenLatexValues.some((value) => value.includes("\\cdot t")), true);

    for (const valid of ["\\cdot t", "\\cdot x", "\\cdot n", "\\cdots", "\\cdotp"]) {
      const annotated = annotateExpression({ id: `expr-${valid.slice(1)}`, latex: valid });
      assert.equal(annotated.latex, valid);
      assert.doesNotThrow(() => katex.renderToString(renderMathLatex(valid), { throwOnError: true }));
    }
  });

  it("preserves control-word boundaries in nested function arguments", () => {
    const cases = [
      {
        latex: "du=\\cos\\theta d\\theta",
        expectedBoundary: "\\theta d\\theta",
      },
      {
        latex: "u=\\sin\\theta, \\quad du=\\cos\\theta\\,d\\theta",
        expectedBoundary: "\\theta,\\quad du",
      },
    ];
    const malformedBoundary = /\\(?:thetad|quaddu)\b/u;

    for (const [caseIndex, { latex, expectedBoundary }] of cases.entries()) {
      const expression = annotateExpression({
        id: `expr-nested-boundary-${caseIndex}`,
        latex,
        problemId: "nested-command-boundaries",
      });
      const tokenLatexValues = flattenTokens(expression.tokens).map((token) => token.latex);

      assert.equal(expression.latex, latex);
      assert.equal(tokenLatexValues.some((value) => malformedBoundary.test(value)), false);
      assert.equal(tokenLatexValues.some((value) => value.includes(expectedBoundary)), true);

      for (const value of tokenLatexValues) {
        const katexInput = renderMathLatex(value);
        assert.equal(malformedBoundary.test(katexInput), false, value);
        assert.doesNotThrow(() => katex.renderToString(katexInput, {
          throwOnError: true,
          strict: "ignore",
        }));
      }
    }

    for (const valid of [
      "\\theta",
      "\\theta_d",
      "\\theta^d",
      "\\quad",
      "\\qquad",
      "\\quad x",
      "\\quad du",
      "\\mathrm{d}u",
      "\\operatorname{length}u",
    ]) {
      const rendered = renderMathLatex(valid);
      assert.equal(malformedBoundary.test(rendered), false, valid);
      assert.doesNotThrow(() => katex.renderToString(rendered, { throwOnError: true }));
    }
  });

  it("preserves grouped factors after Greek control words during render conversion", () => {
    const cases = [
      ["\\Gamma(n+1)", "\\Gamma\\left(n+1\\right)"],
      ["\\Gamma(n)", "\\Gamma\\left(n\\right)"],
      ["\\Gamma(z)", "\\Gamma\\left(z\\right)"],
      ["\\Gamma\\left(n+1\\right)", "\\Gamma\\left(n+1\\right)"],
      ["\\Gamma{(n+1)}", "\\Gamma{(n+1)}"],
      ["\\Gamma_n", "\\Gamma_n"],
      ["\\Gamma^2", "\\Gamma^{2}"],
      ["\\Gamma + n", "\\Gamma+n"],
      ["\\Delta(k+1)", "\\Delta\\left(k+1\\right)"],
    ];

    for (const [input, expected] of cases) {
      const rendered = renderMathLatex(input);
      assert.equal(rendered, expected);
      assert.equal(/\\Gamman\b/u.test(rendered), false);
      assert.doesNotThrow(() => katex.renderToString(rendered, { throwOnError: true }));
    }

    assert.equal(renderMathLatex("(x+1)(x-1)"), "\\left(x+1\\right)\\left(x-1\\right)");
  });

  it("preserves already-valid nested latex for KaTeX rendering", () => {
    const input = "\\int_{0}^{\\frac{\\pi}{4}}\\sin\\phi\\left(4^{5}-\\left(\\frac{2\\sqrt{3}}{\\cos\\phi}\\right)^5\\right)\\,d\\phi";
    const renderedLatex = renderMathLatex(input);
    const html = katex.renderToString(renderedLatex, { throwOnError: false });

    assert.equal(renderedLatex, input);
    assert.equal(html.includes("merror"), false);
    assert.equal(html.includes("katex-error"), false);
  });

  it("renders double-escaped generated latex instead of falling back to raw text", () => {
    const input = "\\\\int_0^{\\\\pi/4}\\\\sin\\\\phi\\\\left(4^5-\\\\left(\\\\frac{2\\\\sqrt3}{\\\\cos\\\\phi}\\\\right)^5\\\\right)d\\\\phi";
    const renderedLatex = renderMathLatex(input);
    const html = katex.renderToString(renderedLatex, { throwOnError: false });

    assert.equal(renderedLatex.includes("\\\\int"), false);
    assert.ok(renderedLatex.startsWith("\\int"));
    assert.equal(html.includes("merror"), false);
    assert.equal(html.includes("katex-error"), false);
  });

  it("keeps valid TeX rows intact when annotating accepted solution lines", () => {
    const values = [
      String.raw`\begin{aligned}x=1\\u=2\end{aligned}`,
      String.raw`\begin{gathered}x+y=1\\x-y=0\end{gathered}`,
      String.raw`\begin{cases}x=1\\f=2\end{cases}`,
      String.raw`\begin{array}{cc}a=b&c=d\\f=g&h=i\end{array}`,
      String.raw`M=\begin{bmatrix}a&b\\e&f\end{bmatrix}`,
      String.raw`x=1\\u=2`,
      String.raw`x\ y+\frac{1}{2}`,
    ];

    for (const [index, latex] of values.entries()) {
      const result = annotateMathExplanation({
        steps: [{
          id: `row-${index}`,
          math: latex,
          chunks: [{ id: `chunk-${index}`, display: latex }],
          lines: [{ id: `line-${index}`, kind: "math", latex, tokens: [] }],
        }],
      });
      assert.equal(result.steps[0].math, latex);
      assert.equal(result.steps[0].lines[0].latex, latex);
      assert.equal(result.steps[0].chunks[0].display, latex);
      assert.equal(renderMathLatex(result.steps[0].lines[0].latex), latex);
      assert.doesNotThrow(() => katex.renderToString(latex, { throwOnError: true }));
    }

    assert.equal(renderMathLatex(String.raw`\\frac{1}{2}`), String.raw`\frac{1}{2}`);
    assert.equal(annotateMathExplanation({ steps: [{ math: String.raw`\alpha+\frac{1}{2}` }] }).steps[0].math, String.raw`\alpha+\frac{1}{2}`);
  });

  it("normalizes comma-separated integration-by-parts chunks without blank artifacts", () => {
    assert.equal(renderMathLatex("u = x, dv = e^x dx"), "u=x,dv=e^{x}\\,dx");
    assert.equal(renderMathLatex("du = dx, v = e^x"), "du=dx,v=e^{x}");
  });

  it("preserves LaTeX command boundaries through annotation and KaTeX rendering", () => {
    const cases = [
      "C:\\ x^2+y^2=9,\\ z=0",
      "C:\\,x^2+y^2=9,\\ z=0",
      "\\left\\langle a,b,c\\right\\rangle",
      "\\mathbf F(x,y,0)=\\left\\langle e^{x^2}\\sin(y),\\ 0,\\ xy^2\\right\\rangle",
      "x^2+y^2\\le 9",
      "\\left(x+y\\right)",
      "\\oint_C e^{x^2}\\sin(y)\\,dx",
      "\\iint_S(\\nabla\\times F)\\cdot n\\,dS",
    ];

    assert.equal(normalizeMathText("C:\\ x^2+y^2=9,\\ z=0"), "C:\\,x^2+y^2=9,\\,z=0");
    assert.equal(normalizeMathText("C:\\,x^2+y^2=9,\\ z=0"), "C:\\,x^2+y^2=9,\\,z=0");

    for (const latex of cases) {
      const expression = annotateExpression({
        id: `expr-command-boundary-${cases.indexOf(latex)}`,
        latex,
        role: "equation",
        problemId: "command-boundaries",
      });
      const fragments = flattenTokens(expression.tokens).map((token) => token.latex);

      assert.equal(fragments.some((fragment) => /\\[xz]\b/.test(fragment)), false, latex);
      assert.equal(fragments.some((fragment) => /^ft\\langle/.test(fragment)), false, latex);
      if (/\\left/.test(latex)) {
        assert.equal(fragments.includes("\\le"), false, latex);
      }

      for (const fragment of fragments) {
        const katexInput = renderMathLatex(fragment);
        const html = katex.renderToString(katexInput, {
          throwOnError: true,
          strict: "ignore",
        });

        assert.equal(html.includes("katex-error"), false, fragment);
        assert.equal(html.includes("merror"), false, fragment);
      }
    }
  });

  it("builds a nested hierarchy for full-circle theta bounds", () => {
    const expression = annotateExpression({
      id: "expr-theta",
      latex: "0\\le\\theta\\le2\\pi",
      role: "bound",
      problemId: "triple-integral",
    });
    const latex = tokenLatex(expression);

    assert.ok(latex.includes("0\\le\\theta\\le2\\pi"));
    assert.ok(latex.includes("0"));
    assert.ok(latex.includes("\\theta"));
    assert.ok(latex.includes("2\\pi"));
    assert.ok(latex.includes("2"));
    assert.ok(latex.includes("\\pi"));

    const twoPi = flattenTokens(expression.tokens).find((token) => token.latex === "2\\pi");
    assert.deepEqual(twoPi.children.map((child) => child.latex), ["2", "\\pi"]);
  });

  it("detects fraction, radical, trig, rho, and endpoint pieces in radial bounds", () => {
    const expression = annotateExpression({
      id: "expr-rho",
      latex: "\\frac{2\\sqrt{3}}{\\cos\\phi}\\le\\rho\\le4",
      role: "bound",
      problemId: "triple-integral",
    });
    const latex = tokenLatex(expression);

    assert.ok(latex.includes("\\frac{2\\sqrt{3}}{\\cos\\phi}"));
    assert.ok(latex.includes("2\\sqrt{3}"));
    assert.ok(latex.includes("\\sqrt{3}"));
    assert.ok(latex.includes("3"));
    assert.ok(latex.includes("\\cos\\phi"));
    assert.ok(latex.includes("\\cos"));
    assert.ok(latex.includes("\\phi"));
    assert.ok(latex.includes("\\rho"));
    assert.ok(latex.includes("4"));
  });

  it("detects exponent and differential sub-parts in an integrand", () => {
    const expression = annotateExpression({
      id: "expr-integrand",
      latex: "\\rho^4\\sin\\phi\\,d\\rho\\,d\\phi\\,d\\theta",
      role: "integrand",
      problemId: "triple-integral",
    });
    const latex = tokenLatex(expression);

    assert.ok(latex.includes("\\rho^4"));
    assert.ok(latex.includes("\\rho"));
    assert.ok(latex.includes("4"));
    assert.ok(latex.includes("\\sin\\phi"));
    assert.ok(latex.includes("\\sin"));
    assert.ok(latex.includes("\\phi"));
    assert.ok(latex.includes("d\\rho"));
    assert.ok(latex.includes("d\\phi"));
    assert.ok(latex.includes("d\\theta"));
  });

  it("keeps dense vector-calculus substitutions as meaningful token parts", () => {
    const explanation = annotateMathExplanation({
      title: "Dense substitution",
      problem: "Use Stokes theorem.",
      steps: [{
        id: "dense-step",
        label: "Substitute parametric variables into the integrand",
        math: "x^3+\\frac{\\cos(xy)}{1+x^2+y^2}+\\arctan(x-y)=8\\cos^3\\theta+\\frac{\\cos(6\\cos\\theta\\sin\\theta)}{1+4\\cos^2\\theta+9\\sin^2\\theta}+\\arctan(2\\cos\\theta-3\\sin\\theta)",
        summary: "Substitute the parameterization.",
      }],
    });
    const line = explanation.steps[0].lines[0];
    const root = line.tokens[0];
    const parts = flattenTokens(root.parts);
    const latex = parts.map((token) => token.latex);

    assert.equal(line.tokens.length, 1);
    assert.ok(root.display.length > 120);
    assert.ok(root.parts.length > 6);
    assert.ok(latex.includes("x^3"));
    assert.ok(latex.includes("3"));
    assert.ok(latex.includes("\\cos(xy)"));
    assert.ok(latex.includes("xy"));
    assert.ok(latex.includes("\\arctan(x-y)"));
    assert.ok(latex.includes("1+4\\cos^2\\theta+9\\sin^2\\theta"));
  });

  it("keeps parent groups and leaves explainable in a volume-element equation", () => {
    const expression = annotateExpression({
      id: "expr-volume",
      latex: "dV=\\rho^2\\sin\\phi\\,d\\rho\\,d\\phi\\,d\\theta",
      role: "equation",
      problemId: "triple-integral",
    });
    const tokens = flattenTokens(expression.tokens);
    const latex = tokens.map((token) => token.latex);
    const rolesByLatex = new Map(tokens.map((token) => [token.latex, token.role]));

    assert.ok(latex.includes("dV=\\rho^2\\sin\\phi\\,d\\rho\\,d\\phi\\,d\\theta"));
    assert.equal(rolesByLatex.get("dV"), "differential");
    assert.equal(rolesByLatex.get("\\rho^2\\sin\\phi\\,d\\rho\\,d\\phi\\,d\\theta"), "product");
    assert.equal(rolesByLatex.get("\\rho^2"), "power");
    assert.equal(rolesByLatex.get("\\rho"), "variable");
    assert.equal(rolesByLatex.get("2"), "exponent");
    assert.equal(rolesByLatex.get("\\sin\\phi"), "function");
    assert.equal(rolesByLatex.get("\\sin"), "function");
    assert.equal(rolesByLatex.get("\\phi"), "argument");
    assert.equal(rolesByLatex.get("d\\rho\\,d\\phi\\,d\\theta"), "differential_group");
    assert.equal(rolesByLatex.get("d\\rho"), "differential");
    assert.equal(rolesByLatex.get("d\\phi"), "differential");
    assert.equal(rolesByLatex.get("d\\theta"), "differential");
  });

  it("keeps parent fraction and child pieces in phi bounds", () => {
    const expression = annotateExpression({
      id: "expr-phi",
      latex: "0\\le\\phi\\le\\frac{\\pi}{4}",
      role: "bound",
      problemId: "triple-integral",
    });
    const latex = tokenLatex(expression);

    assert.ok(latex.includes("0\\le\\phi\\le\\frac{\\pi}{4}"));
    assert.ok(latex.includes("0"));
    assert.ok(latex.includes("\\phi"));
    assert.ok(latex.includes("\\frac{\\pi}{4}"));
    assert.ok(latex.includes("\\pi"));
    assert.ok(latex.includes("4"));
    assert.equal(latex.filter((value) => value === "\\le").length, 2);
  });

  it("keeps known function names atomic in plaintext products", () => {
    const cases = [
      { input: "sinx", root: "sinx", children: ["\\sin", "x"] },
      { input: "cosx", root: "cosx", children: ["\\cos", "x"] },
      { input: "xcosx", root: "xcosx", children: ["x", "cosx"] },
      { input: "x^2 cosx", root: "x^2cosx", children: ["x^2", "cosx"] },
      { input: "2sinx", root: "2sinx", children: ["2", "sinx"] },
    ];

    for (const item of cases) {
      const expression = annotateExpression({
        id: `expr-${item.root}`,
        latex: item.input,
        role: "other",
        problemId: "functions",
      });
      const root = expression.tokens[0];
      assert.equal(root.latex, item.root);
      assert.deepEqual(root.children.map((child) => child.latex), item.children);
    }

    const sinx = annotateExpression({ id: "expr-sinx", latex: "sinx" }).tokens[0];
    assert.equal(sinx.role, "function");
    assert.equal(sinx.children[0].role, "function");
    assert.equal(sinx.children[1].role, "argument");
  });

  it("keeps powers and additive operators as separate inspectable tokens", () => {
    const expression = annotateExpression({
      id: "expr-powers",
      latex: "x^2 + y^2 + z^2 = rho^2",
      role: "equation",
      problemId: "powers",
    });
    const root = expression.tokens[0];

    assert.equal(root.latex, "x^2+y^2+z^2=\\rho^2");
    assert.deepEqual(root.children.map((child) => child.latex), [
      "x^2",
      "+",
      "y^2",
      "+",
      "z^2",
      "=",
      "\\rho^2",
    ]);

    const xSquared = root.children.find((child) => child.latex === "x^2");
    const rhoSquared = root.children.find((child) => child.latex === "\\rho^2");
    const plus = root.children.find((child) => child.latex === "+");

    assert.equal(xSquared.role, "power");
    assert.deepEqual(xSquared.children.map((child) => child.latex), ["x", "2"]);
    assert.deepEqual(rhoSquared.children.map((child) => child.latex), ["\\rho", "2"]);
    assert.equal(plus.role, "operator");
  });

  it("normalizes plaintext inequalities while keeping addition operators separate", () => {
    const expression = annotateExpression({
      id: "expr-inequality",
      latex: "x^2 + y^2 + z^2 <= 16",
      role: "bound",
      problemId: "powers",
    });
    const root = expression.tokens[0];

    assert.equal(root.latex, "x^2+y^2+z^2\\le16");
    assert.deepEqual(root.children.map((child) => child.latex), [
      "x^2",
      "+",
      "y^2",
      "+",
      "z^2",
      "\\le",
      "16",
    ]);
  });

  it("keeps slash fractions as parent tokens with numerator and denominator children", () => {
    const expression = annotateExpression({
      id: "expr-pi-over-four",
      latex: "phi = pi/4",
      role: "equation",
      problemId: "fractions",
    });
    const root = expression.tokens[0];
    const fraction = root.children.find((child) => child.latex === "\\pi/4");

    assert.equal(fraction.role, "fraction");
    assert.deepEqual(fraction.children.map((child) => child.latex), ["\\pi", "4"]);
    assert.deepEqual(fraction.children.map((child) => child.role), ["numerator", "denominator"]);
  });

  it("keeps parenthesized fractions and functions intact in implicit products", () => {
    const expression = annotateExpression({
      id: "expr-rho-plane",
      latex: "rho = (2/3) cos(phi)",
      role: "equation",
      problemId: "fractions",
    });
    const root = expression.tokens[0];
    const product = root.children.find((child) => child.role === "product");
    const fraction = product.children.find((child) => child.role === "fraction");
    const cosine = product.children.find((child) => child.role === "function");

    assert.deepEqual(product.children.map((child) => child.latex), ["(2/3)", "cos(\\phi)"]);
    assert.deepEqual(fraction.children.map((child) => child.latex), ["2", "3"]);
    assert.deepEqual(cosine.children.map((child) => child.latex), ["\\cos", "\\phi"]);
  });

  it("keeps comparison operators separate around implicit fraction products", () => {
    const expression = annotateExpression({
      id: "expr-rho-bound",
      latex: "(2/3) cos(phi) <= rho <= 4",
      role: "bound",
      problemId: "fractions",
    });
    const root = expression.tokens[0];

    assert.deepEqual(root.children.map((child) => child.latex), [
      "(2/3)cos(\\phi)",
      "\\le",
      "\\rho",
      "\\le",
      "4",
    ]);
    assert.equal(root.children.filter((child) => child.role === "operator").length, 2);
    assert.equal(root.children[0].children[0].role, "fraction");
    assert.equal(root.children[0].children[1].role, "function");
  });

  it("keeps powers and functions intact in implicit trig products", () => {
    const expression = annotateExpression({
      id: "expr-rho-sin",
      latex: "rho^4 sin(phi)",
      role: "product",
      problemId: "fractions",
    });
    const root = expression.tokens[0];

    assert.deepEqual(root.children.map((child) => child.latex), ["\\rho^4", "sin(\\phi)"]);
    assert.equal(root.children[0].role, "power");
    assert.deepEqual(root.children[0].children.map((child) => child.latex), ["\\rho", "4"]);
    assert.equal(root.children[1].role, "function");
    assert.deepEqual(root.children[1].children.map((child) => child.latex), ["\\sin", "\\phi"]);
  });

  it("bridges annotated expressions into legacy chunk parts for rendering", () => {
    const explanation = annotateMathExplanation({
      title: "Evaluate Integral",
      originalProblem: "triple integral",
      expression: "\\iiint_E (x^2+y^2+z^2)\\,dV",
      finalAnswer: "setup",
      explanations: {
        beginner: "Set up the integral.",
        intermediate: "Use spherical coordinates.",
        advanced: "Use bounds from the region.",
      },
      tokens: [{
        id: "s1-c1",
        stepId: "s1",
        display: "0\\le\\theta\\le2\\pi",
        label: "Theta bounds",
        explanations: {
          beginner: "Theta bounds.",
          intermediate: "Theta sweeps a full circle.",
          advanced: "The region is rotationally symmetric.",
        },
      }],
      steps: [{
        id: "s1",
        label: "Assemble",
        math: "0\\le\\theta\\le2\\pi",
        summary: "Full theta sweep.",
        chunks: [{
          id: "s1-c1",
          display: "0\\le\\theta\\le2\\pi",
          short: "Theta bounds",
          medium: "Theta sweeps a full circle.",
          deep: "The region is rotationally symmetric.",
        }],
      }],
    });

    const chunk = explanation.steps[0].chunks[0];
    assert.ok(hasCompleteTokenHierarchy(explanation));
    assert.ok(chunk.parts.some((part) => part.display === "\\theta"));
    assert.ok(chunk.parts.some((part) => part.display === "2\\pi"));
    assert.ok(chunk.parts.find((part) => part.display === "2\\pi").children.length >= 2);
  });

  it("annotates manual and image-style fallback payloads without OpenAI token calls", () => {
    const manual = annotateMathExplanation({
      title: "Factor",
      originalProblem: "Factor (x+1)(x-1)",
      expression: "(x+1)(x-1)",
      finalAnswer: "x^2-1",
      explanations: { beginner: "Factor.", intermediate: "Use factors.", advanced: "Difference of squares." },
      tokens: [{ id: "s1-c1", stepId: "s1", display: "(x+1)(x-1)", label: "Product", explanations: { beginner: "Product.", intermediate: "Two factors.", advanced: "A product of conjugates." } }],
      steps: [{ id: "s1", label: "Recognize Product", math: "(x+1)(x-1)", summary: "Two factors.", chunks: [{ id: "s1-c1", display: "(x+1)(x-1)", short: "Product", medium: "Two factors.", deep: "A product of conjugates." }] }],
    });

    const image = annotateMathExplanation({
      title: "OCR Solve",
      originalProblem: "theta <= 2 pi",
      expression: "theta <= 2 pi",
      finalAnswer: "\\theta\\le2\\pi",
      explanations: { beginner: "Normalize.", intermediate: "Read OCR math.", advanced: "Normalize OCR symbols." },
      tokens: [{ id: "s1-c1", stepId: "s1", display: "theta <= 2 pi", label: "OCR bound", explanations: { beginner: "Bound.", intermediate: "Theta bound.", advanced: "Normalized angular bound." } }],
      steps: [{ id: "s1", label: "Normalize OCR", math: "theta <= 2 pi", summary: "OCR math becomes LaTeX.", chunks: [{ id: "s1-c1", display: "theta <= 2 pi", short: "OCR bound", medium: "Theta bound.", deep: "Normalized angular bound." }] }],
    });

    assert.ok(manual.steps[0].chunks[0].parts.some((part) => part.display === "(x+1)"));
    assert.ok(image.steps[0].chunks[0].parts.some((part) => part.display === "\\theta"));
    assert.equal(manual._aiUsage, undefined);
    assert.equal(image._aiUsage, undefined);
  });
});
