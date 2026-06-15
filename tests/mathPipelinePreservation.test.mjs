import assert from "node:assert/strict";
import { describe, it } from "node:test";
import katex from "katex";
import { validateExtraction } from "../server/extractionValidation.js";
import { convertFastSolveToMathExplanation } from "../server/mathExplanationSchema.js";
import { readFileSync } from "node:fs";
import { normalizeLatexForKatex, normalizeLatexTransport, repairLatexForKatex } from "../src/lib/mathNode.js";
import { renderMathLatex } from "../src/lib/mathAnnotator.js";

const PRESERVED_EXPRESSIONS = [
  "e^{x^2}",
  "\\sin(x)",
  "\\cos(xy)",
  "\\oint_C",
  "\\iint_S",
  "\\langle a,b,c \\rangle",
  "\\quad D",
  "\\ln(1+z^2)",
];

describe("math pipeline preservation", () => {
  it("sends valid extracted LaTeX to KaTeX unchanged", () => {
    for (const latex of PRESERVED_EXPRESSIONS) {
      const normalized = normalizeLatexTransport(latex);
      const katexSource = renderMathLatex(normalized);
      const html = katex.renderToString(katexSource, {
        throwOnError: true,
        strict: "ignore",
      });

      assert.equal(katexSource, normalized, latex);
      assert.equal(html.includes("katex-error"), false, latex);
      assert.equal(html.includes("merror"), false, latex);
    }
  });

  it("preserves valid LaTeX through solve conversion and annotation", () => {
    for (const latex of PRESERVED_EXPRESSIONS) {
      const explanation = convertFastSolveToMathExplanation({
        title: "Preserve expression",
        problemLatex: latex,
        steps: [{
          id: "step-1",
          heading: "Start",
          latex,
          reasoning: "Start with the extracted expression.",
          anchors: [],
        }],
        finalAnswerLatex: latex,
        numericCheck: "",
      }, { originalProblem: latex });

      const normalized = normalizeLatexTransport(latex);
      assert.equal(explanation.originalProblem, normalized);
      assert.equal(explanation.expression, normalized);
      assert.equal(explanation.steps[0].math, normalized);
      assert.equal(explanation.steps[0].lines[0].latex, normalized);
      assert.equal(explanation.finalAnswerLatex, normalized);
    }
  });

  it("separates OCR confidence from mathematical integrity", () => {
    const validation = validateExtraction({
      extractedProblemText: "\\sin(y)+\\oint_C+e^{x^2}",
      extractedProblemLatex: "sin(y)+oint_C+e^x^2",
      ocrConfidence: 92,
      modelConfidence: 92,
    });

    assert.equal(validation.ocrConfidence, 92);
    assert.equal(validation.tier, "low");
    assert.ok(validation.mathIntegrityScore < 60);
    assert.ok(validation.issues.some((issue) => issue.type === "command_stripping"));
    assert.ok(validation.issues.some((issue) => issue.type === "exponent_loss"));
  });

  it("penalizes merged commands that would fail KaTeX", () => {
    const validation = validateExtraction({
      extractedProblemText: "\\quad D",
      extractedProblemLatex: "\\quadD",
      ocrConfidence: 92,
      modelConfidence: 92,
    });

    assert.equal(validation.ocrConfidence, 92);
    assert.ok(validation.mathIntegrityScore < validation.ocrConfidence);
    assert.ok(validation.issues.some((issue) => issue.type === "malformed_command"));
  });

  it("repairs malformed math before KaTeX rendering", () => {
    const cases = [
      { input: "\\quadD", includes: "\\quad D" },
      { input: "oint_C e^x^2 sin(y) dx", includes: "\\oint_C e^{x^2} \\sin(y)" },
      { input: "iint_S(\\nabla x F) dot n dS", includes: "\\iint_S(\\nabla \\times F) \\cdot n dS" },
      { input: "\\left\\langle e^{x^2}\\sin(y),0,xy^2\\right\\rangle", includes: "\\langle e^{x^2}\\sin(y),0,xy^2\\rangle" },
      { input: "\\langle e^x^2 sin(y),0,xy^2\\right\\rangle", includes: "\\langle e^{x^2} \\sin(y),0,xy^2\\rangle" },
      { input: "C: x^2+y^2=9, \\quadz=0", includes: "C: x^2+y^2=9, \\quad z=0" },
    ];

    for (const item of cases) {
      const repaired = repairLatexForKatex(item.input).output;
      const html = katex.renderToString(repaired, {
        throwOnError: true,
        strict: "ignore",
      });

      assert.ok(repaired.includes(item.includes), `${item.input} -> ${repaired}`);
      assert.equal(html.includes("katex-error"), false, repaired);
      assert.equal(html.includes("merror"), false, repaired);
    }
  });

  it("renders required vector calculus expressions without KaTeX parse errors", () => {
    const expressions = [
      "\\langle e^{x^2}\\sin(y),0,xy^2\\rangle",
      "\\oint_C e^{x^2}\\sin(y)\\,dx",
      "-\\iint_{x^2+y^2\\le 9} e^{x^2}\\cos(y)\\,dA",
      "C: x^2+y^2=9,\\quad z=0",
      "\\iint_S(\\nabla\\times F)\\cdot n\\,dS=\\oint_C F\\cdot dr",
    ];

    for (const expression of expressions) {
      const katexInput = normalizeLatexForKatex(expression);
      const html = katex.renderToString(katexInput, {
        throwOnError: true,
        strict: "ignore",
      });

      assert.equal(html.includes("katex-error"), false, expression);
      assert.equal(html.includes("merror"), false, expression);
      assert.equal(/Math expression could not be rendered|Expected EOF|Undefined control sequence/.test(html), false);
    }
  });

  it("keeps math preview and solution lines horizontally contained by CSS", () => {
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

    assert.match(css, /\.omni-problem-preview[\s\S]*max-width:\s*100%/);
    assert.match(css, /\.omni-math-block[\s\S]*overflow-x:\s*auto/);
    assert.match(css, /\.omni-solution-line[\s\S]*overflow-x:\s*auto/);
    assert.match(css, /\[data-math-fallback="true"\][\s\S]*display:\s*none/);
  });
});
