import assert from "node:assert/strict";
import { describe, it } from "node:test";
import katex from "katex";
import {
  annotateExpression,
  annotateMathExplanation,
  hasCompleteTokenHierarchy,
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
  it("normalizes common OCR and plaintext math variants", () => {
    assert.equal(normalizeMathText("0 <= theta <= 2 pi"), "0\\le\\theta\\le2\\pi");
    assert.equal(normalizeMathText("sqrt(3) >= phi"), "\\sqrt{3}\\ge\\phi");
    assert.equal(normalizeMathText("rho^2 + pi"), "\\rho^2+\\pi");
  });

  it("preserves text command spacing and repairs malformed generated commands", () => {
    const malformed = "\\text{and}V\\text{isthesolidregioninsi\\,de}\\z=9";

    assert.equal(normalizeMathText("\\text{and } V"), "\\text{and } V");
    assert.equal(normalizeMathText("\\text{ is the solid region inside }"), "\\text{ is the solid region inside }");
    assert.equal(normalizeMathText(malformed), "\\text{and } V\\text{ is the solid region inside } z=9");
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
