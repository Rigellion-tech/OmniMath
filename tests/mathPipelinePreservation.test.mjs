import assert from "node:assert/strict";
import { describe, it } from "node:test";
import katex from "katex";
import { validateExtraction } from "../server/extractionValidation.js";
import { validateGeneratedLatex } from "../server/generatedLatexValidation.js";
import { assertFastSolveResponse, assertMathExplanation, convertFastSolveToMathExplanation, sanitizeGeneratedLatex } from "../server/mathExplanationSchema.js";
import { evaluateSolutionQualityRules } from "../server/solutionValidation.js";
import { readFileSync } from "node:fs";
import { normalizeSolveResponse } from "../src/api/mathClient.js";
import { createCanonicalProblemPayload, getCanonicalMathInput, getCanonicalSolverInput } from "../src/lib/canonicalProblem.js";
import { canonicalLatexForKatex, mathNodeToLatex, normalizeLatexForKatex, normalizeLatexTransport, repairLatexForKatex } from "../src/lib/mathNode.js";
import { annotateMathExplanation, renderMathLatex } from "../src/lib/mathAnnotator.js";
import { splitEquationChainLatex } from "../src/lib/equationChains.js";
import { stripTerminalControlSequences } from "../src/lib/textSanitization.js";

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
  it("preserves TeX command boundaries while removing terminal controls", () => {
    const values = [
      "\\cos t",
      "\\cot t",
      "\\quad I",
      "\\ln x",
      "\\cos(t)",
      "\\cos^2 t",
      "\\cosh t",
      "\\sin t",
      "\\sinh t",
      "\\sin^{2n} t",
      "\\operatorname{Li}_2(\\sin^2 t)",
    ];

    for (const value of values) {
      assert.equal(stripTerminalControlSequences(`\u001b[1m${value}\u001b[0m`), value);
      assert.equal(sanitizeGeneratedLatex(value), value);
    }
  });

  it("keeps canonical step LaTeX unchanged from provider JSON through the frontend KaTeX boundary", () => {
    const sourceLatex = "x=\\tan t,\\qquad t=\\arctan x,\\qquad I=-2\\int_0^{\\pi/2} t\\ln(\\cos t)\\cot t\\,dt";
    const providerOutput = JSON.stringify({
      title: "Canonical LaTeX preservation",
      problemLatex: "x",
      steps: [{
        id: "substitution",
        heading: "Substitute",
        latex: sourceLatex,
        reasoning: "Apply a generic change of variables.",
        anchors: [],
      }],
      finalAnswerLatex: "x",
      numericCheck: "",
    });
    const parsed = JSON.parse(providerOutput);
    const structural = assertFastSolveResponse(parsed, "x");
    const presentation = convertFastSolveToMathExplanation(structural, { originalProblem: "x" });
    const frontend = normalizeSolveResponse({ explanation: presentation });
    const reactStepLatex = frontend.steps[0].lines[0].latex;
    const katexInput = canonicalLatexForKatex(reactStepLatex);

    assert.equal(parsed.steps[0].latex, sourceLatex);
    assert.equal(structural.steps[0].latex, sourceLatex);
    assert.equal(presentation.steps[0].math, sourceLatex);
    assert.equal(reactStepLatex, sourceLatex);
    assert.equal(katexInput, sourceLatex);
    assert.doesNotMatch(katexInput, /\\(?:tant|arctanx|cost|cott|qquadt|qquadI)\b/u);
    const renderedHtml = katex.renderToString(katexInput, { throwOnError: true, strict: "ignore" });
    for (const functionName of ["tan", "arctan", "ln", "cos", "cot"]) {
      assert.ok(
        renderedHtml.includes(`<span class="mop">${functionName}</span>`),
        `missing rendered operator ${functionName}`,
      );
    }
    assert.match(renderedHtml, />∫<\/span>/u);
  });

  it("preserves generic nested functions and control-word arguments at the KaTeX boundary", () => {
    const variants = [
      "\\ln(\\cos y)\\cot z",
      "\\sin u+\\cos v+\\exp w",
      "\\Gamma(n+1)\\sin y",
      "\\operatorname{erf} z+\\cos y",
      "\\int_0^a f(t)\\ln(\\cos t)\\,dt",
    ];

    for (const latex of variants) {
      assert.equal(canonicalLatexForKatex(latex), latex);
      assert.doesNotThrow(() => katex.renderToString(canonicalLatexForKatex(latex), {
        throwOnError: true,
        strict: "ignore",
      }), latex);
    }
  });

  it("preserves historical bare trig applications through rendering and repeated annotation", () => {
    const historicalSteps = [
      "\\int_0^{\\pi/2} 2 t (-\\ln \\cos t) \\cot t \\, dt = -2 \\int_0^{\\pi/2} t \\ln(\\cos t) \\cot t \\, dt",
      "I = -2 \\int_0^{\\pi/2} t \\cot t \\cdot \\ln(\\cos t) \\, dt",
      "I = -2 \\int_0^{\\pi/2} (t \\ln(\\sin t) - \\int \\ln(\\sin t) \\, dt) \\tan t \\, dt",
    ];
    const malformedCommandMerge = /\\(?:cost|cott|sint|tant|cdott)\b/u;

    for (const latex of historicalSteps) {
      assert.equal(malformedCommandMerge.test(renderMathLatex(latex)), false);
      let explanation = {
        problem: latex,
        expression: latex,
        steps: [{
          id: "historical-step",
          label: "Historical trig command boundary",
          math: latex,
          chunks: [{ id: "historical-chunk", display: latex, latex }],
          expressions: [{ id: "historical-expression", latex, role: "equation", tokens: [] }],
          lines: [{
            id: "historical-line",
            kind: "math",
            latex,
            tokens: [{ id: "historical-token", display: latex, latex }],
          }],
        }],
      };

      for (let pass = 0; pass < 2; pass += 1) {
        explanation = annotateMathExplanation(explanation);
        const step = explanation.steps[0];
        const renderedFields = [
          step.math,
          step.chunks[0].display,
          step.expressions[0].latex,
          step.lines[0].latex,
          step.lines[0].tokens[0].display,
        ];
        assert.equal(renderedFields.some((field) => malformedCommandMerge.test(field)), false);
        assert.equal(renderedFields.every((field) => field.length > 0), true);
      }
    }
  });

  it("preserves a grouped Gamma fragment from provider JSON through KaTeX input", () => {
    const gamma = "\\Gamma(n+1)";
    const rawProviderOutput = JSON.stringify({
      title: "Gamma fragment",
      problemLatex: gamma,
      steps: [{
        id: "gamma-step",
        heading: "Keep the grouped argument",
        latex: gamma,
        reasoning: "Preserve the explicitly grouped factor.",
        anchors: [],
      }],
      finalAnswerLatex: gamma,
      numericCheck: "",
    });
    const parsed = JSON.parse(rawProviderOutput);
    const solve = assertFastSolveResponse(parsed, gamma);
    const presentation = convertFastSolveToMathExplanation(solve, { originalProblem: gamma });
    const annotated = annotateMathExplanation(presentation);
    const equationSegments = splitEquationChainLatex(annotated.steps[0].math);
    const katexInput = renderMathLatex(equationSegments[0]);
    const renderedGamma = "\\Gamma\\left(n+1\\right)";

    assert.equal(rawProviderOutput.includes("\\\\Gamma(n+1)"), true);
    assert.equal(parsed.steps[0].latex, gamma);
    assert.equal(solve.steps[0].latex, gamma);
    assert.equal(presentation.steps[0].math, renderedGamma);
    assert.equal(annotated.steps[0].math, renderedGamma);
    assert.deepEqual(equationSegments, [renderedGamma]);
    assert.equal(katexInput, renderedGamma);
    assert.equal(/\\Gamman\b/u.test(katexInput), false);
    assert.doesNotThrow(() => katex.renderToString(katexInput, { throwOnError: true }));
  });

  it("preserves nested theta and quad boundaries from provider JSON through KaTeX input", () => {
    const thetaDifferential = "du=\\cos\\theta d\\theta";
    const substitutionChain = "u = \\sin\\theta, \\quad du = \\cos\\theta\\,d\\theta, \\quad \\theta = \\arcsin u, \\quad \\cos\\theta = \\sqrt{1-u^2}";
    const malformedBoundary = /\\(?:thetad|quaddu)\b/u;
    const rawProviderOutput = JSON.stringify({
      title: "Preserve substitution boundaries",
      problemLatex: "u=\\sin\\theta",
      steps: [
        {
          id: "theta-step",
          heading: "Differentiate the substitution",
          latex: thetaDifferential,
          reasoning: "Differentiate u with respect to theta.",
          anchors: [{
            id: "theta-differential",
            latex: thetaDifferential,
            type: "differential",
            priority: "high",
          }],
        },
        {
          id: "quad-step",
          heading: "Record the substitution identities",
          latex: substitutionChain,
          reasoning: "Keep the related identities together.",
          anchors: [],
        },
      ],
      finalAnswerLatex: "u=\\sin\\theta",
      numericCheck: "",
    });
    const parsed = JSON.parse(rawProviderOutput);

    assert.equal(malformedBoundary.test(rawProviderOutput), false);
    assert.equal(parsed.steps[0].anchors[0].latex, thetaDifferential);
    assert.equal(parsed.steps[1].latex, substitutionChain);
    assert.equal(validateGeneratedLatex(thetaDifferential).valid, true);
    assert.equal(validateGeneratedLatex(substitutionChain).valid, true);

    const solve = assertFastSolveResponse(parsed, parsed.problemLatex);
    assert.equal(solve.steps[0].anchors[0].latex, thetaDifferential);
    assert.equal(solve.steps[1].latex, substitutionChain);
    assert.equal(malformedBoundary.test(JSON.stringify(solve)), false);

    let presentation = convertFastSolveToMathExplanation(solve, {
      originalProblem: parsed.problemLatex,
    });
    for (let pass = 0; pass < 2; pass += 1) {
      assert.equal(malformedBoundary.test(JSON.stringify(presentation)), false, `annotation pass ${pass + 1}`);
      presentation = annotateMathExplanation(presentation);
    }

    for (const step of presentation.steps.slice(0, 2)) {
      const equationSegments = splitEquationChainLatex(step.math);
      assert.equal(equationSegments.length > 0, true);
      for (const segment of equationSegments) {
        const katexInput = renderMathLatex(segment);
        assert.equal(malformedBoundary.test(katexInput), false, segment);
        assert.doesNotThrow(() => katex.renderToString(katexInput, {
          throwOnError: true,
          strict: "ignore",
        }));
      }

      const nestedLatex = step.expressions.flatMap((expression) => {
        const flatten = (tokens = []) => tokens.flatMap((token) => [
          token.latex,
          ...flatten(token.children),
        ]);
        return flatten(expression.tokens);
      });
      for (const fragment of nestedLatex) {
        const katexInput = renderMathLatex(fragment);
        assert.equal(malformedBoundary.test(katexInput), false, fragment);
        assert.doesNotThrow(() => katex.renderToString(katexInput, {
          throwOnError: true,
          strict: "ignore",
        }));
      }
    }
  });

  it("replays the stored Terra improper-integral candidate through validation and rendering without repair", () => {
    const fixture = JSON.parse(readFileSync(new URL(
      "./fixtures/orchestration/terra-differential-quality-repair.json",
      import.meta.url,
    ), "utf8"));
    const malformedCommand = /\\(?:cost|cott|sint|tant|cdott|Gamman|thetad|quaddu|(?:Gamma|alpha|beta|gamma|delta|epsilon|theta|phi|rho|pi|lambda|mu|sigma|omega)[A-Za-z]+)\b/u;
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = async () => {
      providerCalls += 1;
      throw new Error("Provider access is forbidden during stored improper-integral replay.");
    };

    try {
      const canonical = createCanonicalProblemPayload({
        canonicalText: fixture.problem.text,
        canonicalLatex: fixture.problem.latex,
        source: "ocr-reviewed",
      });
      assert.equal(getCanonicalSolverInput(canonical), fixture.problem.text);
      assert.equal(getCanonicalMathInput(canonical), fixture.problem.latex);

      const rawProviderOutput = JSON.stringify(fixture.initialSolve);
      const parsed = JSON.parse(rawProviderOutput);
      for (const [fieldPath, latex] of [
        ["problemLatex", parsed.problemLatex],
        ...parsed.steps.map((step, index) => [`steps[${index}].latex`, step.latex]),
        ["finalAnswerLatex", parsed.finalAnswerLatex],
      ]) {
        const validation = validateGeneratedLatex(latex, { fieldPath });
        assert.equal(validation.valid, true, `${fieldPath}: ${validation.issues.join(", ")}`);
      }

      const solve = assertFastSolveResponse(parsed, getCanonicalMathInput(canonical));
      const quality = evaluateSolutionQualityRules(solve, {
        problem: getCanonicalMathInput(canonical),
      });
      assert.deepEqual(quality.issues, []);
      assert.equal(quality.context.symbolOriginDiagnostics.explicitDefinitions.includes("t"), true);
      assert.equal(quality.context.symbolOriginDiagnostics.unexplainedSymbols.includes("t"), false);
      assert.equal(quality.context.numericalCrossCheckResult.issue, null);
      assert.equal(solve.finalAnswerLatex, "\\frac{\\pi}{2}\\ln^2 2");

      let presentation = convertFastSolveToMathExplanation(solve, {
        originalProblem: getCanonicalMathInput(canonical),
        preserveProblemLatex: true,
      });
      presentation = annotateMathExplanation(annotateMathExplanation(presentation));
      assert.doesNotThrow(() => assertMathExplanation(presentation));
      assert.equal(presentation.finalAnswerLatex, "\\frac{\\pi}{2}\\ln^2 2");
      assert.equal(presentation.steps.every((step) => String(step.math || "").trim()), true);

      const mathFields = [];
      const addField = (fieldPath, value) => {
        if (typeof value === "string" && value.trim()) mathFields.push({ fieldPath, value });
      };
      const addParts = (parts, fieldPath) => {
        if (!Array.isArray(parts)) return;
        parts.forEach((part, index) => {
          addField(`${fieldPath}[${index}].latex`, part?.latex);
          addField(`${fieldPath}[${index}].display`, part?.display);
          addParts(part?.children, `${fieldPath}[${index}].children`);
        });
      };

      addField("expression", presentation.expression);
      addField("finalAnswer", presentation.finalAnswer);
      addField("finalAnswerLatex", presentation.finalAnswerLatex);
      presentation.steps.forEach((step, stepIndex) => {
        addField(`steps[${stepIndex}].math`, step.math);
        step.chunks?.forEach((chunk, chunkIndex) => {
          addField(`steps[${stepIndex}].chunks[${chunkIndex}].latex`, chunk.latex);
          addField(`steps[${stepIndex}].chunks[${chunkIndex}].display`, chunk.display);
          addParts(chunk.parts, `steps[${stepIndex}].chunks[${chunkIndex}].parts`);
        });
        step.expressions?.forEach((expression, expressionIndex) => {
          addField(`steps[${stepIndex}].expressions[${expressionIndex}].latex`, expression.latex);
          addParts(expression.tokens, `steps[${stepIndex}].expressions[${expressionIndex}].tokens`);
        });
        step.lines?.forEach((line, lineIndex) => {
          addField(`steps[${stepIndex}].lines[${lineIndex}].latex`, line.latex);
          addParts(line.tokens, `steps[${stepIndex}].lines[${lineIndex}].tokens`);
        });
      });

      assert.equal(mathFields.length > 0, true);
      for (const { fieldPath, value } of mathFields) {
        assert.equal(malformedCommand.test(value), false, `${fieldPath}: ${value}`);
        assert.notEqual(value.trim(), "=>", fieldPath);
        const segments = splitEquationChainLatex(value);
        assert.equal(segments.length > 0, true, fieldPath);
        assert.equal(segments.every((segment) => segment.trim() && segment.trim() !== "=>"), true, fieldPath);

        for (const segment of segments) {
          const converted = renderMathLatex(segment);
          const katexInput = mathNodeToLatex(converted);
          assert.equal(katexInput.length > 0, true, fieldPath);
          assert.equal(malformedCommand.test(katexInput), false, `${fieldPath}: ${katexInput}`);
          const validation = validateGeneratedLatex(katexInput, { fieldPath });
          assert.equal(validation.valid, true, `${fieldPath}: ${validation.issues.join(", ")}`);
          assert.doesNotThrow(() => katex.renderToString(katexInput, {
            throwOnError: true,
            strict: "ignore",
          }), `${fieldPath}: ${katexInput}`);
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(providerCalls, 0);
  });

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
