import assert from "node:assert/strict";
import { describe, it } from "node:test";
import katex from "katex";
import { convertFastSolveToMathExplanation, convertImageSolveToMathExplanation } from "../server/mathExplanationSchema.js";
import { normalizeDisplayText, renderMathLatex } from "../src/lib/mathAnnotator.js";

const REGRESSION_INTEGRAL = "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx";

describe("fast solve pipeline", () => {
  it("strips generated markdown and display math wrappers before rendering", () => {
    const explanation = convertFastSolveToMathExplanation({
      title: "Divergence theorem",
      problemLatex: "```latex\n\\[\n\\\\iiint_V \\\\nabla \\\\cdot (\\\\nabla \\\\times \\\\mathbf F)\\,dV\n\\]\n```",
      steps: [
        {
          id: "step-1",
          heading: "Start with the integral",
          latex: "$$\\\\iiint_V \\\\nabla \\\\cdot (\\\\nabla \\\\times \\\\mathbf F)\\,dV$$",
          reasoning: "Use the original integral.",
          anchors: [],
        },
        {
          id: "step-2",
          heading: "Use the identity",
          latex: "\\[\\\\nabla \\\\cdot (\\\\nabla \\\\times \\\\mathbf F)=0\\]",
          reasoning: "The divergence of a curl is zero.",
          anchors: [],
        },
      ],
      finalAnswerLatex: "$0$",
      numericCheck: "0",
    }, { originalProblem: "" });

    assert.equal(explanation.originalProblem, "\\iiint_V \\nabla \\cdot (\\nabla \\times \\mathbf{F})\\,dV");
    assert.equal(explanation.steps[0].math, "\\iiint_V\\nabla\\cdot(\\nabla\\times\\mathbf{F})\\,dV");
    assert.equal(explanation.steps[1].math, "\\nabla\\cdot(\\nabla\\times\\mathbf{F})=0");
    assert.equal(explanation.finalAnswerLatex, "0");
  });

  it("keeps the regression integral as the first rendered line and removes filler steps", () => {
    const explanation = convertFastSolveToMathExplanation({
      title: "Evaluate Integral",
      problemLatex: REGRESSION_INTEGRAL,
      steps: [
        {
          id: "step-1",
          heading: "Define integral",
          latex: REGRESSION_INTEGRAL,
          reasoning: "Start from the original integral.",
        },
        {
          id: "step-2",
          heading: "dx",
          latex: "dx",
          reasoning: "Differential.",
        },
        {
          id: "step-3",
          heading: "Use the substitution t = arctan x",
          latex: "t=\\arctan x",
          reasoning: "This substitution uses dt=\\frac{1}{1+x^2}\\,dx.",
          anchors: [
            {
              id: "a1",
              latex: "t=\\arctan x",
              type: "substitution",
              priority: "high",
            },
            {
              id: "bad-dx",
              latex: "dx",
              type: "differential",
              priority: "low",
            },
          ],
        },
      ],
      finalAnswerLatex: "\\frac{\\pi^3}{16}",
      numericCheck: "",
    }, { originalProblem: REGRESSION_INTEGRAL });

    assert.equal(explanation.steps[0].math, renderMathLatex(REGRESSION_INTEGRAL));
    assert.equal(explanation.steps.some((step) => step.math === "dx"), false);
    assert.equal(explanation.steps.some((step) => /Define integral/i.test(step.label)), false);

    const rendered = renderMathLatex(explanation.steps[0].math);
    const html = katex.renderToString(rendered, { throwOnError: false });
    assert.equal(html.includes("merror"), false);
    assert.equal(html.includes("katex-error"), false);
    assert.ok(rendered.includes("\\,dx"));
    assert.ok(rendered.includes("\\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}"));

    const substitutionStep = explanation.steps.find((step) => step.label.includes("substitution"));
    const anchorParts = substitutionStep.chunks[0].parts;
    assert.equal(anchorParts.length, 1);
    assert.equal(anchorParts[0].anchorId, "a1");
    assert.equal(anchorParts[0].display, "t=\\arctan x");
    assert.equal(substitutionStep.lines[0].tokens[0].parts.length, 1);
  });

  it("sanitizes common malformed vector-calculus LaTeX before KaTeX rendering", () => {
    const explanation = convertFastSolveToMathExplanation({
      title: "Stokes theorem",
      problemLatex: "\\iint limits_s (\\nabla \\times \\mathbfF)\\cdot\\mathbfn\\,dS",
      steps: [{
        id: "step-1",
        heading: "Use Stokes",
        latex: "\\iint limits_s (\\nabla \\times \\mathbfF)\\cdot\\mathbfn\\,dS=\\oint_C \\mathbfF\\cdot\\mathbfdr",
        reasoning: "Use Stokes' theorem.",
        anchors: [],
      }, {
        id: "step-2",
        heading: "Restrict field",
        latex: "\\mathbfF(x,y,0)=<e^{x^2}\\sin(y),0,xy^2>",
        reasoning: "Set z=0.",
        anchors: [],
      }],
      finalAnswerLatex: "-\\iint_D e^{x^2}\\cos(y)\\,dA",
      numericCheck: "",
    }, { originalProblem: "" });

    assert.equal(explanation.steps.some((step) => /\\mathbfF|\\mathbfn|\\mathbfdr|limits_s|lim its_s/.test(step.math)), false);
    for (const step of explanation.steps) {
      const html = katex.renderToString(step.math, { throwOnError: false });
      assert.equal(html.includes("katex-error"), false, step.math);
      assert.equal(html.includes("merror"), false, step.math);
    }
  });

  it("repairs joined prose artifacts without splitting ordinary function words", () => {
    assert.equal(normalizeDisplayText("dsointegrandbecomes"), "so the integrand becomes");
    assert.equal(normalizeDisplayText("Use the cosine identity"), "Use the cosine identity");
    assert.equal(normalizeDisplayText("Use \\quad only inside math"), "Use only inside math");
  });

  it("corrects the regression integral final answer when the exact form fails the numeric check", () => {
    const explanation = convertFastSolveToMathExplanation({
      title: "Evaluate Integral",
      problemLatex: REGRESSION_INTEGRAL,
      steps: [{
        id: "step-1",
        heading: "Start",
        latex: REGRESSION_INTEGRAL,
        reasoning: "Start with the integral.",
        anchors: [],
      }],
      finalAnswerLatex: "\\frac{7\\pi}{8}\\zeta(3)",
      numericCheck: "0.7546938294602481",
    }, { originalProblem: REGRESSION_INTEGRAL });

    assert.equal(explanation.finalAnswer, "\\frac{\\pi}{2}\\ln^2(2)");
    assert.equal(explanation.numericCheck, "0.7546938294602481");
    assert.equal(explanation.steps.at(-1).math, "\\frac{\\pi}{2}\\ln^2(2)");
  });

  it("uses extracted image problem fields instead of the generic upload prompt", () => {
    const explanation = convertImageSolveToMathExplanation({
      title: "Differentiate",
      extractedProblemLatex: "\\frac{d}{dx} x^2",
      extractedProblemText: "Differentiate x squared with respect to x.",
      steps: [
        {
          title: "Read the problem",
          equationLatex: "\\frac{d}{dx} x^2",
          explanation: "The image asks for the derivative of x squared.",
          tokens: [],
        },
        {
          title: "Apply the power rule",
          equationLatex: "\\frac{d}{dx}x^2=2x",
          explanation: "The power rule lowers the exponent and multiplies by it.",
          tokens: [{
            id: "power-rule",
            text: "x squared",
            latex: "x^2",
            role: "power",
            subtokens: [],
          }],
        },
      ],
      finalAnswerLatex: "2x",
      numericCheck: "",
    });

    assert.equal(explanation.originalProblem, "\\frac{d}{dx} x^2");
    assert.equal(explanation.extractedProblemText, "Differentiate x squared with respect to x.");
    assert.equal(explanation.extractedProblemLatex, "\\frac{d}{dx} x^2");
    assert.equal(explanation.problem.includes("Please solve"), false);
    assert.equal(explanation.steps[0].math, "\\frac{d}{dx}x^2=2x");
    assert.equal(explanation.finalAnswerLatex, "2x");
  });

  it("uses clean extracted image latex and skips duplicate problem restatement steps", () => {
    const explanation = convertImageSolveToMathExplanation({
      title: "Use curl identity",
      extractedProblemLatex: "\\iiint_V \\nabla \\cdot (\\nabla \\times \\mathbf F)\\,dV \\quad \\text{and}V\\text{isthesolidregioninsi\\,de}\\z=9 - x^2 - y^2",
      extractedProblemText: "Evaluate the divergence theorem integral.",
      steps: [
        {
          title: "Start with the problem",
          equationLatex: "\\iiint_V \\nabla \\cdot (\\nabla \\times \\mathbf F)\\,dV \\quad \\text{and}V\\text{isthesolidregioninsi\\,de}\\z=9 - x^2 - y^2",
          explanation: "This restates the uploaded problem.",
          tokens: [],
        },
        {
          title: "Recall the vector calculus identity",
          equationLatex: "\\nabla \\cdot (\\nabla \\times \\mathbf F)=0",
          explanation: "The divergence of a curl is always zero.",
          tokens: [{
            id: "identity",
            text: "divergence of a curl",
            latex: "\\nabla \\cdot (\\nabla \\times \\mathbf F)",
            role: "identity",
            subtokens: [],
          }],
        },
      ],
      finalAnswerLatex: "0",
      numericCheck: "0",
    });

    assert.equal(explanation.expression.includes("\\text{and } V"), true);
    assert.equal(explanation.expression.includes("\\text{ is the solid region inside }"), true);
    assert.equal(explanation.expression.includes("\\z"), false);
    assert.equal(explanation.expression.includes("isthesolidregioninside"), false);
    assert.equal(explanation.steps[0].label, "Recall the vector calculus identity");
    assert.equal(explanation.steps[0].math, "\\nabla\\cdot(\\nabla\\times\\mathbf{F})=0");
    assert.equal(explanation.steps[0].lines[0].text, "");
    assert.equal(explanation.steps.some((step) => /Start with the problem/i.test(step.label)), false);
    assert.equal(explanation.finalAnswerLatex, "0");
  });
});
