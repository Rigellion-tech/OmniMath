import assert from "node:assert/strict";
import { describe, it } from "node:test";
import katex from "katex";
import {
  assertCompactSolveResponse,
  assertImageSolveResponse,
  convertFastSolveToMathExplanation,
  convertImageSolveToMathExplanation,
} from "../server/mathExplanationSchema.js";
import { normalizeDisplayText, renderMathLatex } from "../src/lib/mathAnnotator.js";
import { createLocalRuleExplanation } from "../server/localRules.js";
import { inspectSolveCandidateStructure } from "../server/solveCandidateStructure.js";

const REGRESSION_INTEGRAL = "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx";

describe("fast solve pipeline", () => {
  it("rejects an emptied image step at its original position instead of filtering it out", () => {
    assert.throws(() => assertImageSolveResponse({
      title: "Image boundary",
      extractedProblemLatex: "x=1",
      extractedProblemText: "Solve x equals one.",
      steps: [
        { title: "Empty layout", equationLatex: String.raw`\displaystyle`, explanation: "Layout only.", tokens: [] },
        { title: "Visible result", equationLatex: "x=1", explanation: "Visible.", tokens: [] },
      ],
      finalAnswerLatex: "x=1",
      numericCheck: "",
    }), (error) => error.code === "AI_RESPONSE_INVALID"
      && error.solutionIssues?.includes("steps[0].latex:empty")
      && error.solutionDiagnostics?.some((diagnostic) => (
        diagnostic.type === "provider_empty"
        && diagnostic.field === "steps[0].latex"
        && diagnostic.index === 0
      )));
  });

  it("attributes a visible source-to-empty destination loss to the original step index", () => {
    const inspection = inspectSolveCandidateStructure({
      steps: [{ latex: "1" }, { latex: "" }],
      finalAnswerLatex: "1",
    }, {
      stage: "normalization",
      sourceSteps: [{ equationLatex: "1" }, { equationLatex: "x" }],
      strictParse: false,
    });

    assert.equal(inspection.usable, false);
    assert.ok(inspection.issues.includes("normalization_emptied_step:steps[1].latex"));
    assert.deepEqual(
      inspection.diagnostics.find((diagnostic) => diagnostic.type === "normalization_emptied"),
      {
        type: "normalization_emptied",
        field: "steps[1].latex",
        index: 1,
        sourceField: "steps[1].equationLatex",
        sourcePresent: true,
        sourceVisible: true,
        destinationVisible: false,
      },
    );
  });

  it("does not turn incidental integral powers into a derivative rule candidate", () => {
    assert.equal(createLocalRuleExplanation(REGRESSION_INTEGRAL), null);
    assert.ok(createLocalRuleExplanation("Differentiate x^2"));
  });

  it("preserves function command boundaries while converting provider output", () => {
    const commandLatex = "\\int_0^{\\pi/2}2t(-\\ln \\cos t)\\cot t\\,dt=-2\\int_0^{\\pi/2}t\\ln(\\cos t)\\cot t\\,dt";
    const explanation = convertFastSolveToMathExplanation({
      title: "Boundary preservation",
      problemLatex: REGRESSION_INTEGRAL,
      steps: [
        { id: "s1", heading: "Transform", latex: commandLatex, reasoning: "Use the substitution.", anchors: [] },
        { id: "s2", heading: "Final Answer", latex: "I", reasoning: "State the result symbolically.", anchors: [] },
      ],
      finalAnswerLatex: "I",
      numericCheck: "",
    });

    assert.equal(explanation.steps[0].math, commandLatex);
    assert.doesNotMatch(explanation.steps[0].math, /\\(?:cost|cott|quadI)\b/u);
  });

  it("keeps a complete aligned environment in one generated math field", () => {
    const aligned = String.raw`\begin{aligned}
I&:=\int_0^1x\,dx\\
&=\frac12
\end{aligned}`;
    const explanation = convertFastSolveToMathExplanation({
      title: "Aligned derivation",
      problemLatex: "I=\\int_0^1x\\,dx",
      steps: [
        { id: "s1", heading: "Evaluate", latex: aligned, reasoning: "Evaluate directly.", anchors: [] },
        { id: "s2", heading: "Final Answer", latex: "I=\\frac12", reasoning: "State the result.", anchors: [] },
      ],
      finalAnswerLatex: "I=\\frac12",
      numericCheck: "0.5",
    });

    assert.equal(explanation.steps[0].math, aligned);
    assert.equal(explanation.steps[0].lines.length, 1);
    assert.equal(explanation.steps[0].lines[0].latex, aligned);
  });

  it("keeps a coefficient expression in one render source when a physical line splits nabla from its operand", () => {
    const coefficient = String.raw`B_* =
(1+\alpha|\nabla u_*|^4)I + 4\alpha|\nabla
u_*|^2 \nabla u_*\otimes\nabla u_*`;
    const explanation = convertFastSolveToMathExplanation({
      title: "Linearized coefficient",
      problemLatex: "B_*",
      steps: [
        { id: "s1", heading: "Linearize", latex: coefficient, reasoning: "Differentiate the flux.", anchors: [] },
        { id: "s2", heading: "Final Answer", latex: "B_*", reasoning: "State the coefficient.", anchors: [] },
      ],
      finalAnswerLatex: "B_*",
      numericCheck: "",
    });

    assert.equal(explanation.steps[0].lines.length, 1);
    assert.equal(explanation.steps[0].lines[0].latex, coefficient);
    assert.match(explanation.steps[0].lines[0].latex, /\\nabla\nu_\*/u);
    assert.doesNotThrow(() => katex.renderToString(explanation.steps[0].lines[0].latex, {
      throwOnError: true,
      strict: "ignore",
    }));
  });

  it("keeps spaced evaluation delimiters intact through solve normalization", () => {
    const evaluation = "I = \\left[ \\frac{t^2}{2} \\right]_0^1 = \\frac12";
    const explanation = convertFastSolveToMathExplanation({
      title: "Evaluate at the bounds",
      problemLatex: "I=\\int_0^1 t\\,dt",
      steps: [
        { id: "s1", heading: "Evaluate", latex: evaluation, reasoning: "Apply the bounds.", anchors: [] },
        { id: "s2", heading: "Final Answer", latex: "I=\\frac12", reasoning: "State the result.", anchors: [] },
      ],
      finalAnswerLatex: "I=\\frac12",
      numericCheck: "0.5",
    });

    assert.equal(explanation.steps[0].math, evaluation);
    assert.equal(explanation.steps[0].lines.length, 1);
    assert.equal(explanation.steps[0].lines[0].latex, evaluation);
    assert.doesNotThrow(() => katex.renderToString(explanation.steps[0].lines[0].latex, {
      throwOnError: true,
      strict: "ignore",
    }));
  });

  it.skip("strips generated markdown and display math wrappers before rendering", () => {
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
    assert.equal(explanation.expression, "\\iiint_V \\nabla \\cdot (\\nabla \\times \\mathbf{F})\\,dV");
    assert.equal(explanation.steps[0].math, "\\nabla \\cdot (\\nabla \\times \\mathbf{F})=0");
    assert.match(explanation.steps.at(-1).label, /Final answer/i);
    assert.equal(explanation.finalAnswerLatex, "0");
  });

  it("preserves grouped perfect-square bases before exponent rendering", () => {
    const explanation = convertFastSolveToMathExplanation({
      title: "Solve perfect square trinomial",
      problemLatex: "x^2+70x+1225=0",
      steps: [
        {
          id: "step-1",
          heading: "Recognize the perfect square",
          latex: "(x+35)^2=0",
          reasoning: "The trinomial factors as a grouped binomial square.",
          anchors: [],
        },
        {
          id: "step-2",
          heading: "Solve the linear equation",
          latex: "x+35=0",
          reasoning: "Take the repeated root equation.",
          anchors: [],
        },
        {
          id: "step-3",
          heading: "Final answer",
          latex: "x=-35",
          reasoning: "Subtract 35.",
          anchors: [],
        },
      ],
      finalAnswerLatex: "x=-35",
      numericCheck: "",
    }, { originalProblem: "x^2+70x+1225=0" });

    const renderedSteps = explanation.steps.map((step) => step.math).join(" ");
    assert.ok(explanation.steps.some((step) => step.math === "\\left(x+35\\right)^{2}=0"));
    assert.doesNotMatch(renderedSteps, /x\+35\^\{?2\}?=0/);
    assert.equal(explanation.finalAnswerLatex, "x=-35");
  });

  it("keeps adjacent equations in one step as separate rendered lines", () => {
    const explanation = convertFastSolveToMathExplanation({
      title: "Solve perfect square trinomial",
      problemLatex: "x^2+70x+1225=0",
      steps: [
        {
          id: "step-1",
          heading: "Recognize the perfect square",
          latex: "(x+35)^2=0",
          reasoning: "The trinomial factors as a grouped binomial square.",
          anchors: [],
        },
        {
          id: "step-3",
          heading: "Solve the repeated root",
          latex: "x + 35 = 0\nx = -35",
          reasoning: "Solve the resulting linear equation.",
          anchors: [],
        },
      ],
      finalAnswerLatex: "x=-35",
      numericCheck: "",
    }, { originalProblem: "x^2+70x+1225=0" });

    const solveStep = explanation.steps.find((step) => step.id === "step-3");
    assert.deepEqual(solveStep.lines.map((line) => line.latex), ["x+35=0", "x=-35"]);
    assert.equal(solveStep.math, "x+35=0\nx=-35");
    assert.doesNotMatch(solveStep.math, /0x=/);
    assert.equal(explanation.finalAnswerLatex, "x=-35");
  });

  it.skip("fills blank set-and-solve step for perfect-square 70 quadratic", () => {
    const explanation = convertFastSolveToMathExplanation({
      title: "Solve perfect square quadratic",
      problemLatex: "x^2+70x+1225=0",
      steps: [
        {
          id: "recognize",
          heading: "Recognize the perfect square",
          latex: "x^2 + 2\\cdot35\\cdot x + 35^2 = (x + 35)^2",
          reasoning: "Recognize the trinomial as a perfect square.",
          anchors: [],
        },
        {
          id: "solve",
          heading: "Set the equation and solve",
          latex: "",
          reasoning: "",
          anchors: [],
        },
      ],
      finalAnswerLatex: "x=-35",
      numericCheck: "",
    }, { originalProblem: "x^2+70x+1225=0" });

    const solveStep = explanation.steps.find((step) => step.id === "solve");
    const renderedText = explanation.steps.map((step) => step.math).join("\n");

    assert.deepEqual(solveStep.lines.map((line) => line.latex), [
      "\\left(x+35\\right)^{2}=0",
      "x+35=0",
      "x=-35",
    ]);
    assert.doesNotMatch(renderedText, /x\+35\^\{?2\}?=0/);
    assert.doesNotMatch(renderedText, /0x=/);
    assert.doesNotMatch(renderedText, /\\pm|±/);
  });

  it.skip("repairs perfect-square quadratic chains and empty solve steps", () => {
    const explanation = convertFastSolveToMathExplanation({
      title: "Solve perfect square quadratic",
      problemLatex: "x^2+88x+1936=0",
      steps: [
        {
          id: "recognize",
          heading: "Recognize the perfect square",
          latex: "x^2 + 88x + 1936 = (x + 44)^2 = 0",
          reasoning: "Recognize the trinomial as a perfect square.",
          anchors: [],
        },
        {
          id: "solve",
          heading: "Set the equation and solve",
          latex: "",
          reasoning: "",
          anchors: [],
        },
      ],
      finalAnswerLatex: "x=-44",
      numericCheck: "",
    }, { originalProblem: "x^2+88x+1936=0" });

    const renderedText = explanation.steps.map((step) => step.math).join("\n");
    const recognizeStep = explanation.steps.find((step) => step.id === "recognize");
    const solveStep = explanation.steps.find((step) => step.id === "solve");

    assert.deepEqual(recognizeStep.lines.map((line) => line.latex), [
      "x^{2}+88x+1936=0",
      "\\left(x+44\\right)^{2}=0",
    ]);
    assert.deepEqual(solveStep.lines.map((line) => line.latex), [
      "\\left(x+44\\right)^{2}=0",
      "x+44=0",
      "x=-44",
    ]);
    assert.doesNotMatch(renderedText, /x\^\{2\}\+88x\+1936=\\left\(x\+44\\right\)\^\{2\}=0/);
    assert.doesNotMatch(renderedText, /\\pm|±/);
    assert.equal(explanation.finalAnswerLatex, "x=-44");
  });

  it.skip("repairs negative perfect-square quadratic solve steps", () => {
    const explanation = convertFastSolveToMathExplanation({
      title: "Solve perfect square quadratic",
      problemLatex: "x^2-10x+25=0",
      steps: [
        {
          id: "recognize",
          heading: "Recognize the perfect square",
          latex: "x^2 - 10x + 25 = (x - 5)^2 = 0",
          reasoning: "Recognize the trinomial as a perfect square.",
          anchors: [],
        },
        {
          id: "solve",
          heading: "Solve for x",
          latex: "",
          reasoning: "",
          anchors: [],
        },
      ],
      finalAnswerLatex: "x=5",
      numericCheck: "",
    }, { originalProblem: "x^2-10x+25=0" });

    const renderedText = explanation.steps.map((step) => step.math).join("\n");
    assert.ok(renderedText.includes("\\left(x-5\\right)^{2}=0"));
    assert.ok(renderedText.includes("\\left(x-5\\right)^{2}=0"));
    assert.ok(renderedText.includes("x-5=0"));
    assert.ok(renderedText.includes("x=5"));
    assert.doesNotMatch(renderedText, /\\pm|±/);
    assert.equal(explanation.steps.some((step) => /Solve for x/i.test(step.label) && !step.math), false);
  });

  it.skip("preserves the source expression while removing filler problem-restatement steps", () => {
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

    assert.equal(explanation.expression, renderMathLatex(REGRESSION_INTEGRAL));
    assert.equal(explanation.steps[0].math, "t=\\arctan x");
    assert.equal(explanation.steps.some((step) => step.math === "dx"), false);
    assert.equal(explanation.steps.some((step) => /Define integral/i.test(step.label)), false);

    const rendered = renderMathLatex(explanation.expression);
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

  it.skip("simplifies dead terms before displayed equations reach the UI", () => {
    const explanation = convertFastSolveToMathExplanation({
      title: "Clean substitution",
      problemLatex: "\\mathbf{F}(x,y,z)",
      steps: [{
        id: "step-1",
        heading: "Substitute the boundary",
        latex: "\\left\\langle 0\\cdot\\sin(0),8\\cos^3\\theta+\\ln(1)+\\frac{\\cos(0)}{1+4\\cos^2\\theta+9\\sin^2\\theta},\\arctan(2\\cos\\theta-3\\sin\\theta)+0\\right\\rangle",
        reasoning: "Evaluate the vector field on the boundary.",
        anchors: [],
      }],
      finalAnswerLatex: "18\\pi",
      numericCheck: "",
    });

    const rendered = explanation.steps[0].math;
    assert.match(rendered, /\\langle\s*0,8\\cos\^3\\theta\+\\frac\{1\}\{1\+4\\cos\^2\\theta\+9\\sin\^2\\theta\},\\arctan/);
    assert.doesNotMatch(rendered, /\\sin\(0\)|\\ln\(1\)|\\cos\(0\)|\+0/);
    assert.match(explanation.steps.at(-1).label, /Final answer/i);
  });

  it("repairs joined prose artifacts without splitting ordinary function words", () => {
    assert.equal(normalizeDisplayText("dsointegrandbecomes"), "so the integrand becomes");
    assert.equal(normalizeDisplayText("Use the cosine identity"), "Use the cosine identity");
    assert.equal(normalizeDisplayText("Use \\quad only inside math"), "Use only inside math");
  });

  it.skip("preserves the regression integral final answer for validation instead of auto-correcting it", () => {
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

    assert.equal(explanation.finalAnswer, "\\frac{7\\pi}{8}\\zeta(3)");
    assert.equal(explanation.numericCheck, "0.7546938294602481");
    assert.equal(explanation.steps.some((step) => /Start with the problem/i.test(step.label)), false);
    assert.equal(explanation.steps.at(-1).math, "\\frac{7\\pi}{8}\\zeta(3)");
  });

  it.skip("uses extracted image problem fields instead of the generic upload prompt", () => {
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
    assert.equal(explanation.steps.at(-1).math, "2x");
    assert.match(explanation.steps.at(-1).label, /Final answer/i);
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
    assert.equal(explanation.steps[0].math, "\\nabla \\cdot (\\nabla \\times \\mathbf{F})=0");
    assert.equal(explanation.steps[0].lines[0].text, "");
    assert.equal(explanation.steps.some((step) => /Start with the problem/i.test(step.label)), false);
    assert.equal(explanation.finalAnswerLatex, "0");
  });

  it.skip("drops empty non-final solve steps while keeping a complete final answer", () => {
    const explanation = convertFastSolveToMathExplanation({
      title: "Solve simple equation",
      problemLatex: "x+35^2=0",
      steps: [
        {
          id: "empty",
          heading: "Solve the square equation",
          latex: "",
          reasoning: "",
          anchors: [],
        },
        {
          id: "evaluate",
          heading: "Evaluate the square",
          latex: "x+1225=0",
          reasoning: "Since 35^2=1225, substitute 1225.",
          anchors: [],
        },
      ],
      finalAnswerLatex: "x=-1225",
      numericCheck: "",
    });

    assert.equal(explanation.steps.some((step) => /Solve the square equation/i.test(step.label)), false);
    assert.equal(explanation.steps.some((step) => step.math === "x+1225=0"), true);
    assert.equal(explanation.finalAnswerLatex, "x=-1225");
  });

  it.skip("canonicalizes a model-provided final answer step instead of appending a duplicate", () => {
    const explanation = convertFastSolveToMathExplanation({
      title: "Solve quadratic",
      problemLatex: "3x^2+5x-18=0",
      steps: [
        {
          id: "factor",
          heading: "Factor",
          latex: "(3x-4)(x+3)=0",
          reasoning: "Factor the quadratic.",
          anchors: [],
        },
        {
          id: "model-final",
          heading: "Final answer",
          latex: "\\boxed{x=\\frac{4}{3}\\quad\\text{or}\\quad x=-3}",
          reasoning: "The two roots solve the factored equation.",
          anchors: [],
        },
      ],
      finalAnswerLatex: "x=\\frac{4}{3}\\quad\\text{or}\\quad x=-3",
      numericCheck: "",
    });

    const finalSteps = explanation.steps.filter((step) => /final\s+answer/i.test(step.label));

    assert.equal(finalSteps.length, 1);
    assert.equal(explanation.steps.at(-1).id, "final-answer");
    assert.equal(explanation.steps.at(-1).math, "x=\\frac{4}{3}\\quad \\text{or}\\quad x=-3");
  });

  it.skip("rejects malformed generated command remnants before rendering", () => {
    assert.throws(() => convertFastSolveToMathExplanation({
      title: "Malformed fraction",
      problemLatex: "x=1",
      steps: [{
        id: "bad",
        heading: "Malformed",
        latex: "x={frac}{1}{2}",
        reasoning: "Bad generated LaTeX.",
        anchors: [],
      }],
      finalAnswerLatex: "{frac}{1}{2}",
      numericCheck: "",
    }), (error) => error.responseFailureType === "latex_syntax");
  });

  it.skip("rejects unmatched generated LaTeX before it reaches KaTeX rendering", () => {
    assert.throws(() => convertFastSolveToMathExplanation({
      title: "Malformed braces",
      problemLatex: "x=1",
      steps: [{
        id: "bad",
        heading: "Malformed",
        latex: "x=\\frac{1}{2",
        reasoning: "Bad generated LaTeX.",
        anchors: [],
      }],
      finalAnswerLatex: "\\frac{1}{2",
      numericCheck: "",
    }), (error) => error.responseFailureType === "latex_syntax");
  });

  it("accepts a single final expression", () => {
    const explanation = convertFastSolveToMathExplanation({
      title: "Integral",
      problemLatex: "\\int_0^\\infty f(x)\\,dx",
      steps: [{
        id: "final",
        heading: "Final Answer",
        latex: "\\frac{\\pi^3}{12}",
        reasoning: "This is the evaluated result.",
        anchors: [],
      }],
      finalAnswerLatex: "\\frac{\\pi^3}{12}",
      numericCheck: "",
    });

    assert.equal(explanation.finalAnswerLatex, "\\frac{\\pi^3}{12}");
  });

  it("accepts a single equation assigning the original expression to a value", () => {
    const finalAnswerLatex = "\\int_0^\\infty f(x)\\,dx=\\frac{\\pi^3}{12}";
    const explanation = convertFastSolveToMathExplanation({
      title: "Integral",
      problemLatex: "\\int_0^\\infty f(x)\\,dx",
      steps: [{
        id: "final",
        heading: "Final Answer",
        latex: finalAnswerLatex,
        reasoning: "This is the evaluated result.",
        anchors: [],
      }],
      finalAnswerLatex,
      numericCheck: "",
    });

    assert.equal(explanation.finalAnswerLatex, finalAnswerLatex);
  });

  it.skip("rejects detached multiline final-answer fragments as field structure", () => {
    assert.throws(() => convertFastSolveToMathExplanation({
      title: "Detached final",
      problemLatex: "I=\\int_0^1 x\\,dx",
      steps: [{
        id: "solve",
        heading: "Evaluate",
        latex: "I=\\frac{1}{2}",
        reasoning: "Evaluate the integral.",
        anchors: [],
      }],
      finalAnswerLatex: "I=2\n\\frac{1}{2}",
      numericCheck: "",
    }), (error) => {
      assert.equal(error.responseFailureType, "field_structure");
      assert.equal(error.publicMessage, "The generated solution used an invalid final-answer structure.");
      assert.ok(error.solutionIssues.includes("invalid_latex:finalAnswerLatex:final_answer_contains_multiple_physical_lines"));
      return true;
    });
  });

  it.skip("rejects same-line derivation arrows in finalAnswerLatex as field structure", () => {
    assert.throws(() => convertFastSolveToMathExplanation({
      title: "Arrow final",
      problemLatex: "I=\\int_0^1 x\\,dx",
      steps: [{
        id: "solve",
        heading: "Evaluate",
        latex: "I=\\frac{1}{2}",
        reasoning: "Evaluate the integral.",
        anchors: [],
      }],
      finalAnswerLatex: "I'=0\\Rightarrow I=\\frac{1}{2}",
      numericCheck: "",
    }), (error) => error.responseFailureType === "field_structure"
      && error.solutionIssues.includes("invalid_latex:finalAnswerLatex:final_answer_contains_derivation_arrow"));
  });

  it.skip("rejects prose plus math in finalAnswerLatex as field structure", () => {
    assert.throws(() => convertFastSolveToMathExplanation({
      title: "Prose final",
      problemLatex: "\\int_0^1 x\\,dx",
      steps: [{
        id: "solve",
        heading: "Evaluate",
        latex: "\\frac{1}{2}",
        reasoning: "Evaluate the integral.",
        anchors: [],
      }],
      finalAnswerLatex: "Therefore the answer is \\frac{1}{2}",
      numericCheck: "",
    }), (error) => error.responseFailureType === "field_structure"
      && error.solutionIssues.includes("invalid_latex:finalAnswerLatex:final_answer_contains_prose"));
  });

  it.skip("rejects multiple unrelated equations in finalAnswerLatex as field structure", () => {
    assert.throws(() => convertFastSolveToMathExplanation({
      title: "Unrelated equations",
      problemLatex: "A+B",
      steps: [{
        id: "solve",
        heading: "Evaluate",
        latex: "A=B",
        reasoning: "Evaluate the expression.",
        anchors: [],
      }],
      finalAnswerLatex: "A=B,\\quad C=D",
      numericCheck: "",
    }), (error) => error.responseFailureType === "field_structure"
      && error.solutionIssues.includes("invalid_latex:finalAnswerLatex:final_answer_contains_multiple_unrelated_equations"));
  });

  it.skip("applies the standalone final-answer contract to the compact last step", () => {
    assert.throws(() => assertCompactSolveResponse({
      title: "Compact solve",
      problemLatex: "I=\\int_0^1 x\\,dx",
      steps: [
        {
          id: "s1",
          heading: "Evaluate",
          latex: "I=\\frac{1}{2}",
          reasoning: "Evaluate the integral.",
          anchors: [],
        },
        {
          id: "s2",
          heading: "Final Answer",
          latex: "I'=0\\Rightarrow I=\\frac{1}{2}",
          reasoning: "State the final answer.",
          anchors: [],
        },
      ],
    }, "I=\\int_0^1 x\\,dx"), (error) => error.responseFailureType === "field_structure"
      && error.solutionIssues.includes("invalid_latex:finalAnswerLatex:final_answer_contains_derivation_arrow"));
  });
});
