import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import katex from "katex";
import { annotateMathExplanation } from "../src/lib/mathAnnotator.js";
import { buildSemanticTree } from "../src/lib/mathSemanticTree.js";
import { classifySemanticNodeInteraction, createSemanticKatexTrust, serializeSemanticTreeToLatex } from "../src/lib/semanticMathRenderer.js";
import { createLocalRuleExplanation } from "../server/localRules.js";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

const ARTIFACT_DIR = "test-artifacts/layout-regression";
const ZOOM_LEVELS = [
  { label: "100", value: 1 },
  { label: "90", value: 0.9 },
  { label: "75", value: 0.75 },
  { label: "50", value: 0.5 },
];

const STOKES_PROBLEM = [
  "Use Stokes' theorem for the portion of the paraboloid z=9-x^2-y^2 above z=0,",
  "oriented upward, with boundary C.",
  "F(x,y,z)=\\langle yz^2+e^{x^2}\\sin(y),x^3z+\\ln(1+z^2),xy^2+z\\cos(xy)\\rangle.",
  "Evaluate \\iint_S(\\nabla\\times F)\\cdot n\\,dS.",
].join(" ");

const LOW_CONFIDENCE_OCR_TEXT = [
  "Let C be the boundary of the surface where z >= 0.",
  "x^2/4 + y^2/9 <= 1.",
  "The vector field includes e^{x^2}, e^{-z^2}, theta, and 2pi.",
].join(" ");

const LONG_VECTOR_FIELD_LATEX = "\\mathbf{F}(x,y,z)=\\langle y^2z+e^{x^2}\\sin(yz), x^3+\\ln(1+z^2)+\\frac{\\cos(xy)}{1+x^2+y^2}, xye^{-z^2}+\\arctan(x-y)\\rangle";
const EVALUATION_GAMMA_LATEX = "A=\\left.\\frac{\\partial^2}{\\partial a\\,\\partial b}\\frac{\\Gamma(a/2)\\Gamma(b/2)}{2\\Gamma((a+b)/2)}\\right|_{a=b=1}";
const FUNCTION_OWNERSHIP_LATEX = "\\frac{\\Gamma(a/2)\\Gamma(b/2)+\\zeta(s)+\\sin(x)+\\sin(\\cos(t))}{\\cos(x)+\\ln(x)+\\operatorname{Li}(x)}";
const SIGNED_FRACTION_LATEX = "J=-\\frac{B}{2}+\\frac{\\pi A}{4}";
const COMPLETE_CLAUSE_LATEX = "x = \\tan t,\\quad t \\in [0,\\pi/2),\\quad I=-2J,\\quad J:=\\int_0^{\\pi/2} t\\ln(\\cos t)\\cot t\\,dt";
const LEADING_FRACTION_SUM_LATEX = "-\\frac14\\sum_{n=1}^{\\infty}\\frac{1}{n^2}=-\\frac{\\pi^2}{24}";

const LONG_STOKES_PROBLEM = [
  "Use Stokes' theorem for the upward oriented paraboloid cap.",
  LONG_VECTOR_FIELD_LATEX,
  "Evaluate \\iint_S(\\nabla\\times\\mathbf{F})\\cdot\\mathbf{n}\\,dS.",
].join(" ");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createReadableMathPng() {
  const width = 1000;
  const height = 760;
  const channels = 3;
  const rowLength = width * channels;
  const raw = Buffer.alloc((rowLength + 1) * height, 255);

  for (let y = 0; y < height; y += 1) {
    raw[y * (rowLength + 1)] = 0;
  }

  const drawRect = (x, y, w, h) => {
    for (let row = y; row < y + h; row += 1) {
      if (row < 0 || row >= height) continue;
      const rowStart = row * (rowLength + 1) + 1;
      for (let col = x; col < x + w; col += 1) {
        if (col < 0 || col >= width) continue;
        const offset = rowStart + col * channels;
        raw[offset] = 10;
        raw[offset + 1] = 18;
        raw[offset + 2] = 20;
      }
    }
  };

  for (let line = 0; line < 8; line += 1) {
    const y = 90 + line * 72;
    drawRect(150, y, 680 - line * 18, 18);
    drawRect(150, y + 30, 430 + line * 20, 12);
  }
  drawRect(420, 85, 130, 230);
  drawRect(700, 200, 95, 260);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createStokesApiResponse() {
  const local = createLocalRuleExplanation(STOKES_PROBLEM, { source: "text" });
  const annotated = annotateMathExplanation(local);
  return {
    ...annotated,
    usage: {
      kind: "explanation",
      tier: "test",
      remaining: 999,
      limit: 999,
    },
    saved: false,
    source: "playwright fixture",
    demoMode: true,
  };
}

function createLazyExplanationResponse() {
  return {
    title: "Selected math",
    short: "This selected expression is part of the Stokes theorem setup.",
    medium: "The selected term is rendered in a contained hover card for layout regression coverage.",
    deep: "This deterministic response avoids external API dependencies while exercising the same hover UI.",
    relatedConcepts: [],
  };
}

function createLongLatexApiResponse() {
  const annotated = annotateMathExplanation({
    title: "Stokes theorem long vector field",
    problem: LONG_STOKES_PROBLEM,
    expression: `\\iint_S(\\nabla\\times\\mathbf{F})\\cdot\\mathbf{n}\\,dS\\quad\\text{where}\\quad ${LONG_VECTOR_FIELD_LATEX}`,
    extractedProblemText: LONG_STOKES_PROBLEM,
    extractedProblemLatex: LONG_VECTOR_FIELD_LATEX,
    steps: [
      {
        id: "long-step-1",
        label: "Apply Stokes' theorem",
        math: `\\iint_S(\\nabla\\times\\mathbf{F})\\cdot\\mathbf{n}\\,dS=\\oint_C\\mathbf{F}\\cdot d\\mathbf{r}\\quad\\text{where}\\quad ${LONG_VECTOR_FIELD_LATEX}`,
        summary: "Apply Stokes' theorem to replace the surface integral with a boundary line integral.",
      },
      {
        id: "long-step-2",
        label: "Use the boundary circle",
        math: "\\mathbf{r}(t)=\\langle 3\\cos t,3\\sin t,0\\rangle,\\quad 0\\le t\\le 2\\pi,\\quad d\\mathbf{r}=\\langle -3\\sin t,3\\cos t,0\\rangle\\,dt",
        summary: "Parametrize the circular boundary in the plane z=0.",
      },
      {
        id: "long-step-3",
        label: "Substitute parametric variables into the integrand",
        math: "x^3+\\frac{\\cos(xy)}{1+x^2+y^2}+\\arctan(x-y)=8\\cos^3\\theta+\\frac{\\cos(6\\cos\\theta\\sin\\theta)}{1+4\\cos^2\\theta+9\\sin^2\\theta}+\\arctan(2\\cos\\theta-3\\sin\\theta)",
        summary: "Substitute the parametric variables into each dense term while keeping token anchors inspectable.",
      },
      {
        id: "long-step-4",
        label: "Final answer",
        math: "\\oint_C\\mathbf{F}\\cdot d\\mathbf{r}=\\int_0^{2\\pi}\\left(81\\cos^3(t)\\sin(t)-27\\sin^3(t)+\\frac{3\\cos(9\\sin(t)\\cos(t))}{1+9\\cos^2(t)+9\\sin^2(t)}\\right)\\,dt",
        summary: "This integral form is the final answer for the boundary evaluation.",
      },
    ],
    finalAnswerLatex: "\\int_0^{2\\pi}\\left(81\\cos^3(t)\\sin(t)-27\\sin^3(t)+\\frac{3\\cos(9\\sin(t)\\cos(t))}{10}\\right)\\,dt",
  });

  return {
    ...annotated,
    usage: {
      kind: "explanation",
      tier: "test",
      remaining: 999,
      limit: 999,
    },
    saved: false,
    source: "playwright long latex fixture",
    demoMode: true,
  };
}

function createEvaluationDelimiterApiResponse() {
  const latex = "I = \\left[ \\frac{t^2}{2} \\right]_0^1 = \\frac12";
  const chunk = {
    id: "evaluation-delimiter-chunk",
    display: latex,
    latex,
    text: latex,
    role: "equation",
  };
  return {
    title: "Evaluation delimiter rendering",
    problem: "Evaluate the antiderivative at the bounds.",
    originalProblem: "Evaluate the antiderivative at the bounds.",
    expression: "\\int_0^1 t\\,dt",
    finalAnswer: "\\frac12",
    finalAnswerLatex: "\\frac12",
    steps: [{
      id: "evaluation-delimiter-step",
      label: "Evaluate at the bounds",
      math: latex,
      summary: "Evaluate the antiderivative at the upper and lower bounds.",
      chunks: [chunk],
      expressions: [{
        id: "evaluation-delimiter-expression",
        latex,
        role: "equation",
        tokens: [],
      }],
      lines: [{
        id: "evaluation-delimiter-line",
        kind: "math",
        role: "solution_step",
        text: "",
        latex,
        tokens: [chunk],
      }],
    }],
    usage: { kind: "explanation", tier: "test", remaining: 999, limit: 999 },
    saved: false,
    source: "playwright evaluation delimiter fixture",
    demoMode: true,
  };
}

function createHierarchicalTokenApiResponse() {
  const annotated = annotateMathExplanation({
    title: "Hierarchical token targets",
    problem: "Inspect algebra and vector-calculus tokens.",
    expression: "3x+45=67",
    steps: [
      {
        id: "hierarchy-step-1",
        label: "Algebra target",
        math: "3x + 45 = 67",
        summary: "Keep the equation, term, coefficient, variable, and constants inspectable.",
      },
      {
        id: "hierarchy-step-2",
        label: "Vector calculus target",
        math: "\\iint_S (\\nabla \\times F) \\cdot n\\,dS = 18\\pi",
        summary: "Keep the surface integral and its nested vector-calculus pieces inspectable.",
      },
      {
        id: "hierarchy-step-3",
        label: "Cosine power integral",
        math: "\\int_0^{2\\pi} \\cos^4\\theta\\,d\\theta = \\frac{3\\pi}{4}",
        summary: "Integral of cos^4 over [0, 2π].",
      },
      {
        id: "hierarchy-step-4",
        label: "Radial final integral",
        math: "\\int_0^1 (6r+12r^2)\\,dr",
        summary: "Evaluate the final radial integral after simplifying the integrand.",
      },
      {
        id: "hierarchy-step-5",
        label: "Odd-function integral",
        math: "3\\int_0^{2\\pi}\\cos\\theta\\,d\\theta",
        summary: "The odd-function integral cancels by symmetry.",
      },
      {
        id: "hierarchy-step-6",
        label: "Zero product simplification",
        math: "e^{4\\cos^2\\theta}\\sin(0)=0,\\quad (0)(-2\\sin\\theta)=0",
        summary: "Zero factors make each product vanish.",
      },
      {
        id: "hierarchy-step-7",
        label: "Cosine square target",
        math: "\\cos^2\\theta",
        summary: "Keep the powered cosine attached to its argument.",
      },
      {
        id: "hierarchy-step-8",
        label: "Small token product",
        math: "4r^2\\cos^2\\theta+\\sin^2\\theta",
        summary: "Hover should prefer coefficients, function names, exponents, and variables.",
      },
    ],
    finalAnswerLatex: "18\\pi",
  });

  return {
    ...annotated,
    usage: {
      kind: "explanation",
      tier: "test",
      remaining: 999,
      limit: 999,
    },
    saved: false,
    source: "playwright hierarchy fixture",
    demoMode: true,
  };
}

function createComplexIntegralHoverInvestigationResponse() {
  const originalIntegral = "\\int_0^\\infty\\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx";
  const finalAnswer = "\\frac{\\pi}{2}\\ln^2(2)";
  const steps = [
    {
      id: "complex-hover-step-1",
      label: "Step 1 tangent substitution",
      math: "x=\\tan\\theta,\\quad dx=\\sec^2\\theta\\,d\\theta,\\quad x\\,dx=\\tan\\theta\\sec^2\\theta\\,d\\theta",
      summary: "Introduce x=tan theta and transform the differential.",
    },
    {
      id: "complex-hover-nested-log-fraction",
      label: "Nested logarithmic fraction",
      math: "\\frac{\\ln\\left(1+\\frac{x^2}{1+x^2}\\right)}{1+\\frac{x}{1+x}}",
      summary: "Keep nested logarithmic fraction ownership inspectable.",
    },
    {
      id: "complex-hover-step-2",
      label: "Step 2 transformed integral",
      math: "\\int_0^{\\pi/2}\\frac{\\ln(\\sec^2\\theta)\\theta\\sec^2\\theta}{\\tan\\theta(1+\\tan^2\\theta)}\\,d\\theta=\\int_0^{\\pi/2}\\frac{\\theta\\ln(\\sec^2\\theta)}{\\sin\\theta\\cos\\theta}\\,d\\theta",
      summary: "Substitute and simplify the right hand integrand.",
    },
    {
      id: "complex-hover-step-4",
      label: "Step 4 secant cancellation",
      math: "(\\sec^2\\theta)^{a-1}\\frac{\\sec^2\\theta}{\\sec^2\\theta}=\\sec^{2a-2}\\theta",
      summary: "The secant-square factors cancel.",
    },
    {
      id: "complex-hover-step-5",
      label: "Step 5 bounded auxiliary integral",
      math: "F(a)=\\int_0^{\\pi/2}\\frac{\\theta(\\sec^{2a}\\theta-1)}{\\sin\\theta\\cos\\theta}\\,d\\theta=\\int_0^{\\pi/2}\\theta\\frac{\\cos^{-2a}\\theta-1}{\\sin\\theta\\cos\\theta}\\,d\\theta",
      summary: "Introduce a parameterized integral with a complex upper bound.",
    },
    {
      id: "complex-hover-step-6",
      label: "Step 6 right side",
      math: "F'(0)=\\int_0^{\\pi/2}\\frac{-2\\theta\\ln(\\cos\\theta)}{\\sin\\theta\\cos\\theta}\\,d\\theta=2\\int_0^{\\pi/2}\\theta\\ln(\\sec\\theta)\\csc\\theta\\sec\\theta\\,d\\theta",
      summary: "Differentiate under the integral sign.",
    },
    {
      id: "complex-hover-step-7",
      label: "Step 7 integration by parts setup",
      math: "\\int_0^{\\pi/2}\\theta\\frac{d}{d\\theta}\\ln(\\tan\\theta)\\,d\\theta=\\left[\\theta\\ln(\\tan\\theta)\\right]_0^{\\pi/2}-\\int_0^{\\pi/2}\\ln(\\tan\\theta)\\,d\\theta",
      summary: "Set up integration by parts with endpoint terms.",
    },
    {
      id: "complex-hover-step-8",
      label: "Step 8 logarithmic identity",
      math: "\\int_0^{\\pi/2}\\ln(\\cos\\theta)\\,d\\theta=-\\frac{\\pi}{2}\\ln 2,\\quad \\theta\\tan\\theta\\,d\\theta",
      summary: "Use the standard logarithmic cosine integral.",
    },
    {
      id: "complex-hover-step-9",
      label: "Step 9 differential expression",
      math: "(\\ln(\\cos\\theta)-\\theta\\tan\\theta)d\\theta=\\ln(\\cos\\theta)\\,d\\theta-\\theta\\tan\\theta\\,d\\theta",
      summary: "Expand the differential expression.",
    },
    {
      id: "complex-hover-final-step",
      label: "Final answer",
      math: `${originalIntegral}=${finalAnswer}`,
      summary: "Evaluate the original integral.",
    },
  ];
  const annotated = annotateMathExplanation({
    title: "Complex improper integral hover investigation",
    problem: originalIntegral,
    expression: originalIntegral,
    extractedProblemLatex: originalIntegral,
    steps: steps.map((step) => ({
      ...step,
      chunks: [{
        id: `${step.id}-chunk`,
        display: step.math,
        latex: step.math,
        text: step.math,
        role: "equation",
      }],
    })),
    finalAnswerLatex: finalAnswer,
  });

  return {
    ...annotated,
    usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
    saved: false,
    source: "playwright complex improper integral hover investigation fixture",
    demoMode: true,
  };
}

async function installApiFixtures(page) {
  await page.route("**/api/explain", async (route) => {
    const requestBody = route.request().postDataJSON();
    expect(requestBody.problem).toContain("Stokes");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createStokesApiResponse()),
    });
  });

  await page.route("**/api/explain-token", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createLazyExplanationResponse()),
    });
  });

  await page.route("**/api/explain-pin", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createLazyExplanationResponse()),
    });
  });
}

async function installLongLatexApiFixtures(page) {
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createLongLatexApiResponse()),
    });
  });

  await page.route("**/api/explain-token", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createLazyExplanationResponse()),
    });
  });

  await page.route("**/api/explain-pin", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createLazyExplanationResponse()),
    });
  });
}

async function installHierarchicalTokenApiFixtures(page, { lazyRequests = [] } = {}) {
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createHierarchicalTokenApiResponse()),
    });
  });

  await page.route("**/api/explain-token", async (route) => {
    const body = route.request().postDataJSON();
    lazyRequests.push({ endpoint: "hover", body });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: body?.selectedLatex === "\\frac{3\\pi}{4}" ? "3π/4 value" : `Selected ${body?.selectedLatex || "math"}`,
        explanation: body?.selectedLatex === "\\frac{3\\pi}{4}"
          ? "The value 3π/4 is the evaluated result of the integral, separate from the integral setup."
          : `${body?.selectedLatex || "This expression"} was selected.`,
      }),
    });
  });

  await page.route("**/api/explain-pin", async (route) => {
    const body = route.request().postDataJSON();
    lazyRequests.push({ endpoint: "pin", body });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: body?.selectedLatex === "\\frac{3\\pi}{4}" ? "3π/4 value" : `Pinned ${body?.selectedLatex || "math"}`,
        explanation: body?.selectedLatex === "\\frac{3\\pi}{4}"
          ? "The value 3π/4 is the evaluated result of the integral, separate from the integral setup."
          : `${body?.selectedLatex || "This expression"} was pinned.`,
      }),
    });
  });
}

async function installLocalSemanticLayerFixture(page, { lazyRequests = [], longLazyContent = false, lazyDelayMs = 0 } = {}) {
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Local semantic layer",
        problem: "Inspect 3x + 45 = 67.",
        expression: "3x+45=67",
        steps: [{
          id: "local-semantic-step",
          label: "Unannotated equation",
          math: "3x+45=67",
          summary: "The frontend should build semantic targets locally.",
          chunks: [{
            id: "local-semantic-chunk",
            display: "3x+45=67",
            latex: "3x+45=67",
            text: "3x+45=67",
            role: "equation",
            short: "Equation",
            medium: "Equation",
            deep: "Equation",
          }],
        }, {
          id: "local-semantic-fraction-step",
          label: "Nested fraction",
          math: "\\frac{\\cos(xy)}{1+x^2+y^2}",
          summary: "The frontend should expose the fraction, numerator, denominator, and function argument from AST nodes.",
          chunks: [{
            id: "local-semantic-fraction-chunk",
            display: "\\frac{\\cos(xy)}{1+x^2+y^2}",
            latex: "\\frac{\\cos(xy)}{1+x^2+y^2}",
            text: "\\frac{\\cos(xy)}{1+x^2+y^2}",
            role: "fraction",
            short: "Fraction",
            medium: "Fraction",
            deep: "Fraction",
          }],
        }, {
          id: "local-semantic-function-step",
          label: "Function argument",
          math: "\\cos(xy)",
          summary: "The frontend should expose the function argument from AST nodes.",
          chunks: [{
            id: "local-semantic-function-chunk",
            display: "\\cos(xy)",
            latex: "\\cos(xy)",
            text: "\\cos(xy)",
            role: "function",
            short: "Function",
            medium: "Function",
            deep: "Function",
          }],
        }, {
          id: "local-semantic-aggregate-integral-step",
          label: "Aggregate integral",
          math: "\\int_0^{\\pi/2}\\sin^2(x+1)\\,dx",
          summary: "The complete integral, upper bound, power, and grouped argument should all remain inspectable.",
          chunks: [{
            id: "local-semantic-aggregate-integral-chunk",
            display: "\\int_0^{\\pi/2}\\sin^2(x+1)\\,dx",
            latex: "\\int_0^{\\pi/2}\\sin^2(x+1)\\,dx",
            text: "\\int_0^{\\pi/2}\\sin^2(x+1)\\,dx",
            role: "integral",
            short: "Integral",
            medium: "Integral",
            deep: "Integral",
          }],
        }, {
          id: "local-semantic-grouped-power-step",
          label: "Grouped power expression",
          math: "(x+1)^2+\\frac{1}{x+2}",
          summary: "Grouped powers and right-hand fraction regions should expose aggregate and child targets.",
          chunks: [{
            id: "local-semantic-grouped-power-chunk",
            display: "(x+1)^2+\\frac{1}{x+2}",
            latex: "(x+1)^2+\\frac{1}{x+2}",
            text: "(x+1)^2+\\frac{1}{x+2}",
            role: "expression",
            short: "Grouped power",
            medium: "Grouped power",
            deep: "Grouped power",
          }],
        }, {
          id: "local-semantic-arctan-step",
          label: "Arctangent argument",
          math: "\\arctan(x-y)",
          summary: "The frontend should expose the function call and its argument from AST nodes.",
          chunks: [{
            id: "local-semantic-arctan-chunk",
            display: "\\arctan(x-y)",
            latex: "\\arctan(x-y)",
            text: "\\arctan(x-y)",
            role: "function",
            short: "Function",
            medium: "Function",
            deep: "Function",
          }],
        }, {
          id: "local-semantic-function-ownership-step",
          label: "Named function ownership fixture",
          math: FUNCTION_OWNERSHIP_LATEX,
          summary: "Function heads must retain identities distinct from their arguments inside nested fractions.",
          chunks: [{
            id: "local-semantic-function-ownership-chunk",
            display: FUNCTION_OWNERSHIP_LATEX,
            latex: FUNCTION_OWNERSHIP_LATEX,
            text: FUNCTION_OWNERSHIP_LATEX,
            role: "fraction",
            short: "Named functions",
            medium: "Named functions",
            deep: "Named functions",
          }],
        }, {
          id: "local-semantic-signed-fraction-step",
          label: "Signed fraction unary fixture",
          math: SIGNED_FRACTION_LATEX,
          summary: "A leading unary sign must preserve independent numerator and denominator hitboxes.",
          chunks: [{
            id: "local-semantic-signed-fraction-chunk",
            display: SIGNED_FRACTION_LATEX,
            latex: SIGNED_FRACTION_LATEX,
            text: SIGNED_FRACTION_LATEX,
            role: "equation",
            short: "Signed fraction",
            medium: "Signed fraction",
            deep: "Signed fraction",
          }],
        }, {
          id: "local-semantic-evaluation-step",
          label: "Evaluation wrapper Gamma fixture",
          math: EVALUATION_GAMMA_LATEX,
          summary: "Evaluation notation must retain granular semantic hitboxes for every inner function and operand.",
          chunks: [{
            id: "local-semantic-evaluation-chunk",
            display: EVALUATION_GAMMA_LATEX,
            latex: EVALUATION_GAMMA_LATEX,
            text: EVALUATION_GAMMA_LATEX,
            role: "evaluation",
            short: "Evaluated derivative",
            medium: "Evaluated derivative",
            deep: "Evaluated derivative",
          }],
        }, {
          id: "local-semantic-complete-clause-step",
          label: "Complete multi-clause coverage fixture",
          math: COMPLETE_CLAUSE_LATEX,
          summary: "Every clause in one display must retain authoritative semantic hover ownership.",
          chunks: [{
            id: "local-semantic-complete-clause-chunk",
            display: COMPLETE_CLAUSE_LATEX,
            latex: COMPLETE_CLAUSE_LATEX,
            text: COMPLETE_CLAUSE_LATEX,
            role: "expression",
            short: "Complete clauses",
            medium: "Complete clauses",
            deep: "Complete clauses",
          }],
        }, {
          id: "local-semantic-leading-fraction-sum-step",
          label: "Leading fraction and large operator fixture",
          math: LEADING_FRACTION_SUM_LATEX,
          summary: "A shorthand fraction next to a large operator must retain numerator and denominator ownership.",
          chunks: [{
            id: "local-semantic-leading-fraction-sum-chunk",
            display: LEADING_FRACTION_SUM_LATEX,
            latex: LEADING_FRACTION_SUM_LATEX,
            text: LEADING_FRACTION_SUM_LATEX,
            role: "equation",
            short: "Fraction and sum",
            medium: "Fraction and sum",
            deep: "Fraction and sum",
          }],
        }],
        finalAnswerLatex: "67",
        usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 7, remaining: 43, limit: 50 },
        saved: false,
        demoMode: true,
      }),
    });
  });

  for (const endpoint of ["**/api/explain-token", "**/api/explain-pin"]) {
    await page.route(endpoint, async (route) => {
      const body = route.request().postDataJSON();
      lazyRequests.push({ endpoint: endpoint.includes("pin") ? "pin" : "hover", body });
      if (lazyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, lazyDelayMs));
      const explanation = longLazyContent
        ? `${body?.selectedLatex || "This expression"} was selected. ${"This long hover explanation must wrap cleanly without horizontal clipping while the tooltip remains inside the viewport. ".repeat(8)}`
        : `${body?.selectedLatex || "This expression"} was selected.`;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: `Selected ${body?.selectedLatex || "math"}`,
          explanation,
          responseTextLength: explanation.length,
        }),
      });
    });
  }
}

async function applyBrowserZoom(page, zoom) {
  await page.evaluate((zoomValue) => {
    document.documentElement.style.zoom = String(zoomValue);
    document.body.dataset.layoutRegressionZoom = String(zoomValue);
    window.dispatchEvent(new Event("resize"));
  }, zoom);
  await page.waitForTimeout(250);
}

async function assertLayoutIntegrity(page, { checkHover = false } = {}) {
  const errors = await page.evaluate(({ checkHover }) => {
    const failures = [];
    const intersects = (left, right) => !(
      left.right <= right.left + tolerance
      || left.left >= right.right - tolerance
      || left.bottom <= right.top + tolerance
      || left.top >= right.bottom - tolerance
    );
    const viewportWidth = document.documentElement.clientWidth;
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const zoomValue = Number(document.body.dataset.layoutRegressionZoom || "1") || 1;
    const visualPageWidth = pageWidth * zoomValue;
    const tolerance = 2;

    if (visualPageWidth > viewportWidth + tolerance) {
      failures.push(`page width ${visualPageWidth} exceeds viewport ${viewportWidth} at zoom ${zoomValue}`);
    }

    const errorNodes = document.querySelectorAll(".katex-error, merror, [data-math-fallback='true']");
    if (errorNodes.length > 0) {
      failures.push(`${errorNodes.length} KaTeX error/fallback node(s) found`);
    }

    const internalTextPattern = /KaTeX parse error|Expected EOF|Undefined control sequence|stack trace|could not be rendered/i;
    if (internalTextPattern.test(document.body.innerText || "")) {
      failures.push("user-facing text contains KaTeX/internal fallback content");
    }

    const main = document.querySelector("main");
    const mainRect = main?.getBoundingClientRect();
    const topPreview = document.querySelector(".omni-problem-summary-card, .omni-problem-preview");
    const topRect = topPreview?.getBoundingClientRect();
    if (!mainRect || !topRect) {
      failures.push("missing main content or top equation preview");
    } else if (topRect.left < mainRect.left - tolerance || topRect.right > mainRect.right + tolerance) {
      failures.push(`top equation preview escapes content column (${topRect.left}, ${topRect.right}) vs (${mainRect.left}, ${mainRect.right})`);
    }

    for (const container of document.querySelectorAll(".omni-problem-preview, .omni-math-block, .omni-solution-line")) {
      const rect = container.getBoundingClientRect();
      const parentRect = container.parentElement?.getBoundingClientRect();
      if (!parentRect || rect.width === 0 || rect.height === 0) continue;
      if (rect.left < parentRect.left - tolerance || rect.right > parentRect.right + tolerance) {
        failures.push(`equation container exceeds parent width: ${container.className}`);
      }
    }

    for (const line of document.querySelectorAll(".omni-solution-line")) {
      const rect = line.getBoundingClientRect();
      if (rect.width <= 0 || rect.height < 14) {
        failures.push(`solution line is not readable: ${line.textContent?.slice(0, 80) || line.className}`);
      }
    }

    for (const math of document.querySelectorAll(".katex")) {
      const rect = math.getBoundingClientRect();
      const style = getComputedStyle(math);
      if (style.visibility === "hidden" || rect.width === 0 || rect.height === 0) continue;
      const container = math.closest(".omni-problem-preview, .omni-math-block, .omni-solution-line");
      const containerRect = container?.getBoundingClientRect();
      const containerStyle = container ? getComputedStyle(container) : null;
      if (containerRect && containerStyle?.overflowY === "hidden" && rect.bottom > containerRect.bottom + tolerance) {
        failures.push(`math appears vertically clipped: ${math.textContent?.slice(0, 80) || "katex"}`);
      }
    }

    if (checkHover) {
      const target = document.querySelector("[data-layout-hover-target='true']");
      const targetRect = target?.getBoundingClientRect();
      const windows = [...document.querySelectorAll(".omni-floating-window, .omni-quick-tooltip")]
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0);

      if (windows.length === 0) {
        failures.push("hover did not open a tooltip/window");
      }

      if (targetRect) {
        for (const { node, rect } of windows) {
          if (node.classList.contains("omni-quick-tooltip")) continue;
          if (intersects(targetRect, rect)) {
            failures.push(`hover tooltip overlaps selected math target: target=${JSON.stringify({
              left: targetRect.left,
              right: targetRect.right,
              top: targetRect.top,
              bottom: targetRect.bottom,
            })} tooltip=${JSON.stringify({
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            })}`);
          }
        }
      }

      for (let i = 0; i < windows.length; i += 1) {
        for (let j = i + 1; j < windows.length; j += 1) {
          if (intersects(windows[i].rect, windows[j].rect)) {
            failures.push("floating tooltip/window bounding boxes overlap");
          }
        }
      }
    }

    return failures;
  }, { checkHover });

  expect(errors).toEqual([]);
}

async function settleSemanticScroll(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => {
      window.__OMNIMATH_SCROLL_COORDINATOR__?.flush?.();
      resolve();
    });
  }));
}

async function moveSemanticPointer(page, x, y) {
  await settleSemanticScroll(page);
  await page.mouse.move(x, y, { steps: 1 });
  const delivered = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return Boolean(element?.closest?.(".math-semantic-hitbox[data-token-id], [data-inspectable='math-token']"));
  }, { x, y });
  if (delivered) return;

  await page.evaluate(({ x, y }) => {
    const containsPoint = (rect) => (
      x >= rect.left
      && x <= rect.right
      && y >= rect.top
      && y <= rect.bottom
    );
    const overlayHost = [...document.querySelectorAll(".math-semantic-hitbox[data-token-id]")]
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && containsPoint(rect))
      .sort((left, right) => (left.rect.width * left.rect.height) - (right.rect.width * right.rect.height))[0]
      ?.node
      ?.closest("[data-inspectable='math-token']");
    const nativeHost = document
      .elementFromPoint(x, y)
      ?.closest?.("[data-inspectable='math-token']");
    const nearestHost = [...document.querySelectorAll("[data-inspectable='math-token']")]
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
        const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
        return { node, distance: Math.hypot(dx, dy) };
      })
      .sort((left, right) => left.distance - right.distance)[0]
      ?.node;
    const host = overlayHost || nativeHost || nearestHost;
    if (!host) return;
    host.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }));
  }, { x, y });
}

async function contextClickSemanticPointer(page, x, y) {
  await page.evaluate(({ x, y }) => {
    const containsPoint = (rect) => (
      x >= rect.left
      && x <= rect.right
      && y >= rect.top
      && y <= rect.bottom
    );
    const host = [...document.querySelectorAll(".math-semantic-hitbox[data-token-id]")]
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && containsPoint(rect))
      .sort((left, right) => (left.rect.width * left.rect.height) - (right.rect.width * right.rect.height))[0]
      ?.node
      ?.closest("[data-inspectable='math-token']");
    if (!host) return;
    host.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 2,
    }));
  }, { x, y });
}

test("Stokes theorem solution stays contained and renderable at browser zoom levels", async ({ page }) => {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await installApiFixtures(page);

  const browserConsoleErrors = [];
  page.on("console", (message) => {
    const text = message.text();
    if (
      message.type() === "error"
      && /KaTeX parse error|Expected EOF|Undefined control sequence|\[omnimath:math-render-error\]/i.test(text)
    ) {
      browserConsoleErrors.push(text);
    }
  });

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, STOKES_PROBLEM);

  await expect(page.getByText("Stokes' theorem setup")).toBeVisible();
  await expect(page.locator(".omni-solution-line").first()).toBeVisible();

  for (const zoom of ZOOM_LEVELS) {
    await applyBrowserZoom(page, zoom.value);
    await page.evaluate(() => window.scrollTo(0, 0));
    await assertLayoutIntegrity(page);

    const hoverTarget = page.locator("[data-inspectable='math-subtoken']").first();
    await expect(hoverTarget).toBeVisible();
    await hoverTarget.evaluate((node) => node.setAttribute("data-layout-hover-target", "true"));
    await hoverTarget.hover({ force: true });
    await page.waitForTimeout(800);
    await assertLayoutIntegrity(page, { checkHover: true });

    await page.screenshot({
      path: `${ARTIFACT_DIR}/stokes-zoom-${zoom.label}.png`,
      fullPage: true,
    });

    await page.mouse.move(4, 4);
    await hoverTarget.evaluate((node) => node.removeAttribute("data-layout-hover-target"));
  }

  expect(browserConsoleErrors).toEqual([]);
});

test("hierarchical math tokens expose nested hover, pin, drag, tooltip, and KaTeX targets", async ({ page }) => {
  await installHierarchicalTokenApiFixtures(page);
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect 3x + 45 = 67 and a Stokes surface integral.");

  await expect(page.getByRole("button", { name: /Algebra target/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Vector calculus target/i })).toBeVisible();

  for (const latex of ["3", "x", "45", "67", "S", "n", "dS", "18", "\\\\pi"]) {
    await expect(page.locator(`[data-inspectable='math-subtoken'][data-token-latex='${latex}']`).first()).toBeVisible();
  }

  const xToken = page.locator("[data-inspectable='math-subtoken'][data-token-latex='x']").first();
  await xToken.evaluate((node) => node.setAttribute("data-layout-hover-target", "true"));
  const xTokenBox = await xToken.boundingBox();
  expect(xTokenBox).not.toBeNull();
  await page.mouse.move(xTokenBox.x + xTokenBox.width / 2, xTokenBox.y + xTokenBox.height / 2);
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
  await assertLayoutIntegrity(page, { checkHover: true });
  await xToken.evaluate((node) => node.removeAttribute("data-layout-hover-target"));

  const vectorTokenBox = await page.locator("[data-inspectable='math-subtoken'][data-token-latex='n']").first().boundingBox();
  expect(vectorTokenBox).not.toBeNull();
  await page.mouse.click(vectorTokenBox.x + vectorTokenBox.width / 2, vectorTokenBox.y + vectorTokenBox.height / 2, { button: "right" });
  await expect(page.locator(".omni-floating-window")).toBeVisible();

  const start = await page.locator("[data-inspectable='math-subtoken'][data-token-latex='3']").first().boundingBox();
  const end = await page.locator("[data-inspectable='math-subtoken'][data-token-latex='67']").first().boundingBox();
  expect(start).not.toBeNull();
  expect(end).not.toBeNull();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".omni-solution-flow .omni-token-selected")).not.toHaveCount(0);

  await assertLayoutIntegrity(page);

  await page.reload();
  await submitCurrentComposer(page, "Reload hierarchy fixture.");
  await expect(page.locator("[data-inspectable='math-subtoken'][data-token-latex='dS']").first()).toBeVisible();
  await expect(page.locator(".omni-solution-flow .katex")).not.toHaveCount(0);
  await assertLayoutIntegrity(page);
});

test("local semantic layer creates subtoken targets without solver annotations", async ({ page }) => {
  const lazyRequests = [];
  await installLocalSemanticLayerFixture(page, { lazyRequests });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect local semantic parsing.");
  await expect(page.getByText(/Explanation ready/i)).toBeVisible();

  const hoverLatex = async (latex, expectedLatex = latex, xRatio = 0.5, stepLabel = null) => {
    await expect.poll(() => page.evaluate(({ targetLatex, stepLabel: label }) => {
      const scope = label
        ? [...document.querySelectorAll(".step-card")].find((card) => card.textContent?.includes(label))
        : document;
      return [...(scope?.querySelectorAll("[data-inspectable='math-subtoken']") || [])]
        .some((candidate) => candidate.getAttribute("data-token-latex") === targetLatex);
    }, { targetLatex: latex, stepLabel })).toBe(true);
    const targetHandle = await page.evaluateHandle(({ targetLatex, stepLabel: label }) => {
      const scope = label
        ? [...document.querySelectorAll(".step-card")].find((card) => card.textContent?.includes(label))
        : document;
      return [...(scope?.querySelectorAll("[data-inspectable='math-subtoken']") || [])]
        .find((candidate) => candidate.getAttribute("data-token-latex") === targetLatex);
    }, { targetLatex: latex, stepLabel });
    const target = targetHandle.asElement();
    expect(target).not.toBeNull();
    const box = await page.evaluate(({ targetLatex, stepLabel: label }) => {
      const scope = label
        ? [...document.querySelectorAll(".step-card")].find((card) => card.textContent?.includes(label))
        : document;
      const node = [...(scope?.querySelectorAll("[data-inspectable='math-subtoken']") || [])]
        .find((candidate) => candidate.getAttribute("data-token-latex") === targetLatex);
      node.scrollIntoView({ block: "center", inline: "center" });
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, { targetLatex: latex, stepLabel });
    await moveSemanticPointer(
      page,
      box.x + Math.max(1, box.width * xRatio),
      box.y + Math.max(1, box.height / 2)
    );
    await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
    if (expectedLatex !== null) {
      await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex)
        .toBe(expectedLatex);
    }
    return box;
  };

  await hoverLatex("x");
  await expect(page.locator(".omni-quick-tooltip")).toContainText("x");
  await hoverLatex("3");
  const fortyFive = await hoverLatex("45");
  await page.mouse.click(fortyFive.x + fortyFive.width / 2, fortyFive.y + fortyFive.height / 2, { button: "right" });
  await expect(page.locator(".omni-floating-window")).toBeVisible();
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "pin").at(-1)?.body?.selectedLatex).toBe("45");
  await page.getByRole("button", { name: /Close explanation/i }).click();
  await expect(page.locator(".omni-floating-window")).toHaveCount(0);

  const sixtySeven = await hoverLatex("67");
  await page.mouse.move(fortyFive.x + fortyFive.width / 2, fortyFive.y + fortyFive.height / 2);
  await page.mouse.down();
  await page.mouse.move(sixtySeven.x + sixtySeven.width / 2, sixtySeven.y + sixtySeven.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".omni-solution-flow .omni-token-selected")).not.toHaveCount(0);
  await page.mouse.click(6, 6);
  await page.mouse.move(6, 6);

  await expect(page.locator("[data-inspectable='math-subtoken'][data-token-latex='\\\\frac{\\\\cos(xy)}{1+x^2+y^2}']")).toHaveCount(0);
  await hoverLatex("\\cos", "\\cos", 0.5, "Nested fraction");
  const xInFraction = await hoverLatex("x", "x", 0.5, "Nested fraction");
  const yInFraction = await hoverLatex("y", "y", 0.5, "Nested fraction");
  await page.mouse.click(yInFraction.x + yInFraction.width / 2, yInFraction.y + yInFraction.height / 2, { button: "right" });
  await expect(page.locator(".omni-floating-window")).toBeVisible();
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "pin").at(-1)?.body?.selectedLatex).toBe("y");
  await page.getByRole("button", { name: /Close explanation/i }).click();
  await expect(page.locator(".omni-floating-window")).toHaveCount(0);

  await page.mouse.move(xInFraction.x + xInFraction.width / 2, xInFraction.y + xInFraction.height / 2);
  await page.mouse.down();
  await page.mouse.move(yInFraction.x + yInFraction.width / 2, yInFraction.y + yInFraction.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".omni-solution-flow .omni-token-selected")).not.toHaveCount(0);
  await page.mouse.click(6, 6);
  await page.mouse.move(6, 6);

  await hoverLatex("\\arctan", null);
  await expect(page.locator(".omni-quick-tooltip")).toContainText(/arctan|Function name/i);
  const arctanXTarget = page.locator("[data-inspectable='math-subtoken'][data-token-id*='arctan'][data-token-latex='x']").first();
  await expect(arctanXTarget).toBeVisible();
  const arctanX = await arctanXTarget.boundingBox();
  expect(arctanX).not.toBeNull();
  await moveSemanticPointer(page, arctanX.x + arctanX.width / 2, arctanX.y + arctanX.height / 2);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("x");
  await page.mouse.click(arctanX.x + arctanX.width / 2, arctanX.y + arctanX.height / 2, { button: "right" });
  await expect(page.locator(".omni-floating-window")).toBeVisible();
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "pin").at(-1)?.body?.selectedLatex).toBe("x");
});

test("evaluation wrappers preserve reachable granular Gamma hitboxes", async ({ page }) => {
  const lazyRequests = [];
  await installLocalSemanticLayerFixture(page, { lazyRequests });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect evaluation wrapper hitboxes.");

  const tree = buildSemanticTree({
    stepId: "browser-evaluation-fixture",
    displayLatex: EVALUATION_GAMMA_LATEX,
    enabled: true,
  });
  const gammaFraction = tree.flatNodes.find((node) => (
    node.type === "fraction"
    && node.latex.includes("\\Gamma(a/2)")
  ));
  const condition = tree.flatNodes.find((node) => node.role === "evaluationCondition");
  const expectedLeaves = tree.flatNodes.filter((node) => {
    if (node.childIds.length > 0 || ["delimiter", "evaluationBar"].includes(node.role)) return false;
    if (tree.displayLatex.slice(node.sourceRange.start, node.sourceRange.end) !== node.latex) return false;
    const insideGammaFraction = node.sourceRange.start >= gammaFraction.sourceRange.start
      && node.sourceRange.end <= gammaFraction.sourceRange.end;
    const insideCondition = node.sourceRange.start >= condition.sourceRange.start
      && node.sourceRange.end <= condition.sourceRange.end;
    return insideGammaFraction || insideCondition;
  });

  const step = page.locator(".step-card").filter({ hasText: "Evaluation wrapper Gamma fixture" });
  await expect(step).toBeVisible();
  await expect.poll(async () => step.locator(".math-semantic-hitbox[data-target-kind='leaf']").count())
    .toBeGreaterThanOrEqual(expectedLeaves.length);

  for (const expected of expectedLeaves) {
    const target = step.locator(
      `.math-semantic-hitbox[data-target-kind='leaf'][data-source-range="${expected.sourceRange.start}:${expected.sourceRange.end}"]`
    ).first();
    await expect(target, `missing reachable hitbox for ${expected.id}`).toBeVisible();
    await expect(target).toHaveAttribute("data-token-latex", expected.latex);
    await expect(target).toHaveAttribute("data-geometry-valid", "true");
    const box = await target.boundingBox();
    expect(box, `missing geometry for ${expected.id}`).not.toBeNull();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    await moveSemanticPointer(page, box.x + box.width / 2, box.y + box.height / 2);
    const semanticId = await target.getAttribute("data-semantic-id");
    await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", semanticId);
  }

  const gammaIds = await step.locator(".math-semantic-hitbox[data-target-kind='leaf']").evaluateAll((nodes) =>
    nodes
      .filter((node) => node.getAttribute("data-token-latex") === "\\Gamma")
      .map((node) => node.getAttribute("data-semantic-id")),
  );
  expect(gammaIds).toHaveLength(3);
  expect(new Set(gammaIds).size).toBe(3);
});

test("render-time semantic ownership keeps named function heads distinct from arguments", async ({ page }) => {
  await installLocalSemanticLayerFixture(page);
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect named function ownership.");

  const stepId = "local-semantic-function-ownership-step";
  const chunkId = "local-semantic-function-ownership-chunk";
  const tree = buildSemanticTree({
    stepId: `${chunkId}-${stepId}`,
    displayLatex: FUNCTION_OWNERSHIP_LATEX,
    enabled: true,
  });
  const expectedVisibleHeads = ["Γ", "Γ", "ζ", "sin", "sin", "cos", "cos", "ln", "Li"];
  const functionHeads = tree.flatNodes.filter((node) => node.role === "functionName");
  const step = page.locator(".step-card").filter({ hasText: "Named function ownership fixture" });

  await expect(step).toBeVisible();
  expect(functionHeads).toHaveLength(expectedVisibleHeads.length);

  const semanticLeafIds = tree.flatNodes
    .filter((node) => !Array.isArray(node.childIds) || node.childIds.length === 0)
    .map((node) => node.id);
  const contaminatedLeafOwners = await step.evaluate((stepElement, leafIds) => {
    const contamination = [];
    for (const leafId of leafIds) {
      for (const owner of stepElement.querySelectorAll(`[data-semantic-id="${CSS.escape(leafId)}"]`)) {
        const unrelatedDescendant = [...owner.querySelectorAll("[data-semantic-id]")]
          .find((descendant) => descendant.getAttribute("data-semantic-id") !== leafId);
        if (unrelatedDescendant) {
          contamination.push({
            leafId,
            descendantId: unrelatedDescendant.getAttribute("data-semantic-id"),
          });
        }
      }
    }
    return contamination;
  }, semanticLeafIds);
  expect(contaminatedLeafOwners).toEqual([]);

  for (const [index, head] of functionHeads.entries()) {
    const call = tree.nodeMap[head.parentId];
    const argument = tree.nodeMap[call.childIds.find((id) => tree.nodeMap[id]?.role === "argument")];
    const visibleHead = expectedVisibleHeads[index];
    const owner = step.locator(`.katex-html [data-semantic-id="${head.id}"]`).first();

    expect(argument?.id, `missing argument for ${head.latex}`).toBeTruthy();
    expect(head.id).not.toBe(argument.id);
    await expect(owner, `missing authoritative DOM owner for ${head.latex}`).toBeVisible();
    await expect(owner).toHaveText(visibleHead);
    await expect(owner).toHaveAttribute("data-semantic-role", "functionName");

    const argumentOwnsHead = await step.locator(`.katex-html [data-semantic-id="${argument.id}"]`).evaluateAll(
      (nodes, expectedText) => nodes.some((node) => (node.textContent || "").includes(expectedText)),
      visibleHead,
    );
    expect(argumentOwnsHead, `${head.latex} must not inherit its argument identity`).toBe(false);

    const box = await owner.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const rects = [];
      let textNode = walker.nextNode();
      while (textNode) {
        if ((textNode.textContent || "").trim()) {
          const range = document.createRange();
          range.selectNodeContents(textNode);
          rects.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0));
        }
        textNode = walker.nextNode();
      }
      if (rects.length === 0) return null;
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return { x: left, y: top, width: right - left, height: bottom - top };
    });
    expect(box, `missing visible head geometry for ${head.latex}`).not.toBeNull();
    await moveSemanticPointer(page, box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", head.id);
    await expect(step.locator(`.math-semantic-hitbox[data-semantic-id="${head.id}"]`).first()).toBeVisible();
  }
});

test("leading unary fractions preserve pointer-reachable numerator and denominator hitboxes", async ({ page }) => {
  const lazyRequests = [];
  await installLocalSemanticLayerFixture(page, { lazyRequests });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect signed fraction hitboxes.");

  const step = page.locator(".step-card").filter({ hasText: "Signed fraction unary fixture" });
  await expect(step).toBeVisible();

  for (const expected of [
    { latex: "B", range: "9:10" },
    { latex: "2", range: "12:13" },
  ]) {
    const target = step.locator(
      `.math-semantic-hitbox[data-target-kind='leaf'][data-source-range="${expected.range}"][data-token-latex="${expected.latex}"]`,
    ).first();
    await expect(target).toBeVisible();
    await expect(target).toHaveAttribute("data-geometry-valid", "true");
    await target.scrollIntoViewIfNeeded();
    const semanticId = await target.getAttribute("data-semantic-id");
    const box = await target.boundingBox();
    expect(box, `missing geometry for ${expected.latex}`).not.toBeNull();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await moveSemanticPointer(page, center.x, center.y);
    await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", semanticId);
  }
});

test("complete clauses and shorthand fractions have no silent interactive hover gaps", async ({ page }) => {
  await installLocalSemanticLayerFixture(page);
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Audit complete semantic hover coverage.");

  const fixtures = [
    {
      label: "Complete multi-clause coverage fixture",
      stepId: "local-semantic-complete-clause-step",
      chunkId: "local-semantic-complete-clause-chunk",
      latex: COMPLETE_CLAUSE_LATEX,
    },
    {
      label: "Leading fraction and large operator fixture",
      stepId: "local-semantic-leading-fraction-sum-step",
      chunkId: "local-semantic-leading-fraction-sum-chunk",
      latex: LEADING_FRACTION_SUM_LATEX,
    },
  ];

  for (const fixture of fixtures) {
    const step = page.locator(".step-card").filter({
      has: page.locator(`[data-token-id="${fixture.chunkId}"]`),
    });
    await expect(step).toBeVisible();
    const renderedLatex = await step.locator(`[data-token-id="${fixture.chunkId}"]`).getAttribute("data-token-latex");
    const tree = buildSemanticTree({
      stepId: `${fixture.chunkId}-${fixture.stepId}`,
      displayLatex: renderedLatex,
      enabled: true,
    });
    const interactiveLeaves = tree.flatNodes.filter((node) => (
      classifySemanticNodeInteraction(node, tree.displayLatex).interactive
    ));
    const rendering = serializeSemanticTreeToLatex(tree);
    const serializedIds = new Set(rendering.annotatedNodeIds);
    const safeInteractiveLeaves = interactiveLeaves.filter((node) => serializedIds.has(node.id));
    expect(safeInteractiveLeaves.length, `${fixture.label} lost all safely serializable interactive leaves`).toBeGreaterThan(0);
    await expect.poll(async () => {
      const emittedIds = new Set(await step.locator(".math-semantic-hitbox[data-target-kind='leaf']")
        .evaluateAll((hitboxes) => hitboxes.map((hitbox) => hitbox.getAttribute("data-semantic-id"))));
      return safeInteractiveLeaves.every((node) => emittedIds.has(node.id));
    }).toBe(true);
    const emittedIds = new Set(await step.locator(".math-semantic-hitbox[data-target-kind='leaf']")
      .evaluateAll((hitboxes) => hitboxes.map((hitbox) => hitbox.getAttribute("data-semantic-id"))));
    const emittedInteractiveLeaves = interactiveLeaves.filter((node) => emittedIds.has(node.id));
    const unsupportedInteractiveLeaves = interactiveLeaves.filter((node) => !emittedIds.has(node.id));

    for (const leaf of unsupportedInteractiveLeaves) {
      const diagnostic = rendering.nodeDiagnostics.find((item) => item.semanticId === leaf.id);
      expect(diagnostic?.annotationStatus, `${leaf.id} was omitted without an explicit annotation status`).toBe("unsupported");
      expect(diagnostic?.reason || "", `${leaf.id} was omitted without a layout or grammar diagnostic`)
        .toMatch(/^(?:tex-layout-changed|tex-parse-structure-changed|katex-rejected-wrapper-boundary)$/);
      await expect(step.locator(`.katex-html [data-semantic-id="${leaf.id}"]`)).toHaveCount(0);
      await expect(step.locator(`.math-semantic-hitbox[data-semantic-id="${leaf.id}"]`)).toHaveCount(0);
    }

    for (const [leafIndex, leaf] of emittedInteractiveLeaves.entries()) {
      const hitbox = step.locator(`.math-semantic-hitbox[data-semantic-id="${leaf.id}"]`).first();
      const owner = step.locator(`.katex-html [data-semantic-id="${leaf.id}"]`).first();
      await expect(hitbox, `missing reachable hitbox for ${leaf.id}`).toBeVisible();
      await expect(hitbox).toHaveAttribute("data-geometry-valid", "true");
      await expect(owner, `missing authoritative DOM annotation for ${leaf.id}`).toBeVisible();
      const pointerEvents = await hitbox.evaluate((element) => (
        getComputedStyle(element.closest("[data-math-chunk-owner]")).pointerEvents
      ));
      expect(pointerEvents, `${leaf.id} has no interactive chunk owner`).not.toBe("none");
      const box = await hitbox.boundingBox();
      expect(box, `missing measured geometry for ${leaf.id}`).not.toBeNull();
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
      if (leafIndex === 0 || leafIndex === emittedInteractiveLeaves.length - 1) {
        await hitbox.scrollIntoViewIfNeeded();
        const currentBox = await hitbox.boundingBox();
        await moveSemanticPointer(page, currentBox.x + currentBox.width / 2, currentBox.y + currentBox.height / 2);
        await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", leaf.id);
      }
    }
  }
});

test("quick tooltip owns hover across portal insertion and stale source clears", async ({ page }) => {
  const lazyRequests = [];
  await installLocalSemanticLayerFixture(page, {
    lazyRequests,
    longLazyContent: true,
    lazyDelayMs: 50,
  });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect hover lifetime.");

  const xToken = page.locator("[data-inspectable='math-subtoken'][data-token-latex='x']").first();
  await expect(xToken).toBeVisible();
  const xBox = await xToken.boundingBox();
  expect(xBox).not.toBeNull();
  await moveSemanticPointer(page, xBox.x + xBox.width / 2, xBox.y + xBox.height / 2);

  const tooltip = page.locator(".omni-quick-tooltip");
  await expect(tooltip).toBeVisible();
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex)
    .toBe("x");
  await expect(tooltip).toContainText(/long hover explanation/i);
  const xSemanticId = await xToken.getAttribute("data-semantic-id");
  await expect(tooltip).toHaveAttribute("data-tooltip-semantic-id", xSemanticId);

  await xToken.evaluate((node, pointer) => {
    const source = node.closest("[data-inspectable='math-token']");
    const quickTooltip = document.querySelector(".omni-quick-tooltip");
    source?.dispatchEvent(new MouseEvent("mouseout", {
      bubbles: true,
      relatedTarget: quickTooltip,
      clientX: pointer.x,
      clientY: pointer.y,
    }));
  }, { x: xBox.x + xBox.width / 2, y: xBox.y + xBox.height / 2 });
  await page.waitForTimeout(350);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute("data-tooltip-semantic-id", xSemanticId);

  await tooltip.evaluate((node, pointer) => {
    const source = document.querySelector("[data-inspectable='math-subtoken'][data-token-latex='x']")
      ?.closest("[data-inspectable='math-token']");
    node.dispatchEvent(new MouseEvent("mouseout", {
      bubbles: true,
      relatedTarget: source,
      clientX: pointer.x,
      clientY: pointer.y,
    }));
  }, { x: xBox.x + xBox.width / 2, y: xBox.y + xBox.height / 2 });
  await page.waitForTimeout(350);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute("data-tooltip-semantic-id", xSemanticId);

  await xToken.evaluate((node, pointer) => {
    const source = node.closest("[data-inspectable='math-token']");
    source?.dispatchEvent(new MouseEvent("mouseout", {
      bubbles: true,
      relatedTarget: document.body,
      clientX: pointer.x,
      clientY: pointer.y,
    }));
  }, { x: xBox.x + xBox.width / 2, y: xBox.y + xBox.height / 2 });
  const fortyFive = page.locator("[data-inspectable='math-subtoken'][data-token-latex='45']").first();
  const fortyFiveBox = await fortyFive.boundingBox();
  expect(fortyFiveBox).not.toBeNull();
  await moveSemanticPointer(
    page,
    fortyFiveBox.x + fortyFiveBox.width / 2,
    fortyFiveBox.y + fortyFiveBox.height / 2
  );
  const fortyFiveSemanticId = await fortyFive.getAttribute("data-semantic-id");
  await expect(tooltip).toHaveAttribute("data-tooltip-semantic-id", fortyFiveSemanticId);
  await page.waitForTimeout(350);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute("data-tooltip-semantic-id", fortyFiveSemanticId);

  await page.mouse.move(4, 4);
  await expect(tooltip).toHaveCount(0);
});

test("one typed submission produces one initial solve request despite rapid duplicate actions", async ({ page }) => {
  let solveRequests = 0;
  let releaseSolve;
  const solveGate = new Promise((resolve) => {
    releaseSolve = resolve;
  });
  await page.route("**/api/explain", async (route) => {
    solveRequests += 1;
    await solveGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createHierarchicalTokenApiResponse()),
    });
  });
  await page.route("**/api/explain-token", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createLazyExplanationResponse()),
    });
  });

  await page.goto("/?mockAuth=1");
  await page.getByTestId("primary-composer-activate").click();
  await page.getByPlaceholder("Describe assumptions, boundary conditions, or what should be found…").fill("Inspect 3x + 45 = 67.");
  const explainButton = page.getByTestId("primary-composer-solve");
  await explainButton.click();
  await page.keyboard.press("Enter");
  await explainButton.click({ force: true, timeout: 150 }).catch(() => {});
  await page.waitForTimeout(100);
  releaseSolve();

  await expect(page.getByRole("button", { name: /Algebra target/i })).toBeVisible();
  expect(solveRequests).toBe(1);
});

test("debug hover performance counters prove pointer movement uses cached semantic geometry", async ({ page }) => {
  await installLocalSemanticLayerFixture(page);
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect local semantic hover performance.");
  await expect(page.getByText(/Explanation ready/i)).toBeVisible();

  const target = page.locator("[data-inspectable='math-subtoken'][data-token-latex='x']").first();
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await target.hover({ force: true });
  await page.waitForTimeout(300);

  const stableRenderState = await target.evaluate((node) => {
    const owner = node.closest("[data-inspectable='math-token']");
    return {
      sourceDomInstance: owner?.getAttribute("data-source-dom-instance") || null,
      measurementRevisions: [...(owner?.querySelectorAll(".math-semantic-hitbox[data-measurement-revision]") || [])]
        .map((hitbox) => hitbox.getAttribute("data-measurement-revision")),
    };
  });

  const debugEnabled = await page.evaluate(() => Boolean(window.__OMNIMATH_HOVER_PERF__));
  test.skip(!debugEnabled, "Set VITE_DEBUG_MATH_HOVER=1 or VITE_DEBUG_MATH_HOVER_PERF=1 to enable investigation counters.");
  await page.evaluate(() => {
    window.__OMNIMATH_HOVER_PERF__.createdAt = Date.now();
    window.__OMNIMATH_HOVER_PERF__.counters = {};
    window.__OMNIMATH_HOVER_PERF__.last = {};
    window.__OMNIMATH_HOVER_PERF__.events = [];
    window.__OMNIMATH_PERF__?.reset?.();
  });

  await target.evaluate((node) => {
    const host = node.closest("[data-inspectable='math-token']") || node;
    const rect = node.getBoundingClientRect();
    for (let index = 0; index < 12; index += 1) {
      host.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + Math.max(1, Math.min(rect.width - 1, rect.width / 2 + index * 0.2)),
        clientY: rect.top + Math.max(1, rect.height / 2),
      }));
    }
  });
  await page.waitForTimeout(120);

  const counters = await page.evaluate(() => window.__OMNIMATH_HOVER_PERF__?.counters || {});
  expect(counters.annotatedMouseMove || 0).toBeGreaterThanOrEqual(10);
  expect(counters.pointerResolve || 0).toBeGreaterThanOrEqual(10);
  expect(counters.getBoundingClientRectCalls || 0).toBe(0);
  expect(counters.querySelectorAllCalls || 0).toBe(0);
  expect(counters.pointerLayoutReadCount || 0).toBe(0);
  expect(counters.geometryMeasurement || 0).toBe(0);
  expect(counters.mathChunkRender || 0).toBe(0);
  expect(counters.sameTargetMoveSkipped || 0).toBeGreaterThanOrEqual(8);

  const postMoveState = await target.evaluate((node) => {
    const owner = node.closest("[data-inspectable='math-token']");
    return {
      sourceDomInstance: owner?.getAttribute("data-source-dom-instance") || null,
      measurementRevisions: [...(owner?.querySelectorAll(".math-semantic-hitbox[data-measurement-revision]") || [])]
        .map((hitbox) => hitbox.getAttribute("data-measurement-revision")),
    };
  });
  expect(postMoveState).toEqual(stableRenderState);

  const appPerfCounters = await page.evaluate(() => window.__OMNIMATH_PERF__?.counters || {});
  expect(appPerfCounters["semantic-tree.generate"] || 0).toBe(0);
  expect(appPerfCounters["semantic-tree.flatten-targets"] || 0).toBe(0);
  expect(appPerfCounters["semantic.geometry.measurement"] || 0).toBe(0);

  const overlayPointerEvents = await page.evaluate(() => (
    [...document.querySelectorAll(".math-semantic-hitbox[data-token-id]")]
      .map((node) => window.getComputedStyle(node).pointerEvents)
  ));
  expect(overlayPointerEvents.length).toBeGreaterThan(0);
  expect(overlayPointerEvents.every((value) => value === "none")).toBe(true);

  const invalidationDebug = await page.evaluate(() => {
    window.__OMNIMATH_HOVER_PERF__.counters = {};
    window.__OMNIMATH_HOVER_PERF__.last = {};
    window.__OMNIMATH_HOVER_PERF__.events = [];
    const chunkId = document
      .querySelector("[data-inspectable='math-subtoken'][data-token-latex='x']")
      ?.closest("[data-inspectable='math-token']")
      ?.getAttribute("data-token-id");
    for (let index = 0; index < 5; index += 1) {
      window.__OMNIMATH_HOVER_PERF__.invalidateSemanticGeometry?.("debug-coalesced-invalidation", chunkId);
    }
    return {
      chunkId,
      registryKeys: Object.keys(window.__OMNIMATH_HOVER_PERF__.invalidateSemanticGeometryByChunk || {}),
      hasInvalidator: typeof window.__OMNIMATH_HOVER_PERF__.invalidateSemanticGeometry === "function",
      counters: window.__OMNIMATH_HOVER_PERF__.counters,
    };
  });
  expect(invalidationDebug.hasInvalidator).toBe(true);
  expect(invalidationDebug.registryKeys).toContain(invalidationDebug.chunkId);
  await expect.poll(() => page.evaluate(() => window.__OMNIMATH_HOVER_PERF__?.counters?.geometryMeasurement || 0)).toBeGreaterThanOrEqual(1);
  const invalidationCounters = await page.evaluate(() => window.__OMNIMATH_HOVER_PERF__?.counters || {});
  expect(invalidationCounters.geometryInvalidated || 0).toBeGreaterThanOrEqual(5);
  expect(invalidationCounters.geometryMeasurement || 0).toBe(1);
});

test("shared scroll coordinator translates cached geometry without semantic reconstruction", async ({ page }) => {
  await installLocalSemanticLayerFixture(page);
  await page.setViewportSize({ width: 760, height: 420 });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect local semantic hover performance.");

  const firstTarget = page.locator("[data-inspectable='math-subtoken'][data-token-latex='x']").first();
  const lowerTarget = page.locator(".step-card", { has: page.getByRole("button", { name: /Arctangent argument/i }) })
    .locator("[data-inspectable='math-subtoken'][data-token-latex='x']").first();
  await expect(firstTarget).toBeVisible();
  await expect(lowerTarget).toHaveCount(1);
  await page.waitForTimeout(350);

  const debugEnabled = await page.evaluate(() => Boolean(window.__OMNIMATH_HOVER_PERF__));
  test.skip(!debugEnabled, "Set VITE_DEBUG_MATH_HOVER=1 or VITE_DEBUG_MATH_HOVER_PERF=1 to enable investigation counters.");
  const baseline = await firstTarget.evaluate((node) => ({
    owner: node.closest("[data-math-chunk-owner]")?.getAttribute("data-source-dom-instance"),
    revision: node.getAttribute("data-measurement-revision"),
  }));
  const sharedListenerState = await page.evaluate(() => ({
    maxSubscribers: window.__OMNIMATH_SCROLL_COORDINATOR__?.maxSubscribersPerTarget || 0,
    sharedTargets: window.__OMNIMATH_SCROLL_COORDINATOR__?.sharedTargets || 0,
  }));
  expect(sharedListenerState.maxSubscribers).toBeGreaterThan(1);
  expect(sharedListenerState.sharedTargets).toBeGreaterThan(0);

  await page.evaluate(() => {
    window.__OMNIMATH_HOVER_PERF__.reset();
    window.__OMNIMATH_SCROLL_COORDINATOR__?.reset?.();
    window.__OMNIMATH_PERF__?.reset?.();
  });
  for (const top of [160, 320, 480, 240, 0]) {
    await page.evaluate((value) => window.scrollTo(0, value), top);
    await page.waitForTimeout(40);
  }

  const counters = await page.evaluate(() => window.__OMNIMATH_HOVER_PERF__?.counters || {});
  const coordinator = await page.evaluate(() => ({
    physicalScrollCallbacks: window.__OMNIMATH_SCROLL_COORDINATOR__?.physicalScrollCallbacks || 0,
    subscriberNotifications: window.__OMNIMATH_SCROLL_COORDINATOR__?.subscriberNotifications || 0,
  }));
  const appCounters = await page.evaluate(() => window.__OMNIMATH_PERF__?.counters || {});
  expect(counters.geometryTranslation || 0).toBeGreaterThan(0);
  expect(counters.geometryReconstruction || 0).toBe(0);
  expect(counters.geometryMeasurement || 0).toBe(0);
  expect(counters.getClientRectsCalls || 0).toBe(0);
  expect(counters.querySelectorAllCalls || 0).toBe(0);
  expect(counters.mathChunkRender || 0).toBe(0);
  expect(appCounters["semantic-tree.generate"] || 0).toBe(0);
  expect(appCounters["semantic-tree.flatten-targets"] || 0).toBe(0);
  expect(appCounters["react.commit"] || 0).toBe(0);
  expect(coordinator.physicalScrollCallbacks).toBeLessThan(coordinator.subscriberNotifications);

  const afterScroll = await firstTarget.evaluate((node) => ({
    owner: node.closest("[data-math-chunk-owner]")?.getAttribute("data-source-dom-instance"),
    revision: node.getAttribute("data-measurement-revision"),
  }));
  expect(afterScroll).toEqual(baseline);
  await firstTarget.scrollIntoViewIfNeeded();
  const firstTargetBox = await firstTarget.boundingBox();
  expect(firstTargetBox).not.toBeNull();
  await moveSemanticPointer(
    page,
    firstTargetBox.x + firstTargetBox.width / 2,
    firstTargetBox.y + firstTargetBox.height / 2
  );
  await expect(firstTarget).toHaveAttribute("data-active-target", "true");

  const transformedScale = await page.evaluate(() => {
    const target = document.querySelector("[data-inspectable='math-subtoken'][data-token-latex='x']");
    const transformedAncestor = target?.closest(".step-card");
    const owner = target?.closest("[data-math-chunk-owner]");
    const beforeWidth = owner?.getBoundingClientRect().width || 0;
    if (transformedAncestor) {
      transformedAncestor.style.transform = "scale(0.9)";
      transformedAncestor.style.transformOrigin = "top left";
    }
    const afterWidth = owner?.getBoundingClientRect().width || 0;
    window.scrollTo(0, 120);
    window.dispatchEvent(new Event("scroll"));
    return { beforeWidth, afterWidth };
  });
  expect(transformedScale.afterWidth).toBeLessThan(transformedScale.beforeWidth);
  await expect.poll(() => page.evaluate(() => (
    window.__OMNIMATH_HOVER_PERF__?.last?.geometryTransformInvalidated?.reason || ""
  ))).toBe("transform-change");
  await expect.poll(() => page.evaluate(() => (
    window.__OMNIMATH_HOVER_PERF__?.last?.geometryReconstruction?.reason || ""
  ))).toBe("transform-change");
  await lowerTarget.scrollIntoViewIfNeeded();
  const lowerTargetBox = await lowerTarget.boundingBox();
  expect(lowerTargetBox).not.toBeNull();
  await moveSemanticPointer(
    page,
    lowerTargetBox.x + lowerTargetBox.width / 2,
    lowerTargetBox.y + lowerTargetBox.height / 2
  );
  await expect(lowerTarget).toHaveAttribute("data-active-target", "true");

  const listenerCountBeforeUnmount = await page.evaluate(() => (
    window.__OMNIMATH_SCROLL_COORDINATOR__?.physicalListeners || 0
  ));
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    window.__OMNIMATH_SCROLL_COORDINATOR__?.physicalListeners || 0
  ))).toBeLessThan(listenerCountBeforeUnmount);
});

test("aggregate semantic hover and quick tooltip stay stable at viewport edges", async ({ page }) => {
  const lazyRequests = [];
  await installLocalSemanticLayerFixture(page, { lazyRequests, longLazyContent: true, lazyDelayMs: 150 });
  await page.setViewportSize({ width: 520, height: 420 });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect aggregate semantic parsing.");
  await expect(page.getByRole("button", { name: /Aggregate integral/i })).toBeVisible();

  const targetBox = async (stepLabel, role, kind = "group", occurrence = 0) => page.evaluate(({ stepLabel, role, kind, occurrence }) => {
    const step = [...document.querySelectorAll(".step-card")]
      .find((card) => card.textContent?.includes(stepLabel));
    const selector = kind === "any"
      ? `.math-semantic-hitbox[data-token-role='${role}']`
      : `.math-semantic-hitbox[data-target-kind='${kind}'][data-token-role='${role}']`;
    const candidates = [...(step?.querySelectorAll(selector) || [])]
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .sort((left, right) => (right.rect.width * right.rect.height) - (left.rect.width * left.rect.height));
    const selected = candidates[occurrence]?.node || null;
    if (!selected) return null;
    selected.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = selected.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      latex: selected.getAttribute("data-token-latex"),
      semanticId: selected.getAttribute("data-semantic-id"),
    };
  }, { stepLabel, role, kind, occurrence });

  const groupGapPoint = async (stepLabel, role) => {
    const semanticId = await page.evaluate(({ stepLabel, role }) => {
      const step = [...document.querySelectorAll(".step-card")]
        .find((card) => card.textContent?.includes(stepLabel));
      const group = [...(step?.querySelectorAll(`.math-semantic-hitbox[data-target-kind='group'][data-token-role='${role}'][data-hitbox-region='internal-gap']`) || [])]
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width >= 2 && rect.height >= 2)
        .sort((left, right) => right.rect.width - left.rect.width || right.rect.height - left.rect.height)[0]?.node;
      if (!group) return null;
      group.scrollIntoView({ block: "center", inline: "nearest" });
      return group.getAttribute("data-semantic-id");
    }, { stepLabel, role });
    if (!semanticId) return null;
    await page.waitForTimeout(80);
    return page.evaluate(({ stepLabel, role, semanticId }) => {
      const step = [...document.querySelectorAll(".step-card")]
        .find((card) => card.textContent?.includes(stepLabel));
      const group = [...(step?.querySelectorAll(`.math-semantic-hitbox[data-target-kind='group'][data-token-role='${role}'][data-hitbox-region='internal-gap']`) || [])]
        .filter((candidate) => candidate.getAttribute("data-semantic-id") === semanticId)
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width >= 2 && rect.height >= 2)
        .sort((left, right) => right.rect.width - left.rect.width || right.rect.height - left.rect.height)[0]?.node;
      if (!group) return null;
      const groupRect = group.getBoundingClientRect();
      return {
        x: groupRect.left + groupRect.width / 2,
        y: groupRect.top + groupRect.height / 2,
        semanticId,
        latex: group.getAttribute("data-token-latex"),
        role: group.getAttribute("data-token-role"),
      };
    }, { stepLabel, role, semanticId });
  };

  const hoverAndRead = async (box, position = { x: 0.82, y: 0.58 }) => {
    expect(box).not.toBeNull();
    await page.mouse.move(4, 4, { steps: 1 });
    await page.waitForTimeout(180);
    const previous = lazyRequests.filter((request) => request.endpoint === "hover").length;
    await moveSemanticPointer(page, box.x + Math.max(1, box.width * position.x), box.y + Math.max(1, box.height * position.y));
    await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
    await page.waitForTimeout(180);
    const hoverRequests = lazyRequests.filter((request) => request.endpoint === "hover");
    if (hoverRequests.length > previous) return hoverRequests.at(-1)?.body;
    return page.evaluate(() => {
      const diagnostic = window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__ || {};
      return {
        selectedLatex: diagnostic.chosenLatex || diagnostic.selected?.selectedText || diagnostic.selected?.sourceText || "",
        selectedNode: {
          role: diagnostic.chosenRole || diagnostic.selected?.role || "",
          aggregate: Boolean(diagnostic.selected?.aggregate),
          sourceRange: diagnostic.selected?.sourceRange || null,
        },
        semanticId: diagnostic.chosenNodeId || diagnostic.selected?.semanticId || null,
      };
    });
  };

  const fullIntegral = await targetBox("Aggregate integral", "integral", "group");
  const integralGap = await groupGapPoint("Aggregate integral", "integral");
  expect(integralGap).not.toBeNull();
  const fullBody = await hoverAndRead({ ...fullIntegral, ...integralGap, width: 1, height: 1 }, { x: 0, y: 0 });
  expect(fullBody.selectedLatex).toContain("\\int");
  expect(fullBody.selectedNode?.role).toBe("integral");
  expect(fullBody.selectedNode?.aggregate).toBe(true);
  expect(fullBody.selectedNode?.sourceRange).toBeTruthy();

  const upperDenominator = await targetBox("Aggregate integral", "denominator", "leaf");
  const upperBody = await hoverAndRead(upperDenominator, { x: 0.5, y: 0.5 });
  expect(upperBody.selectedLatex).toBe("2");
  expect(upperBody.selectedNode?.role).toBe("denominator");
  expect(upperBody.semanticId).not.toBe(fullIntegral.semanticId);

  const power = await targetBox("Grouped power expression", "power", "group");
  expect(power).not.toBeNull();
  expect(power.latex).toContain("^2");

  const base = await targetBox("Grouped power expression", "variable", "leaf");
  const baseBody = await hoverAndRead(base, { x: 0.5, y: 0.5 });
  expect(baseBody.selectedLatex).toBe("x");
  expect(baseBody.selectedNode?.role).toBe("variable");

  const exponent = await targetBox("Grouped power expression", "exponent", "leaf");
  const exponentBody = await hoverAndRead(exponent, { x: 0.5, y: 0.5 });
  expect(exponentBody.selectedLatex).toBe("2");
  expect(exponentBody.selectedNode?.role).toBe("exponent");

  const denominator = await targetBox("Grouped power expression", "denominator", "group");
  const denominatorGap = await groupGapPoint("Grouped power expression", "denominator");
  expect(denominatorGap).not.toBeNull();
  const denominatorBody = await hoverAndRead({ ...denominator, ...denominatorGap, width: 1, height: 1 }, { x: 0, y: 0 });
  expect(denominatorBody.selectedNode?.role).toBe("denominator");
  expect(denominatorBody.selectedNode?.aggregate).toBe(true);

  const tooltip = page.locator(".omni-quick-tooltip");
  await expect(tooltip).toHaveAttribute("data-lazy-phase", "ready");
  await expect(tooltip).toContainText(/long hover explanation must wrap cleanly/i);
  await expect.poll(() => tooltip.evaluate((node) => new Promise((resolve) => {
    const before = node.getBoundingClientRect();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const after = node.getBoundingClientRect();
      resolve(
        Math.abs(after.x - before.x) < 1
        && Math.abs(after.y - before.y) < 1
        && Math.abs(after.width - before.width) < 1
        && Math.abs(after.height - before.height) < 1
      );
    }));
  }))).toBe(true);
  const tooltipBox = await tooltip.boundingBox();
  expect(tooltipBox).not.toBeNull();
  expect(tooltipBox.x).toBeGreaterThanOrEqual(11);
  expect(tooltipBox.y).toBeGreaterThanOrEqual(11);
  expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(521);
  expect(tooltipBox.y + tooltipBox.height).toBeLessThanOrEqual(421);
  const overflow = await tooltip.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    textLength: node.textContent?.length || 0,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.textLength).toBeGreaterThan(20);

  await page.mouse.move(tooltipBox.x + tooltipBox.width / 2, tooltipBox.y + Math.min(tooltipBox.height - 2, 20));
  await page.waitForTimeout(220);
  await expect(tooltip).toBeVisible();
});

test("malformed solver math does not render as raw LaTeX text", async ({ page }) => {
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        requestId: "render-malformed-request",
        title: "Malformed fixture",
        problem: "Malformed fixture",
        expression: "{frac}",
        steps: [{
          id: "malformed-step",
          label: "Malformed generated math",
          math: "{frac}",
          summary: "Malformed math should fail closed.",
          chunks: [{ id: "bad", display: "{frac}", latex: "{frac}", text: "{frac}", role: "equation" }],
          lines: [{ id: "bad-line", kind: "math", role: "solution_step", text: "", latex: "{frac}", tokens: [] }],
        }],
        finalAnswerLatex: "{frac}",
        finalAnswer: "{frac}",
        usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
        saved: false,
        demoMode: true,
      }),
    });
  });

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Malformed fixture.");
  await expect(page.getByText("Malformed generated math")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("{frac}");
  await expect(page.locator("[data-math-render-error='true']")).not.toHaveCount(0);
  const failed = page.locator("article[data-step-id='malformed-step'] [data-math-render-outcome='render_failed']").first();
  await expect(failed).toContainText("Equation could not be rendered.");
  await expect(failed).toBeVisible();
  await expect(failed.locator("xpath=ancestor::article[1]")).toHaveAttribute("data-solve-request-id", "render-malformed-request");
  await expect(failed.locator("xpath=ancestor::article[1]")).toHaveAttribute("data-step-id", "malformed-step");
});

test("blank render output stays visible and correlated without dropping whitespace positions", async ({ page }) => {
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        requestId: "render-empty-request",
        title: "Rendered empty fixture",
        problem: "Rendered empty fixture",
        expression: "x=1",
        steps: [
          {
            id: "layout-only-step",
            label: "Layout-only step",
            math: "\\displaystyle",
            summary: "The renderer should expose a visible fallback.",
            chunks: [{ id: "space", display: "   ", latex: "   ", text: "   " }],
            lines: [{ id: "space-line", kind: "math", text: "   ", latex: "   ", tokens: [] }],
          },
          {
            id: "spacing-step",
            label: "Spacing step",
            math: "\\hspace{1em}",
            summary: "Spacing contains no painted glyph.",
            chunks: [],
            lines: [],
          },
          {
            id: "smash-step",
            label: "Smash step",
            math: "\\smash{x}",
            summary: "Smash changes layout but keeps its glyph visible.",
            chunks: [],
            lines: [],
          },
          {
            id: "rule-step",
            label: "Rule step",
            math: "\\rule{1em}{1em}",
            summary: "A painted rule is visible without text.",
            chunks: [],
            lines: [],
          },
          {
            id: "valid-fallback-step",
            label: "Valid fallback",
            math: "x=1",
            chunks: [{}],
            lines: [{ latex: "   ", text: "   ", tokens: [] }],
          },
          null,
        ],
        finalAnswerLatex: "x=1",
        usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
      }),
    });
  });

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Rendered empty fixture.");

  await expect(page.locator(".omni-solution-flow article")).toHaveCount(6);
  const emptyOutputs = page.locator("[data-math-render-outcome='rendered_empty']");
  await expect(emptyOutputs).toHaveCount(1);
  await expect(page.getByText("Equation could not be rendered.")).toHaveCount(2);
  await expect(page.locator("article[data-step-id='layout-only-step'] [data-math-render-outcome='render_input_empty']")).toBeVisible();
  await expect(page.locator("article[data-step-id='spacing-step'] [data-math-render-outcome='rendered_empty']")).toBeVisible();
  await expect(page.locator("article[data-step-id='layout-only-step']")).toHaveAttribute("data-step-index", "0");
  await expect(page.locator("article[data-step-id='spacing-step']")).toHaveAttribute("data-step-index", "1");
  await expect(page.locator("article[data-step-id='smash-step'] [data-math-render-outcome='rendered']")).toBeVisible();
  await expect(page.locator("article[data-step-id='rule-step'] [data-math-render-outcome='rendered']")).toBeVisible();
  await expect(page.locator("article[data-step-id='valid-fallback-step'] .katex-html")).toContainText("x=1");
  await expect(page.locator("article[data-step-index='5']")).toHaveAttribute("data-step-boundary-error", "accepted_empty");
  await expect(page.getByText("This solution step was empty or malformed and could not be rendered.").first()).toBeVisible();
  await expect(page.locator(".omni-solution-flow")).toHaveAttribute("data-solve-request-id", "render-empty-request");
});

test("semantic geometry covers composite KaTeX leaves without whole-step fallback", async ({ page }) => {
  const lazyRequests = [];
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Composite geometry coverage",
        problem: "Inspect composite geometry.",
        expression: "\\int_0^1 \\frac{\\ln(1+x)+\\cos(x)}{1+x^2}\\,dx",
        steps: [{
          id: "geo-quadratic",
          label: "Geometry quadratic",
          math: "3x^2+5x-451=0",
          summary: "Simple quadratic leaves remain covered.",
          chunks: [{ id: "geo-quadratic-chunk", display: "3x^2+5x-451=0", latex: "3x^2+5x-451=0", text: "3x^2+5x-451=0", role: "equation" }],
        }, {
          id: "geo-integral",
          label: "Geometry integral",
          math: "\\int_0^1 \\frac{\\ln(1+x)+\\cos(x)}{1+x^2}\\,dx",
          summary: "Integral bounds, nested fraction, functions, products, and differential remain covered.",
          chunks: [{ id: "geo-integral-chunk", display: "\\int_0^1 \\frac{\\ln(1+x)+\\cos(x)}{1+x^2}\\,dx", latex: "\\int_0^1 \\frac{\\ln(1+x)+\\cos(x)}{1+x^2}\\,dx", text: "\\int_0^1 \\frac{\\ln(1+x)+\\cos(x)}{1+x^2}\\,dx", role: "equation" }],
        }, {
          id: "geo-full-integral",
          label: "Full structural integral",
          math: "\\int_0^\\infty[\\ln(1+x^2)\\arctan(x)]/[x(1+x^2)]\\,dx",
          summary: "The reported integral keeps repeated powers and function calls occurrence-specific.",
          chunks: [{ id: "geo-full-integral-chunk", display: "\\int_0^\\infty[\\ln(1+x^2)\\arctan(x)]/[x(1+x^2)]\\,dx", latex: "\\int_0^\\infty[\\ln(1+x^2)\\arctan(x)]/[x(1+x^2)]\\,dx", text: "\\int_0^\\infty[\\ln(1+x^2)\\arctan(x)]/[x(1+x^2)]\\,dx", role: "equation" }],
        }, {
          id: "geo-functions",
          label: "Geometry functions",
          math: "\\ln(x)+\\cos(x)+\\cot(x)+\\arctan(x)",
          summary: "Known function names are complete leaf targets.",
          chunks: [{ id: "geo-functions-chunk", display: "\\ln(x)+\\cos(x)+\\cot(x)+\\arctan(x)", latex: "\\ln(x)+\\cos(x)+\\cot(x)+\\arctan(x)", text: "\\ln(x)+\\cos(x)+\\cot(x)+\\arctan(x)", role: "equation" }],
        }, {
          id: "geo-nested",
          label: "Geometry nested fractions",
          math: "\\frac{\\frac{1}{2}+\\sqrt{\\frac{9}{4}}}{\\sqrt{\\frac{16}{25}}}",
          summary: "Nested fractions and radicals expose descendants.",
          chunks: [{ id: "geo-nested-chunk", display: "\\frac{\\frac{1}{2}+\\sqrt{\\frac{9}{4}}}{\\sqrt{\\frac{16}{25}}}", latex: "\\frac{\\frac{1}{2}+\\sqrt{\\frac{9}{4}}}{\\sqrt{\\frac{16}{25}}}", text: "\\frac{\\frac{1}{2}+\\sqrt{\\frac{9}{4}}}{\\sqrt{\\frac{16}{25}}}", role: "equation" }],
        }, {
          id: "geo-chain",
          label: "Geometry equality chain",
          math: "x^2+2x+1=(x+1)^2=0\nx+1=0\nx=-1",
          summary: "Multiline equality chains keep every line targetable.",
          chunks: [
            { id: "geo-chain-1", display: "x^2+2x+1=(x+1)^2=0", latex: "x^2+2x+1=(x+1)^2=0", text: "x^2+2x+1=(x+1)^2=0", role: "equation" },
            { id: "geo-chain-2", display: "x+1=0", latex: "x+1=0", text: "x+1=0", role: "equation" },
            { id: "geo-chain-3", display: "x=-1", latex: "x=-1", text: "x=-1", role: "equation" },
          ],
        }],
        finalAnswerLatex: "x=-1",
        usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
      }),
    });
  });
  await page.route("**/api/explain-token", async (route) => {
    const body = route.request().postDataJSON();
    lazyRequests.push({ endpoint: "hover", body });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ title: "ok", explanation: "ok" }),
    });
  });

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect composite geometry.");
  await expect(page.getByRole("button", { name: /Geometry integral/i })).toBeVisible();

  const coverage = await page.evaluate(() => {
    const expectedByStep = {
      "Geometry quadratic": ["3", "x", "2", "5", "-451", "-", "=", "0"],
      "Geometry integral": ["\\int_0^1", "0", "1", "\\ln", "\\cos", "x", "2", "dx"],
      "Full structural integral": ["\\int_0^\\infty", "0", "\\infty", "\\ln", "\\arctan", "x", "2"],
      "Geometry functions": ["\\ln", "\\cos", "\\cot", "\\arctan", "x"],
      "Geometry nested fractions": ["1", "2", "\\sqrt", "9", "4", "16", "25"],
      "Geometry equality chain": ["x", "2", "1", "=", "-1"],
    };
    const failures = [];
    const stepSummaries = {};
    for (const [label, expectedLatexes] of Object.entries(expectedByStep)) {
      const step = [...document.querySelectorAll(".step-card")]
        .find((card) => card.textContent?.includes(label));
      const stepRect = step?.getBoundingClientRect();
      const leaves = [...(step?.querySelectorAll("[data-inspectable='math-subtoken'][data-target-kind='leaf']") || [])]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            latex: node.getAttribute("data-token-latex"),
            role: node.getAttribute("data-token-role"),
            source: node.getAttribute("data-rect-source"),
            width: rect.width,
            height: rect.height,
            rect,
          };
        });
      const targets = [...(step?.querySelectorAll(".math-semantic-hitbox[data-token-id]") || [])]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            latex: node.getAttribute("data-token-latex"),
            width: rect.width,
            height: rect.height,
          };
        });
      stepSummaries[label] = leaves.map(({ latex, role, source, width, height }) => ({ latex, role, source, width, height }));
      for (const expectedLatex of expectedLatexes) {
        if (!targets.some((target) => target.latex === expectedLatex && target.width > 0 && target.height > 0)) {
          failures.push(`${label}: missing ${expectedLatex}`);
        }
      }
      for (const leaf of leaves) {
        if (stepRect && leaf.width >= stepRect.width * 0.9) {
          failures.push(`${label}: whole-step fallback for ${leaf.latex}`);
        }
      }
    }
    const functionStep = [...document.querySelectorAll(".step-card")]
      .find((card) => card.textContent?.includes("Geometry functions"));
    const functionLeaves = [...(functionStep?.querySelectorAll("[data-inspectable='math-subtoken'][data-target-kind='leaf']") || [])]
      .map((node) => node.getAttribute("data-token-latex"));
    for (const name of ["\\ln", "\\cos", "\\cot", "\\arctan"]) {
      if (functionLeaves.filter((latex) => latex === name).length !== 1) failures.push(`function ${name} not exactly one target`);
    }
    for (const character of ["l", "n", "c", "o", "s", "t", "a", "r"]) {
      if (functionLeaves.includes(character)) failures.push(`function split into character ${character}`);
    }
    return { failures, stepSummaries };
  });

  expect(coverage.failures).toEqual([]);

  const tokenBox = async (stepLabel, latex, role = null, occurrence = 0) => page.evaluate(({ stepLabel, latex, role, occurrence }) => {
    const step = [...document.querySelectorAll(".step-card")]
      .find((card) => card.textContent?.includes(stepLabel));
    const matches = [...(step?.querySelectorAll("[data-inspectable='math-subtoken'], .math-semantic-hitbox[data-token-id]") || [])]
      .filter((node) => (
        node.getAttribute("data-token-latex") === latex
        && (!role || node.getAttribute("data-token-role") === role)
      ))
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0);
    const selected = matches[occurrence]?.node || null;
    if (!selected) return null;
    selected.scrollIntoView({ block: "center", inline: "center" });
    const rect = selected.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, { stepLabel, latex, role, occurrence });

  const hoverBox = async (box, expectedLatex, expectedRole = null) => {
    expect(box).not.toBeNull();
    const previousHoverCount = lazyRequests.filter((request) => request.endpoint === "hover").length;
    await page.mouse.move(4, 4);
    await moveSemanticPointer(page, box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => {
      const hoverRequests = lazyRequests.filter((request) => request.endpoint === "hover");
      return hoverRequests.length > previousHoverCount ? hoverRequests.at(-1)?.body?.selectedLatex : undefined;
    }).toBe(expectedLatex);
    if (expectedRole) {
      await expect.poll(() => {
        const hoverRequests = lazyRequests.filter((request) => request.endpoint === "hover");
        return hoverRequests.length > previousHoverCount ? hoverRequests.at(-1)?.body?.selectedNode?.role : undefined;
      }).toBe(expectedRole);
    }
    await expect.poll(() => {
      const hoverRequests = lazyRequests.filter((request) => request.endpoint === "hover");
      return hoverRequests.length > previousHoverCount ? hoverRequests.at(-1)?.body?.selectedNode?.id || "" : "";
    }).not.toBe("");
  };

  await hoverBox(await tokenBox("Full structural integral", "x", "base", 0), "x", "base");
  await hoverBox(await tokenBox("Full structural integral", "2", "exponent", 0), "2", "exponent");
  await hoverBox(await tokenBox("Full structural integral", "\\arctan", "functionName", 0), "\\arctan", "functionName");
  await hoverBox(await tokenBox("Full structural integral", "x", "factor", 0), "x", "factor");
  await hoverBox(await tokenBox("Full structural integral", "2", "exponent", 1), "2", "exponent");
  await hoverBox(await tokenBox("Full structural integral", "\\infty", "upperBound", 0), "\\infty", "upperBound");
});

test("semantic identity stays stable from function hitbox through tooltip, API, and pin", async ({ page }) => {
  const requests = [];
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Semantic identity audit",
        problem: "Audit repeated function identity.",
        expression: "\\frac{\\ln(\\sec^2\\theta)\\theta}{\\tan\\theta}+\\tan\\theta",
        steps: [{
          id: "identity-functions",
          label: "Identity functions",
          math: "\\frac{\\ln(\\sec^2\\theta)\\theta}{\\tan\\theta}+\\tan\\theta",
          summary: "Repeated functions keep distinct semantic identities.",
          chunks: [{
            id: "identity-functions-chunk",
            display: "\\frac{\\ln(\\sec^2\\theta)\\theta}{\\tan\\theta}+\\tan\\theta",
            latex: "\\frac{\\ln(\\sec^2\\theta)\\theta}{\\tan\\theta}+\\tan\\theta",
            text: "\\frac{\\ln(\\sec^2\\theta)\\theta}{\\tan\\theta}+\\tan\\theta",
            role: "equation",
          }],
        }],
        finalAnswerLatex: "\\frac{\\ln(\\sec^2\\theta)\\theta}{\\tan\\theta}+\\tan\\theta",
        usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
      }),
    });
  });
  for (const endpoint of ["**/api/explain-token", "**/api/explain-pin"]) {
    await page.route(endpoint, async (route) => {
      const body = route.request().postDataJSON();
      requests.push({ endpoint: endpoint.includes("pin") ? "pin" : "hover", body });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          semanticId: body.semanticId,
          targetId: body.targetId,
          targetLabel: body.targetLabel,
          title: `Server tried ${body.selectedLatex}`,
          explanation: `${body.selectedLatex} explanation for ${body.semanticId}`,
        }),
      });
    });
  }

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Audit repeated function identity.");
  await expect(page.getByRole("button", { name: /Identity functions/i })).toBeVisible();

  const audit = await page.evaluate(() => {
    const step = [...document.querySelectorAll(".step-card")]
      .find((card) => card.textContent?.includes("Identity functions"));
    const leaves = [...(step?.querySelectorAll("[data-inspectable='math-subtoken'][data-target-kind='leaf']") || [])]
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          id: node.getAttribute("data-token-id"),
          semanticId: node.getAttribute("data-semantic-id"),
          latex: node.getAttribute("data-token-latex"),
          sourceRange: node.getAttribute("data-source-range"),
          width: rect.width,
          height: rect.height,
        };
      });
    return {
      leaves,
      tanLeaves: leaves.filter((leaf) => leaf.latex === "\\tan"),
      characterFunctionLeaves: leaves.filter((leaf) => ["t", "a", "n", "s", "e", "c", "l"].includes(leaf.latex)),
    };
  });
  expect(audit.characterFunctionLeaves).toEqual([]);
  expect(audit.tanLeaves.length).toBeGreaterThanOrEqual(2);
  expect(new Set(audit.tanLeaves.map((leaf) => leaf.semanticId)).size).toBe(audit.tanLeaves.length);
  for (const leaf of audit.leaves) {
    expect(leaf.semanticId).toBe(leaf.id);
    expect(leaf.sourceRange).toMatch(/^\d+:\d+$/);
    expect(leaf.width).toBeGreaterThan(0);
    expect(leaf.height).toBeGreaterThan(0);
  }

  const denominatorTan = audit.tanLeaves[0];
  const tanTarget = page.locator(`[data-inspectable='math-subtoken'][data-semantic-id='${denominatorTan.semanticId}']`).first();
  await tanTarget.hover({ force: true });
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
  await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-semantic-id", denominatorTan.semanticId);
  await expect.poll(() => requests.filter((request) => request.endpoint === "hover").at(-1)?.body?.semanticId).toBe(denominatorTan.semanticId);
  const hoverBody = requests.filter((request) => request.endpoint === "hover").at(-1)?.body;
  expect(hoverBody.targetId).toBe(denominatorTan.semanticId);
  expect(hoverBody.selectedTokenId).toBe(denominatorTan.semanticId);
  expect(hoverBody.selectedLatex).toBe("\\tan");
  expect(hoverBody.selectedLatex).not.toContain("\\frac");
  await expect(page.locator(".omni-quick-tooltip h3")).toContainText("tan");

  const box = await tanTarget.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await expect(page.locator(".omni-floating-window")).toBeVisible();
  await expect(page.locator(".omni-floating-window")).toHaveAttribute("data-semantic-id", denominatorTan.semanticId);
  await expect.poll(() => requests.filter((request) => request.endpoint === "pin").at(-1)?.body?.semanticId).toBe(denominatorTan.semanticId);
});

test("nested integral and signed exponent targets preserve semantic identity", async ({ page }) => {
  const requests = [];
  const canonicalIntegral = "\\int_0^\\infty\\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx";
  const signedExponentProduct = "(\\sec^2\\theta)^{a-1}\\frac{\\sec^2\\theta}{\\sec^2\\theta}";
  const polynomial = "435x^2+514514x+4155=31451545";

  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Nested math interaction regression",
        problem: "Inspect nested math selection.",
        expression: canonicalIntegral,
        steps: [{
          id: "canonical-integral-step",
          label: "Canonical nested integral",
          math: canonicalIntegral,
          summary: "Every meaningful descendant of the integral should stay targetable.",
          chunks: [{ id: "canonical-integral-chunk", display: canonicalIntegral, latex: canonicalIntegral, text: canonicalIntegral, role: "equation" }],
        }, {
          id: "signed-exponent-step",
          label: "Signed exponent product",
          math: signedExponentProduct,
          summary: "The visible -1 in the exponent should not resolve to the adjacent secant fraction.",
          chunks: [{ id: "signed-exponent-chunk", display: signedExponentProduct, latex: signedExponentProduct, text: signedExponentProduct, role: "equation" }],
        }, {
          id: "polynomial-compat-step",
          label: "Polynomial compatibility",
          math: polynomial,
          summary: "Simple polynomial interaction behavior should remain unchanged.",
          chunks: [{ id: "polynomial-compat-chunk", display: polynomial, latex: polynomial, text: polynomial, role: "equation" }],
        }],
        usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
      }),
    });
  });
  for (const endpoint of ["**/api/explain-token", "**/api/explain-pin"]) {
    await page.route(endpoint, async (route) => {
      const body = route.request().postDataJSON();
      requests.push({ endpoint: endpoint.includes("pin") ? "pin" : "hover", body });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          semanticId: body.semanticId,
          targetId: body.targetId,
          targetLabel: body.targetLabel,
          title: `Selected ${body.selectedLatex}`,
          explanation: `${body.selectedLatex} explanation for ${body.semanticId}`,
        }),
      });
    });
  }

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect nested math selection.");
  await expect(page.getByRole("button", { name: /Canonical nested integral/i })).toBeVisible();

  const tokenBox = async (stepLabel, latex, role = null, occurrence = 0) => page.evaluate(({ stepLabel, latex, role, occurrence }) => {
    const step = [...document.querySelectorAll(".step-card")]
      .find((card) => card.textContent?.includes(stepLabel));
    const stepRect = step?.getBoundingClientRect();
    const matches = [...(step?.querySelectorAll(".math-semantic-hitbox[data-token-id]") || [])]
      .filter((node) => (
        node.getAttribute("data-token-latex") === latex
        && (!role || node.getAttribute("data-token-role") === role)
      ))
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0);
    const selected = matches[occurrence]?.node || null;
    if (!selected) return null;
    selected.scrollIntoView({ block: "center", inline: "center" });
    const rect = selected.getBoundingClientRect();
    return {
      id: selected.getAttribute("data-token-id"),
      semanticId: selected.getAttribute("data-semantic-id"),
      latex: selected.getAttribute("data-token-latex"),
      role: selected.getAttribute("data-token-role"),
      sourceRange: selected.getAttribute("data-source-range"),
      rectSource: selected.getAttribute("data-rect-source"),
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      stepWidth: stepRect?.width || 0,
    };
  }, { stepLabel, latex, role, occurrence });

  const hoverBox = async (box, expectedLatex) => {
    expect(box).not.toBeNull();
    const previousHoverCount = requests.filter((request) => request.endpoint === "hover").length;
    await page.mouse.move(4, 4);
    await moveSemanticPointer(page, box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => {
      const hoverRequests = requests.filter((request) => request.endpoint === "hover");
      return hoverRequests.length > previousHoverCount ? hoverRequests.at(-1)?.body : null;
    }).not.toBeNull();
    const body = requests.filter((request) => request.endpoint === "hover").at(-1)?.body;
    expect(body.selectedLatex).toBe(expectedLatex);
    expect(body.semanticId).toBe(box.semanticId);
    expect(body.targetId).toBe(box.semanticId);
    expect(body.selectedNode?.id).toBe(box.semanticId);
    return body;
  };

  const integralChecks = [
    ["\\int_0^\\infty", "operatorHead", 0],
    ["0", "lowerBound", 0],
    ["\\infty", "upperBound", 0],
    ["\\ln", "functionName", 0],
    ["\\arctan", "functionName", 0],
    ["x", "argument", 0],
    ["x", "factor", 0],
    ["2", "exponent", 0],
    ["2", "exponent", 1],
  ];
  for (const [latex, role, occurrence] of integralChecks) {
    const box = await tokenBox("Canonical nested integral", latex, role, occurrence);
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.width).toBeLessThan(box.stepWidth * 0.8);
    expect(box.sourceRange).toMatch(/^\d+:\d+$/);
  }

  const signedOne = await tokenBox("Signed exponent product", "-1", "constant", 0);
  const fractionSec = await tokenBox("Signed exponent product", "\\sec", "functionName", 1);
  expect(signedOne).not.toBeNull();
  expect(fractionSec).not.toBeNull();
  expect(signedOne.semanticId).not.toBe(fractionSec.semanticId);
  const hoverBody = await hoverBox(signedOne, "-1");
  expect(hoverBody.selectedLatex).not.toContain("\\frac");
  await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-semantic-id", signedOne.semanticId);
  await page.mouse.click(signedOne.x + signedOne.width / 2, signedOne.y + signedOne.height / 2, { button: "right" });
  await expect(page.locator(".omni-floating-window")).toBeVisible();
  await expect(page.locator(".omni-floating-window")).toHaveAttribute("data-semantic-id", signedOne.semanticId);
  await expect.poll(() => requests.filter((request) => request.endpoint === "pin").at(-1)?.body?.semanticId).toBe(signedOne.semanticId);
  const pinBody = requests.filter((request) => request.endpoint === "pin").at(-1)?.body;
  expect(pinBody.selectedLatex).toBe("-1");
  expect(pinBody.selectedLatex).not.toContain("\\frac");
  await page.getByRole("button", { name: /Close explanation/i }).first().click({ force: true });
  await expect(page.locator(".omni-floating-window")).toHaveCount(0);
  await page.mouse.move(4, 4);

  for (const [latex, role, occurrence] of [
    ["435", "coefficient", 0],
    ["x", "base", 0],
    ["2", "exponent", 0],
    ["514514", "coefficient", 0],
    ["+", "operator", 0],
    ["31451545", "rightSide", 0],
  ]) {
    const box = await tokenBox("Polynomial compatibility", latex, role, occurrence);
    await hoverBox(box, latex);
  }
});

test("pointer trajectories replace stale identities across nested semantic structures", async ({ page }) => {
  test.slow();
  const requests = [];
  const steps = [
    ["transition-radical", "Radical transition", "r=\\sqrt{x+1}"],
    ["transition-integral", "Integral bound transition", "I=\\int_0^{-2}f(x)\\,d\\theta"],
    ["transition-signed", "Signed exponent transition", "y=x^{-1}"],
    ["transition-fraction", "Fraction transition", "q=\\frac{a+b}{c+d}"],
    ["transition-differential", "Differential transition", "J=\\int_0^1 f(\\theta)\\,d\\theta"],
    ["transition-nested", "Nested bound torture", "\\int_0^{2^{\\frac{\\pi}{2+\\frac{\\ln(\\sec t)}{\\tan t}}}} f(x)\\,dx"],
  ];

  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Semantic pointer transition stress",
        problem: "Inspect semantic pointer transitions.",
        expression: steps[0][2],
        steps: steps.map(([id, label, math]) => ({
          id,
          label,
          math,
          summary: `${label} keeps every represented semantic target reachable.`,
          chunks: [{ id: `${id}-chunk`, display: math, latex: math, text: math, role: "equation" }],
        })),
        finalAnswerLatex: steps.at(-1)[2],
        usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
        saved: false,
        demoMode: true,
      }),
    });
  });
  for (const endpoint of ["**/api/explain-token", "**/api/explain-pin"]) {
    await page.route(endpoint, async (route) => {
      const body = route.request().postDataJSON();
      requests.push({ endpoint: endpoint.includes("pin") ? "pin" : "hover", body });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: `Selected ${body?.selectedLatex || "math"}`,
          explanation: `${body?.selectedLatex || "This target"} owns the current pointer identity.`,
        }),
      });
    });
  }

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect semantic pointer transitions.");
  await expect(page.getByRole("button", { name: /Nested bound torture/i })).toBeVisible();

  const targetsForStep = async (stepLabel) => {
    await page.evaluate((label) => {
      const step = [...document.querySelectorAll(".step-card")]
        .find((card) => card.textContent?.includes(label));
      step?.scrollIntoView({ block: "center", inline: "center" });
    }, stepLabel);
    await page.waitForTimeout(100);
    return page.evaluate((label) => {
      const step = [...document.querySelectorAll(".step-card")]
        .find((card) => card.textContent?.includes(label));
      return [...(step?.querySelectorAll(".math-semantic-hitbox[data-token-id]") || [])]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            id: node.getAttribute("data-token-id"),
            semanticId: node.getAttribute("data-semantic-id"),
            latex: node.getAttribute("data-token-latex") || "",
            role: node.getAttribute("data-token-role") || "",
            kind: node.getAttribute("data-target-kind") || "",
            region: node.getAttribute("data-hitbox-region") || "painted",
            sourceRange: node.getAttribute("data-source-range") || "",
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          };
        })
        .filter((target) => target.rect.width > 0 && target.rect.height > 0);
    }, stepLabel);
  };

  const target = (targets, {
    latex,
    role = null,
    kind = null,
    region = null,
    occurrence = 0,
    smallestHeight = false,
    largestHeight = false,
  }) => {
    const matches = targets.filter((candidate) => (
      candidate.latex === latex
      && (!role || candidate.role === role)
      && (!kind || candidate.kind === kind)
      && (!region || candidate.region === region)
    )).sort((left, right) => (
      largestHeight
        ? right.rect.height - left.rect.height || left.rect.left - right.rect.left
        : smallestHeight
        ? left.rect.height - right.rect.height || right.rect.width - left.rect.width
        : left.rect.top - right.rect.top || left.rect.left - right.rect.left
    ));
    const selected = matches[occurrence] || null;
    expect(selected, `missing ${latex} (${role || "any role"}, ${region || "any region"})`).not.toBeNull();
    return selected;
  };

  const pointIn = (selected, xRatio = 0.5, yRatio = 0.5) => ({
    x: Math.max(selected.rect.left + 0.5, Math.min(selected.rect.right - 0.5, selected.rect.left + selected.rect.width * xRatio)),
    y: Math.max(selected.rect.top + 0.5, Math.min(selected.rect.bottom - 0.5, selected.rect.top + selected.rect.height * yRatio)),
  });

  const assertResolvedPoint = async (selected, point = pointIn(selected), expected = {}) => {
    const previousRequest = requests.findLast((request) => (
      request.endpoint === "hover" && request.body?.semanticId === selected.semanticId
    ))?.body || null;
    const diagnosticCount = await page.evaluate(() => (window.__OMNIMATH_HOVER_DIAGNOSTICS__ || []).length);
    await moveSemanticPointer(page, point.x, point.y);
    await expect.poll(() => page.evaluate(() => window.__OMNIMATH_HOVER_STATE__?.hoverState?.semanticId || ""))
      .toBe(selected.semanticId);
    await expect.poll(() => page.evaluate(({ diagnosticCount, semanticId }) => (
      (window.__OMNIMATH_HOVER_DIAGNOSTICS__ || [])
        .slice(diagnosticCount)
        .findLast((entry) => entry?.chosenNodeId === semanticId) || null
    ), { diagnosticCount, semanticId: selected.semanticId })).not.toBeNull();
    const diagnostic = await page.evaluate(({ diagnosticCount, semanticId }) => (
      (window.__OMNIMATH_HOVER_DIAGNOSTICS__ || [])
        .slice(diagnosticCount)
        .findLast((entry) => entry?.chosenNodeId === semanticId) || null
    ), { diagnosticCount, semanticId: selected.semanticId });
    await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-lazy-target-id", selected.semanticId);
    if (!previousRequest) {
      await expect.poll(() => {
        const hoverRequests = requests.filter((request) => request.endpoint === "hover");
        return hoverRequests.at(-1)?.body?.semanticId || "";
      }).toBe(selected.semanticId);
    }
    const requestBody = requests.findLast((request) => (
      request.endpoint === "hover" && request.body?.semanticId === selected.semanticId
    ))?.body;
    expect(diagnostic.chosenLatex).toBe(expected.latex || selected.latex);
    expect(diagnostic.chosenRole).toBe(expected.role || selected.role);
    expect(diagnostic.selected?.sourceRange).toEqual(requestBody.semanticSourceRange);
    expect(requestBody.selectedLatex).toBe(expected.latex || selected.latex);
    expect(requestBody.targetRole).toBe(expected.role || selected.role);
    await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-semantic-id", selected.semanticId);
    await expect.poll(() => page.evaluate(() => window.__OMNIMATH_HOVER_PERF__?.last?.pointerResolveComplete?.layoutReadCount))
      .toBe(0);
    return { diagnostic, requestBody };
  };

  const assertNoTargetPoint = async (point) => {
    const diagnosticCount = await page.evaluate(() => (window.__OMNIMATH_HOVER_DIAGNOSTICS__ || []).length);
    await moveSemanticPointer(page, point.x, point.y);
    await expect.poll(() => page.evaluate(() => window.__OMNIMATH_HOVER_STATE__?.hoverState || null)).toBeNull();
    await expect.poll(() => page.evaluate((start) => (
      (window.__OMNIMATH_HOVER_DIAGNOSTICS__ || []).slice(start).some((entry) => entry?.resolverReason === "no-hit")
    ), diagnosticCount)).toBe(true);
    await expect(page.locator(".omni-quick-tooltip")).toHaveCount(0);
  };

  let radicalTargets = await targetsForStep("Radical transition");
  let radical = target(radicalTargets, { latex: "\\sqrt", role: "radical", kind: "leaf" });
  let radicalX = target(radicalTargets, { latex: "x", role: "variable", kind: "leaf" });
  await assertResolvedPoint(radical);
  await assertResolvedPoint(radicalX);
  await assertResolvedPoint(radical);
  await assertResolvedPoint(radicalX);

  const integralTargets = await targetsForStep("Integral bound transition");
  const integralSymbol = target(integralTargets, {
    latex: "\\int_0^{-2}",
    role: "operatorHead",
    kind: "group",
    largestHeight: true,
  });
  const integralLower = target(integralTargets, { latex: "0", role: "lowerBound", kind: "leaf" });
  const signedUpper = target(integralTargets, { latex: "-2", role: "upperBound", kind: "leaf" });
  const integrandFunction = target(integralTargets, { latex: "f", role: "functionName", kind: "leaf" });
  const integralDifferentialD = target(integralTargets, { latex: "d", role: "differentialOperator", kind: "leaf" });
  const integralDifferentialTheta = target(integralTargets, { latex: "\\theta", role: "variable", kind: "leaf" });
  await assertResolvedPoint(integralSymbol);
  await assertResolvedPoint(integralLower);
  await assertResolvedPoint(signedUpper, pointIn(signedUpper, 0.15), { latex: "-2", role: "upperBound" });
  await assertResolvedPoint(signedUpper, pointIn(signedUpper, 0.85), { latex: "-2", role: "upperBound" });
  await assertResolvedPoint(integrandFunction);
  await assertResolvedPoint(integralDifferentialD);
  await assertResolvedPoint(integralDifferentialTheta);

  const signedTargets = await targetsForStep("Signed exponent transition");
  const signedBase = target(signedTargets, { latex: "x", role: "base", kind: "leaf" });
  const signedExponent = target(signedTargets, { latex: "-1", role: "exponent", kind: "leaf" });
  await assertResolvedPoint(signedBase);
  await assertResolvedPoint(signedExponent, pointIn(signedExponent, 0.15), { latex: "-1", role: "exponent" });
  await assertResolvedPoint(signedExponent, pointIn(signedExponent, 0.85), { latex: "-1", role: "exponent" });
  await assertResolvedPoint(signedExponent, pointIn(signedExponent, 0.5), { latex: "-1", role: "exponent" });
  const signedWhitespace = await page.evaluate((label) => {
    const step = [...document.querySelectorAll(".step-card")].find((card) => card.textContent?.includes(label));
    const host = step?.querySelector("[data-inspectable='math-token']");
    if (!host) return null;
    const hostRect = host.getBoundingClientRect();
    const hitboxes = [...step.querySelectorAll(".math-semantic-hitbox[data-token-id]")].map((node) => node.getBoundingClientRect());
    for (let y = Math.ceil(hostRect.top + 1); y < hostRect.bottom - 1; y += 2) {
      for (let x = Math.ceil(hostRect.left + 1); x < hostRect.right - 1; x += 2) {
        if (!hitboxes.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) return { x, y };
      }
    }
    return null;
  }, "Signed exponent transition");
  expect(signedWhitespace).not.toBeNull();
  await assertNoTargetPoint(signedWhitespace);

  const fractionTargets = await targetsForStep("Fraction transition");
  const numeratorA = target(fractionTargets, { latex: "a", role: "variable", kind: "leaf" });
  const numeratorGap = target(fractionTargets, { latex: "a+b", role: "numerator", kind: "group", region: "internal-gap" });
  const numeratorB = target(fractionTargets, { latex: "b", role: "variable", kind: "leaf" });
  const fullFraction = target(fractionTargets, { latex: "\\frac{a+b}{c+d}", kind: "group", region: "painted", smallestHeight: true });
  const denominatorC = target(fractionTargets, { latex: "c", role: "variable", kind: "leaf" });
  const fractionBarPoint = await page.evaluate((label) => {
    const step = [...document.querySelectorAll(".step-card")].find((card) => card.textContent?.includes(label));
    const line = [...(step?.querySelectorAll(".frac-line") || [])]
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .sort((left, right) => right.width - left.width)[0];
    return line ? { x: line.left + line.width / 2, y: line.top + line.height / 2 } : null;
  }, "Fraction transition");
  expect(fractionBarPoint).not.toBeNull();
  await assertResolvedPoint(fullFraction, fractionBarPoint);
  await assertResolvedPoint(numeratorA);
  await assertResolvedPoint(numeratorGap);
  await assertResolvedPoint(numeratorB);
  await assertResolvedPoint(fullFraction, fractionBarPoint);
  await assertResolvedPoint(denominatorC);

  const differentialTargets = await targetsForStep("Differential transition");
  const differentialD = target(differentialTargets, { latex: "d", role: "differentialOperator", kind: "leaf" });
  const differentialTheta = target(differentialTargets, { latex: "\\theta", role: "variable", kind: "leaf" });
  const neighboringFunction = target(differentialTargets, { latex: "f", role: "functionName", kind: "leaf" });
  await assertResolvedPoint(differentialD);
  await assertResolvedPoint(differentialTheta);
  await assertResolvedPoint(differentialD);
  await assertResolvedPoint(neighboringFunction);

  const nestedTargets = await targetsForStep("Nested bound torture");
  const nestedUpper = target(nestedTargets, {
    latex: "2^{\\frac{\\pi}{2+\\frac{\\ln(\\sec t)}{\\tan t}}}",
    role: "upperBound",
    kind: "group",
  });
  const [upperStart, upperEnd] = nestedUpper.sourceRange.split(":").map(Number);
  for (const nestedLeaf of [
    target(nestedTargets, { latex: "2", role: "base", kind: "leaf" }),
    target(nestedTargets, { latex: "\\pi", role: "numerator", kind: "leaf" }),
    target(nestedTargets, { latex: "2", role: "constant", kind: "leaf" }),
    target(nestedTargets, { latex: "\\ln", role: "functionName", kind: "leaf" }),
    target(nestedTargets, { latex: "\\sec", role: "functionName", kind: "leaf" }),
    target(nestedTargets, { latex: "\\tan", role: "functionName", kind: "leaf" }),
  ]) {
    const result = await assertResolvedPoint(nestedLeaf);
    expect(result.diagnostic.chosenNodeId).not.toBe(nestedUpper.semanticId);
    const range = result.diagnostic.selected.sourceRange;
    expect(range.start).toBeGreaterThanOrEqual(upperStart);
    expect(range.end).toBeLessThanOrEqual(upperEnd);
  }

  radicalTargets = await targetsForStep("Radical transition");
  radical = target(radicalTargets, { latex: "\\sqrt", role: "radical", kind: "leaf" });
  radicalX = target(radicalTargets, { latex: "x", role: "variable", kind: "leaf" });
  for (let index = 0; index < 30; index += 1) {
    const selected = index % 2 === 0 ? radical : radicalX;
    const diagnosticCount = await page.evaluate(() => (window.__OMNIMATH_HOVER_DIAGNOSTICS__ || []).length);
    const point = pointIn(selected);
    await moveSemanticPointer(page, point.x, point.y);
    await expect.poll(() => page.evaluate(() => window.__OMNIMATH_HOVER_STATE__?.hoverState?.semanticId || ""))
      .toBe(selected.semanticId);
    await expect.poll(() => page.evaluate(({ diagnosticCount, semanticId }) => (
      (window.__OMNIMATH_HOVER_DIAGNOSTICS__ || []).slice(diagnosticCount).some((entry) => entry?.chosenNodeId === semanticId)
    ), { diagnosticCount, semanticId: selected.semanticId })).toBe(true);
  }
  expect(requests.some((request) => (
    request.endpoint === "hover" && request.body?.semanticId === radicalX.semanticId
  ))).toBe(true);
  await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-semantic-id", radicalX.semanticId);

  const pinPoint = pointIn(radicalX);
  await contextClickSemanticPointer(page, pinPoint.x, pinPoint.y);
  await expect.poll(() => requests.filter((request) => request.endpoint === "pin").at(-1)?.body?.semanticId || "")
    .toBe(radicalX.semanticId);
  await expect(page.locator(".omni-floating-window")).toHaveAttribute("data-semantic-id", radicalX.semanticId);
});

test("complex improper integral semantic rendering matches plain KaTeX geometry", async ({ page }) => {
  const latex = "\\int_0^\\infty\\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx";
  const semanticTree = buildSemanticTree({ stepId: "visual-complex-integral", displayLatex: latex, enabled: true });
  const semanticRender = serializeSemanticTreeToLatex(semanticTree);
  expect(semanticRender.error).toBe("");
  expect(semanticRender.annotatedNodeCount).toBeGreaterThan(0);

  const katexOptions = { throwOnError: true, strict: "ignore", displayMode: true };
  const plainHtml = katex.renderToString(latex, katexOptions);
  const semanticHtml = katex.renderToString(semanticRender.latex, {
    ...katexOptions,
    trust: createSemanticKatexTrust(),
  });
  const katexCss = await readFile("node_modules/katex/dist/katex.min.css", "utf8");

  await page.setContent(`
    <style>
      ${katexCss}
      body { margin: 0; padding: 32px; background: #101820; color: white; font-size: 20px; }
      .row { display: flex; align-items: flex-start; gap: 32px; }
      .sample { display: inline-block; }
    </style>
    <div class="row">
      <div id="plain" class="sample">${plainHtml}</div>
      <div id="semantic" class="sample">${semanticHtml}</div>
    </div>
  `);

  const report = await page.evaluate(() => {
    const rectSnapshot = (rect) => rect ? {
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom,
      right: rect.right,
    } : null;
    const rectOf = (node) => {
      const rect = node?.getBoundingClientRect?.();
      return rect ? {
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
        bottom: rect.bottom,
        right: rect.right,
      } : null;
    };
    const semantic = document.querySelector("#semantic");
    const semanticTargets = [...semantic.querySelectorAll("[data-semantic-id]")].map((node) => {
      const rects = [...node.getClientRects()].map(rectSnapshot).filter(Boolean);
      return {
        id: node.getAttribute("data-semantic-id"),
        role: node.getAttribute("data-semantic-role"),
        kind: node.getAttribute("data-semantic-kind"),
        text: node.textContent || "",
        rects,
        union: rectOf(node),
      };
    });
    return {
      plainText: document.querySelector("#plain .katex-html")?.textContent || "",
      semanticText: semantic?.querySelector(".katex-html")?.textContent || "",
      plainRect: rectOf(document.querySelector("#plain")),
      semanticRect: rectOf(semantic),
      semanticTargets,
    };
  });

  expect(report.plainText).toBe(report.semanticText);
  expect(report.semanticRect.width).toBeGreaterThan(report.plainRect.width * 0.85);
  expect(report.semanticRect.width).toBeLessThan(report.plainRect.width * 1.15);
  expect(report.semanticRect.height).toBeGreaterThan(report.plainRect.height * 0.85);
  expect(report.semanticRect.height).toBeLessThan(report.plainRect.height * 1.2);

  const targetByRole = (role) => report.semanticTargets.filter((target) => target.role === role);
  const numerator = targetByRole("numerator").find((target) => /ln/.test(target.text) && /arctan/.test(target.text));
  const denominator = targetByRole("denominator").find((target) => target.text.includes("x(1+x2)"));
  const differential = targetByRole("differential").find((target) => target.text.includes("dx"));

  expect(numerator?.union?.width || 0).toBeGreaterThan(90);
  expect(numerator?.union?.height || 0).toBeGreaterThan(12);
  expect(numerator?.union?.height || 0).toBeLessThan(report.semanticRect.height * 0.75);
  expect(denominator?.union?.width || 0).toBeGreaterThan(45);
  expect(targetByRole("upperBound").some((target) => target.union?.width > 8 && target.union?.height > 6)).toBe(true);
  expect(targetByRole("lowerBound").some((target) => target.union?.width > 4 && target.union?.height > 6)).toBe(true);
  expect(differential?.union?.width || 0).toBeGreaterThan(10);

  const tinyDetachedTargets = report.semanticTargets.filter((target) => {
    const text = target.text.replace(/\s+/g, "");
    if (text.length <= 1) return false;
    const rect = target.union;
    return !rect || rect.width < 3 || rect.height < 4;
  });
  expect(tinyDetachedTargets).toEqual([]);
});

test("complex integral upper-bound hover reaches visible nested bound ink", async ({ page }) => {
  const requests = [];
  const artifactDir = `${ARTIFACT_DIR}/complex-upper-bound-hover`;
  const exactIntegral = "\\int_{0}^{\\infty} \\frac{\\ln(1+x^{2}) \\arctan x}{x(1+x^{2})}\\,dx";
  const complexUpperBound = "\\int_{0}^{2^{\\frac{\\pi}{2+\\frac{\\ln(\\sec t)}{\\tan t}}}} f(x)\\,dx";
  await mkdir(artifactDir, { recursive: true });

  await page.route("**/api/explain", async (route) => {
    const requestBody = route.request().postDataJSON();
    expect(requestBody.problem).toBe(exactIntegral);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Complex upper bound hover investigation",
        problem: exactIntegral,
        expression: exactIntegral,
        steps: [{
          id: "reported-integral-step",
          label: "Reported integral",
          math: exactIntegral,
          summary: "The exact reported integral should keep the infinity upper bound hoverable.",
          chunks: [{ id: "reported-integral-chunk", display: exactIntegral, latex: exactIntegral, text: exactIntegral, role: "equation" }],
        }, {
          id: "complex-upper-bound-step",
          label: "Complex upper bound fixture",
          math: complexUpperBound,
          summary: "The nested upper bound should retain its role while every visible descendant remains independently reachable.",
          chunks: [{ id: "complex-upper-bound-chunk", display: complexUpperBound, latex: complexUpperBound, text: complexUpperBound, role: "equation" }],
        }],
        finalAnswerLatex: exactIntegral,
        usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
        saved: false,
        demoMode: true,
      }),
    });
  });
  for (const endpoint of ["**/api/explain-token", "**/api/explain-pin"]) {
    await page.route(endpoint, async (route) => {
      const body = route.request().postDataJSON();
      requests.push({ endpoint: endpoint.includes("pin") ? "pin" : "hover", body });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: `Selected ${body?.selectedLatex || "math"}`,
          explanation: `${body?.selectedLatex || "This expression"} was selected.`,
        }),
      });
    });
  }

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, exactIntegral);
  await expect(page.getByRole("button", { name: /Complex upper bound fixture/i })).toBeVisible();
  await expect(page.locator(".step-card").filter({ hasText: "Reported integral" }).locator(".math-semantic-hitbox[data-token-role='upperBound']").first()).toBeVisible();
  await expect(page.locator(".step-card").filter({ hasText: "Complex upper bound fixture" }).locator(".math-semantic-hitbox[data-token-role='upperBound']").first()).toBeVisible();

  const readUpperBoundTrace = async (stepLabel) => page.evaluate((label) => {
    const roundRect = (rect) => rect ? {
      left: Math.round(rect.left * 100) / 100,
      top: Math.round(rect.top * 100) / 100,
      right: Math.round(rect.right * 100) / 100,
      bottom: Math.round(rect.bottom * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    } : null;
    const rectCenter = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    const step = [...document.querySelectorAll(".step-card")]
      .find((card) => card.textContent?.includes(label));
    const chunk = step?.querySelector("[data-inspectable='math-token']");
    const upperHitboxes = [...(step?.querySelectorAll(".math-semantic-hitbox[data-token-role='upperBound']") || [])]
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .sort((left, right) => (right.rect.width * right.rect.height) - (left.rect.width * left.rect.height));
    const upper = upperHitboxes[0]?.node || null;
    const upperId = upper?.getAttribute("data-semantic-id") || "";
    const ownerElements = upperId
      ? [...(chunk?.querySelectorAll(`[data-semantic-id='${CSS.escape(upperId)}']`) || [])]
      : [];
    const ownerDescendants = ownerElements.flatMap((owner) => [
      owner,
      ...owner.querySelectorAll("[data-semantic-id], .mfrac, .mord, .mop, .mopen, .mclose, .frac-line, .msupsub"),
    ]);
    const descendantRects = ownerDescendants
      .flatMap((node) => [...node.getClientRects()].map((rect) => ({ node, rect })))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0);
    const semanticDescendants = ownerElements.flatMap((owner) => [...owner.querySelectorAll("[data-semantic-id]")])
      .map((node) => ({
        id: node.getAttribute("data-semantic-id"),
        role: node.getAttribute("data-semantic-role"),
        type: node.getAttribute("data-semantic-type"),
        range: node.getAttribute("data-semantic-range"),
        text: node.textContent || "",
        rects: [...node.getClientRects()].map(roundRect).filter(Boolean),
      }));
    const byRole = (role, predicate = () => true) => semanticDescendants
      .filter((item) => item.role === role && item.rects.length > 0 && predicate(item))
      .sort((left, right) => (left.rects[0].top - right.rects[0].top) || (left.rects[0].left - right.rects[0].left))[0] || null;
    const topmost = descendantRects
      .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left)[0]?.rect || null;
    const upperFractionLine = descendantRects
      .filter(({ node }) => /\bfrac-line\b/.test(String(node.className || "")))
      .sort((left, right) => (right.rect.width - left.rect.width) || (left.rect.top - right.rect.top))[0]?.rect || null;
    const numerator = byRole("numerator", (item) => /ln|sec/.test(item.text));
    const denominator = byRole("denominator", (item) => /tan/.test(item.text)) || byRole("denominator");
    const pointFromRect = (rect, xRatio = 0.5, yRatio = 0.5) => rect ? ({
      x: rect.left + rect.width * xRatio,
      y: rect.top + rect.height * yRatio,
    }) : null;
    const points = [
      { label: "highest-visible-ink", point: pointFromRect(topmost), sourceRect: roundRect(topmost) },
      { label: "nested-numerator", point: pointFromRect(numerator?.rects?.[0]), sourceRect: numerator?.rects?.[0] || null },
      { label: "nested-denominator", point: pointFromRect(denominator?.rects?.[0]), sourceRect: denominator?.rects?.[0] || null },
      { label: "left-visible-edge", point: pointFromRect(upperFractionLine, 0.04, 0.5), sourceRect: roundRect(upperFractionLine) },
      { label: "right-visible-edge", point: pointFromRect(upperFractionLine, 0.99, 0.5), sourceRect: roundRect(upperFractionLine) },
    ].filter((item) => item.point);

    return {
      stepLabel: label,
      renderedLatex: chunk?.getAttribute("data-token-latex") || "",
      upperHitbox: upper ? {
        id: upper.getAttribute("data-token-id"),
        semanticId: upperId,
        latex: upper.getAttribute("data-token-latex"),
        role: upper.getAttribute("data-token-role"),
        kind: upper.getAttribute("data-target-kind"),
        sourceRange: upper.getAttribute("data-source-range"),
        rectSource: upper.getAttribute("data-rect-source"),
        geometryQuality: upper.getAttribute("data-geometry-quality"),
        rects: upperHitboxes.map(({ rect }) => roundRect(rect)),
      } : null,
      ownerElements: ownerElements.map((node) => ({
        tag: node.tagName.toLowerCase(),
        className: String(node.className || ""),
        id: node.getAttribute("data-semantic-id"),
        role: node.getAttribute("data-semantic-role"),
        type: node.getAttribute("data-semantic-type"),
        range: node.getAttribute("data-semantic-range"),
        text: node.textContent || "",
        rects: [...node.getClientRects()].map(roundRect).filter(Boolean),
      })),
      semanticDescendants,
      descendantInkRects: descendantRects.map(({ node, rect }) => ({
        tag: node.tagName?.toLowerCase?.() || "",
        className: String(node.className || ""),
        semanticId: node.getAttribute?.("data-semantic-id") || null,
        role: node.getAttribute?.("data-semantic-role") || null,
        text: node.textContent || "",
        rect: roundRect(rect),
      })),
      points,
    };
  }, stepLabel);

  const trace = {
    exactIntegral,
    complexUpperBound,
    reported: await readUpperBoundTrace("Reported integral"),
    complex: await readUpperBoundTrace("Complex upper bound fixture"),
    reportedProbes: [],
    probes: [],
  };

  expect(trace.reported.upperHitbox?.latex).toBe("\\infty");
  expect(trace.complex.upperHitbox?.latex).toBe("2^{\\frac{\\pi}{2+\\frac{\\ln(\\sec t)}{\\tan t}}}");
  expect(trace.complex.upperHitbox?.sourceRange).toBe("10:54");
  expect(trace.complex.semanticDescendants.some((node) => node.role === "numerator" && /π|pi/.test(node.text))).toBe(true);
  expect(trace.complex.semanticDescendants.some((node) => node.role === "denominator" && /tan/.test(node.text))).toBe(true);

  const reportedRect = trace.reported.upperHitbox?.rects?.[0];
  expect(reportedRect).toBeTruthy();
  const reportedPoint = {
    label: "reported-infinity-upper-bound",
    point: {
      x: reportedRect.left + reportedRect.width / 2,
      y: reportedRect.top + reportedRect.height / 2,
    },
  };
  await page.mouse.move(4, 4, { steps: 1 });
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__ = null;
  });
  const previousReportedHoverCount = requests.filter((request) => request.endpoint === "hover").length;
  await moveSemanticPointer(page, reportedPoint.point.x, reportedPoint.point.y);
  await page.waitForTimeout(520);
  const reportedTooltipVisible = await page.locator(".omni-quick-tooltip").isVisible().catch(() => false);
  const reportedTooltipSemanticId = reportedTooltipVisible
    ? await page.locator(".omni-quick-tooltip").getAttribute("data-semantic-id")
    : null;
  const reportedDiagnostic = await page.evaluate(() => window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__ || null);
  const reportedSnapshot = await page.evaluate(() => window.__OMNIMATH_LAST_GEOMETRY_SNAPSHOT__ || null);
  const reportedHoverState = await page.evaluate(() => window.__OMNIMATH_HOVER_STATE__ || null);
  const reportedHoverRequests = requests.filter((request) => request.endpoint === "hover");
  trace.reportedProbes.push({
    ...reportedPoint,
    requestDelta: reportedHoverRequests.length - previousReportedHoverCount,
    latestRequest: reportedHoverRequests.at(-1)?.body || null,
    tooltipVisible: reportedTooltipVisible,
    tooltipSemanticId: reportedTooltipSemanticId,
    diagnostic: reportedDiagnostic,
    cachedGeometry: reportedSnapshot,
    hoverState: reportedHoverState,
  });

  for (const probe of trace.complex.points) {
    let collected = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Re-read the visible ink immediately before moving the pointer. The
      // solution board can finish its entrance transform after the initial
      // diagnostic trace was captured.
      const liveProbe = (await readUpperBoundTrace("Complex upper bound fixture"))
        .points.find((candidate) => candidate.label === probe.label) || probe;
      await page.mouse.move(4, 4, { steps: 1 });
      await page.waitForTimeout(180);
      await page.evaluate(() => {
        window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__ = null;
      });
      const previousHoverCount = requests.filter((request) => request.endpoint === "hover").length;
      await moveSemanticPointer(page, liveProbe.point.x, liveProbe.point.y);
      await page.waitForTimeout(520);
      const tooltipVisible = await page.locator(".omni-quick-tooltip").isVisible().catch(() => false);
      const tooltipSemanticId = tooltipVisible
        ? await page.locator(".omni-quick-tooltip").getAttribute("data-semantic-id")
        : null;
      const diagnostic = await page.evaluate(() => window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__ || null);
      const snapshot = await page.evaluate(() => window.__OMNIMATH_LAST_GEOMETRY_SNAPSHOT__ || null);
      const hoverState = await page.evaluate(() => window.__OMNIMATH_HOVER_STATE__ || null);
      const hoverRequests = requests.filter((request) => request.endpoint === "hover");
      collected = {
        ...liveProbe,
        attempt,
        requestDelta: hoverRequests.length - previousHoverCount,
        latestRequest: hoverRequests.at(-1)?.body || null,
        tooltipVisible,
        tooltipSemanticId,
        diagnostic,
        cachedGeometry: snapshot,
        hoverState,
      };
      if (
        diagnostic?.chosenNodeId
        && hoverState?.hoverState?.semanticId === diagnostic.chosenNodeId
        && hoverRequests.at(-1)?.body?.semanticId === diagnostic.chosenNodeId
      ) {
        break;
      }
    }
    trace.probes.push(collected);
  }

  await writeFile(`${artifactDir}/complex-upper-bound-hover-report.json`, JSON.stringify(trace, null, 2));

  expect(trace.probes).toHaveLength(5);
  expect(trace.reportedProbes).toHaveLength(1);
  expect(trace.reportedProbes[0].tooltipVisible).toBe(true);
  expect(trace.reportedProbes[0].diagnostic?.chosenRole).toBe("upperBound");
  expect(trace.reportedProbes[0].diagnostic?.chosenLatex).toBe("\\infty");
  expect(trace.reportedProbes[0].hoverState?.hoverState?.semanticId).toBe(trace.reported.upperHitbox.semanticId);
  expect(trace.reportedProbes[0].tooltipSemanticId).toBe(trace.reported.upperHitbox.semanticId);
  expect(requests.some((request) => request.endpoint === "hover" && request.body?.selectedNode?.role === "upperBound")).toBe(true);
  const expectedNestedWinners = new Map([
    ["highest-visible-ink", { latex: "\\pi", role: "numerator" }],
    ["nested-numerator", { latex: "\\ln", role: "functionName" }],
    ["nested-denominator", { latex: "2", role: "constant" }],
    ["left-visible-edge", { latex: "\\frac{\\pi}{2+\\frac{\\ln(\\sec t)}{\\tan t}}", role: "exponent" }],
    ["right-visible-edge", { latex: "\\frac{\\pi}{2+\\frac{\\ln(\\sec t)}{\\tan t}}", role: "exponent" }],
  ]);
  const [upperStart, upperEnd] = trace.complex.upperHitbox.sourceRange.split(":").map(Number);
  for (const probe of trace.probes) {
    const expectedWinner = expectedNestedWinners.get(probe.label);
    const winnerRange = probe.diagnostic?.selected?.sourceRange;
    expect(probe.tooltipVisible).toBe(true);
    expect(probe.diagnostic?.chosenRole).toBe(expectedWinner.role);
    expect(probe.diagnostic?.chosenLatex).toBe(expectedWinner.latex);
    expect(probe.diagnostic?.chosenNodeId).not.toBe(trace.complex.upperHitbox.semanticId);
    expect(probe.diagnostic?.candidateRectCount || 0).toBeGreaterThan(0);
    expect(probe.diagnostic?.resolverReason).toMatch(/deterministic/);
    expect(probe.hoverState?.hoverState?.semanticId).toBe(probe.diagnostic?.chosenNodeId);
    expect(probe.tooltipSemanticId).toBe(probe.diagnostic?.chosenNodeId);
    expect(probe.latestRequest?.semanticId).toBe(probe.diagnostic?.chosenNodeId);
    expect(probe.latestRequest?.selectedLatex).toBe(expectedWinner.latex);
    expect(probe.latestRequest?.targetRole).toBe(expectedWinner.role);
    expect(probe.latestRequest?.semanticSourceRange).toEqual(winnerRange);
    expect(winnerRange?.start).toBeGreaterThanOrEqual(upperStart);
    expect(winnerRange?.end).toBeLessThanOrEqual(upperEnd);
    expect(probe.diagnostic?.candidates?.some((candidate) => candidate.role === "upperBound" && candidate.pointerInsideRect)).toBe(true);
  }
});

test("complex improper integral semantic hover regression", async ({ page }) => {
  const requests = [];
  const artifactDir = `${ARTIFACT_DIR}/complex-integral-hover`;
  await mkdir(artifactDir, { recursive: true });

  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createComplexIntegralHoverInvestigationResponse()),
    });
  });
  for (const endpoint of ["**/api/explain-token", "**/api/explain-pin"]) {
    await page.route(endpoint, async (route) => {
      const body = route.request().postDataJSON();
      requests.push({ endpoint: endpoint.includes("pin") ? "pin" : "hover", body });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: `Selected ${body?.selectedLatex || "math"}`,
          explanation: `${body?.selectedLatex || "This expression"} was selected for complex integral hover diagnostics.`,
        }),
      });
    });
  }

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Investigate complex improper integral hover behavior.");
  await expect(page.getByRole("button", { name: /Step 1 tangent substitution/i })).toBeVisible();

  const findTargetBox = async ({ stepLabel, latex = null, role = null, kind = null, occurrence = 0, contains = false }) => page.evaluate((options) => {
    const step = [...document.querySelectorAll(".step-card")]
      .find((card) => card.textContent?.includes(options.stepLabel));
    if (!step) return { missing: "step", stepLabel: options.stepLabel };
    const matches = [...step.querySelectorAll(".math-semantic-hitbox[data-token-id]")]
      .filter((node) => {
        const tokenLatex = node.getAttribute("data-token-latex") || "";
        const tokenRole = node.getAttribute("data-token-role") || "";
        const targetKind = node.getAttribute("data-target-kind") || "";
        if (options.latex && (options.contains ? !tokenLatex.includes(options.latex) : tokenLatex !== options.latex)) return false;
        if (options.role && tokenRole !== options.role) return false;
        if (options.kind && targetKind !== options.kind) return false;
        return true;
      })
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .sort((left, right) => (
        left.rect.top - right.rect.top
        || left.rect.left - right.rect.left
        || (left.rect.width * left.rect.height) - (right.rect.width * right.rect.height)
      ));
    const selected = matches[options.occurrence]?.node || null;
    if (!selected) {
      return {
        missing: "target",
        stepLabel: options.stepLabel,
        latex: options.latex,
        role: options.role,
        kind: options.kind,
        available: matches.length,
        availableTargets: [...step.querySelectorAll(".math-semantic-hitbox[data-token-id]")]
          .map((node) => {
            const rect = node.getBoundingClientRect();
            return {
              id: node.getAttribute("data-token-id"),
              latex: node.getAttribute("data-token-latex"),
              role: node.getAttribute("data-token-role"),
              kind: node.getAttribute("data-target-kind"),
              rectSource: node.getAttribute("data-rect-source"),
              sourceRange: node.getAttribute("data-source-range"),
              width: Math.round(rect.width * 100) / 100,
              height: Math.round(rect.height * 100) / 100,
            };
          })
          .filter((item) => item.width > 0 && item.height > 0)
          .slice(0, 80),
      };
    }
    selected.scrollIntoView({ block: "center", inline: "center" });
    const rect = selected.getBoundingClientRect();
    const stepRect = step.getBoundingClientRect();
    return {
      id: selected.getAttribute("data-token-id"),
      semanticId: selected.getAttribute("data-semantic-id"),
      latex: selected.getAttribute("data-token-latex"),
      role: selected.getAttribute("data-token-role"),
      kind: selected.getAttribute("data-target-kind"),
      rectSource: selected.getAttribute("data-rect-source"),
      sourceRange: selected.getAttribute("data-source-range"),
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      stepRect: { x: stepRect.x, y: stepRect.y, width: stepRect.width, height: stepRect.height },
    };
  }, { stepLabel, latex, role, kind, occurrence, contains });

  const readTooltip = async () => page.evaluate(() => {
    const tooltip = document.querySelector(".omni-quick-tooltip");
    if (!tooltip) return null;
    const rect = tooltip.getBoundingClientRect();
    return {
      text: tooltip.textContent || "",
      semanticId: tooltip.getAttribute("data-semantic-id"),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });

  const probeResults = [];
  const probeHover = async (probe) => {
    const box = probe.box || await findTargetBox(probe);
    const result = {
      label: probe.label,
      stepLabel: probe.stepLabel,
      requestedLatex: probe.latex || null,
      requestedRole: probe.role || null,
      requestedKind: probe.kind || null,
      contains: Boolean(probe.contains),
      targetBox: box,
    };
    if (box?.missing) {
      probeResults.push(result);
      return result;
    }
    const point = probe.point
      ? probe.point(box)
      : {
          x: box.x + box.width * (probe.xRatio ?? 0.5),
          y: box.y + box.height * (probe.yRatio ?? 0.5),
        };
    const previousHoverCount = requests.filter((request) => request.endpoint === "hover").length;
    if (probe.expectNoTarget) {
      await page.mouse.move(point.x, point.y + 36, { steps: 1 });
      await page.evaluate(() => {
        window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__ = null;
      });
    } else {
      await page.mouse.move(4, 4, { steps: 1 });
    }
    await moveSemanticPointer(page, point.x, point.y);
    await page.waitForTimeout(360);
    const diagnostic = await page.evaluate(() => window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__ || null);
    if (!probe.expectNoTarget && diagnostic?.chosenNodeId) {
      await expect.poll(() => requests.filter((request) => request.endpoint === "hover").at(-1)?.body?.semanticId || "")
        .toBe(diagnostic.chosenNodeId);
    }
    const hoverRequests = requests.filter((request) => request.endpoint === "hover");
    const hoverState = await page.evaluate(() => window.__OMNIMATH_HOVER_STATE__ || null);
    const tooltip = await readTooltip();
    const screenshotPath = `${artifactDir}/${probe.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });
    Object.assign(result, {
      pointer: point,
      requestCountBefore: previousHoverCount,
      requestCountAfter: hoverRequests.length,
      latestRequest: hoverRequests.at(-1)?.body || null,
      diagnostic,
      hoverState,
      tooltip,
      screenshotPath,
    });
    probeResults.push(result);
    return result;
  };

  const probes = [
    { label: "step-4-sec2-lhs", stepLabel: "Step 4 secant cancellation", latex: "\\sec^2\\theta", occurrence: 0, xRatio: 0.18 },
    { label: "step-4-sec2-denominator", stepLabel: "Step 4 secant cancellation", latex: "\\sec^2\\theta", occurrence: 1, xRatio: 0.18 },
    {
      label: "step-5-empty-near-lower-bound",
      stepLabel: "Step 5 bounded auxiliary integral",
      latex: "0",
      role: "lowerBound",
      occurrence: 0,
      point: (box) => ({ x: box.x + box.width / 2, y: box.y + box.height + 13 }),
      expectNoTarget: true,
    },
    { label: "step-2-rhs-numerator", stepLabel: "Step 2 transformed integral", role: "numerator", kind: "group", occurrence: 1 },
    { label: "step-5-upper-denominator", stepLabel: "Step 5 bounded auxiliary integral", latex: "2", role: "denominator", occurrence: 0 },
    { label: "step-6-signed-coefficient", stepLabel: "Step 6 right side", latex: "-2", occurrence: 0 },
    { label: "step-8-lhs-ln-cos", stepLabel: "Step 8 logarithmic identity", latex: "\\ln", occurrence: 0 },
    { label: "step-8-rhs-theta", stepLabel: "Step 8 logarithmic identity", latex: "\\theta", occurrence: 1 },
    { label: "step-8-differential-d", stepLabel: "Step 8 logarithmic identity", latex: "d", role: "differentialOperator", occurrence: 0 },
    { label: "step-9-left-expression", stepLabel: "Step 9 differential expression", latex: "\\ln", occurrence: 0 },
    { label: "final-numerator-plus", stepLabel: "Final answer", latex: "+", occurrence: 0 },
    { label: "final-denominator-plus", stepLabel: "Final answer", latex: "+", occurrence: 1 },
    { label: "step-7-upper-denominator", stepLabel: "Step 7 integration by parts setup", latex: "2", role: "denominator", occurrence: 0 },
    {
      label: "final-empty-below-fraction",
      stepLabel: "Final answer",
      latex: "+",
      occurrence: 1,
      point: (box) => ({ x: box.x + box.width / 2, y: box.y + box.height + 26 }),
      expectNoTarget: true,
    },
  ];

  for (const probe of probes) {
    await probeHover(probe);
  }

  const sourceRenderSnapshot = await page.evaluate(() => [...document.querySelectorAll(".step-card")]
    .filter((card) => /Step [12456789]|Final answer/.test(card.textContent || ""))
    .map((card) => ({
      label: card.querySelector("button")?.textContent || "",
      visibleText: card.textContent || "",
      chunks: [...card.querySelectorAll("[data-inspectable='math-token']")].map((chunk) => ({
        renderedLatex: chunk.getAttribute("data-token-latex"),
        semanticFallback: chunk.querySelector("[data-semantic-render-fallback]")?.getAttribute("data-semantic-render-fallback") || null,
        katexText: chunk.querySelector(".katex-html")?.textContent || "",
        semanticIds: [...chunk.querySelectorAll("[data-semantic-id]")].map((node) => node.getAttribute("data-semantic-id")).filter(Boolean).slice(0, 40),
        semanticDomSpans: [...chunk.querySelectorAll("[data-semantic-id]")]
          .map((node) => {
            const rects = [...node.getClientRects()].map((rect) => ({
              left: Math.round(rect.left * 100) / 100,
              top: Math.round(rect.top * 100) / 100,
              right: Math.round(rect.right * 100) / 100,
              bottom: Math.round(rect.bottom * 100) / 100,
              width: Math.round(rect.width * 100) / 100,
              height: Math.round(rect.height * 100) / 100,
            }));
            return {
              semanticId: node.getAttribute("data-semantic-id"),
              role: node.getAttribute("data-semantic-role"),
              type: node.getAttribute("data-semantic-type"),
              kind: node.getAttribute("data-semantic-kind"),
              range: node.getAttribute("data-semantic-range"),
              text: node.textContent || "",
              className: String(node.className || ""),
              rectCount: rects.length,
              rects,
            };
          }),
        semanticHitboxes: [...chunk.querySelectorAll(".math-semantic-hitbox[data-token-id]")]
          .map((node) => {
            const rect = node.getBoundingClientRect();
            return {
              id: node.getAttribute("data-token-id"),
              semanticId: node.getAttribute("data-semantic-id"),
              latex: node.getAttribute("data-token-latex"),
              role: node.getAttribute("data-token-role"),
              kind: node.getAttribute("data-target-kind"),
              rectSource: node.getAttribute("data-rect-source"),
              sourceRange: node.getAttribute("data-source-range"),
              geometryQuality: node.getAttribute("data-geometry-quality"),
              width: Math.round(rect.width * 100) / 100,
              height: Math.round(rect.height * 100) / 100,
              rect: {
                left: Math.round(rect.left * 100) / 100,
                top: Math.round(rect.top * 100) / 100,
                right: Math.round(rect.right * 100) / 100,
                bottom: Math.round(rect.bottom * 100) / 100,
              },
            };
          }),
      })),
    })));
  await writeFile(`${artifactDir}/complex-integral-hover-report.json`, JSON.stringify({
    requests,
    probes: probeResults,
    sourceRenderSnapshot,
  }, null, 2));

  expect(probeResults).toHaveLength(probes.length);
  expect(sourceRenderSnapshot.length).toBeGreaterThan(0);

  const byLabel = new Map(probeResults.map((probe) => [probe.label, probe]));
  const winnerLatex = (label) => byLabel.get(label)?.diagnostic?.winningCandidate?.expression || null;
  const winner = (label) => byLabel.get(label)?.diagnostic?.winningCandidate || null;
  const finalTarget = (label) => byLabel.get(label)?.diagnostic?.finalTarget || null;
  const sourceRange = (value) => {
    const raw = typeof value === "string" ? value : value?.sourceRange;
    if (!raw) return null;
    if (typeof raw === "string") {
      const [start, end] = raw.split(":").map(Number);
      return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
    }
    const start = Number(raw.start);
    const end = Number(raw.end);
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
  };
  const isContainedInTargetBox = (label) => {
    const probe = byLabel.get(label);
    const child = sourceRange(winner(label));
    const parent = sourceRange(probe?.targetBox);
    if (!child || !parent) return true;
    return child.start >= parent.start && child.end <= parent.end;
  };
  const assertResolved = (label, options = {}) => {
    const probe = byLabel.get(label);
    const chosenId = probe?.diagnostic?.chosenNodeId;
    expect(probe?.targetBox?.missing).toBeFalsy();
    expect(probe?.diagnostic?.fallbackUsed).not.toBe(true);
    expect(chosenId).toBeTruthy();
    expect(finalTarget(label)).toBe(chosenId);
    expect(probe?.hoverState?.hoverState?.semanticId).toBe(chosenId);
    expect(probe?.latestRequest?.semanticId).toBe(chosenId);
    expect(probe?.latestRequest?.selectedLatex).toBe(winnerLatex(label));
    expect(probe?.latestRequest?.targetRole).toBe(probe?.diagnostic?.chosenRole);
    expect(probe?.latestRequest?.semanticSourceRange).toEqual(probe?.diagnostic?.selected?.sourceRange);
    expect(probe?.tooltip?.semanticId).toBe(chosenId);
    if (options.notLatex) expect(winnerLatex(label)).not.toBe(options.notLatex);
    if (options.expectedLatex) {
      const actualLatex = winnerLatex(label);
      if (probe?.contains && actualLatex?.includes(options.expectedLatex)) {
        expect(actualLatex).toContain(options.expectedLatex);
      } else {
        expect(actualLatex).toBe(options.expectedLatex);
      }
    }
    if (options.geometry && winner(label)?.geometryQuality) expect(options.geometry).toContain(winner(label)?.geometryQuality);
    if (options.withinTargetBox) expect(isContainedInTargetBox(label)).toBe(true);
  };
  const assertNoTarget = (label) => {
    const probe = byLabel.get(label);
    expect(probe?.tooltip).toBeNull();
    expect(probe?.diagnostic?.chosenNodeId || null).toBeNull();
    expect(probe?.hoverState?.hoverState || null).toBeNull();
  };

  assertResolved("step-2-rhs-numerator", {
    notLatex: "\\tan^2\\theta",
    geometry: ["precise_leaf", "precise_group", "fragmented_group", "broad_aggregate"],
  });
  assertResolved("step-4-sec2-lhs", {
    geometry: ["precise_leaf", "precise_group"],
    withinTargetBox: true,
  });
  expect(["\\sec", "2", "\\theta", "\\sec^2\\theta"]).toContain(winnerLatex("step-4-sec2-lhs"));
  assertResolved("step-4-sec2-denominator", {
    geometry: ["precise_leaf", "precise_group"],
    withinTargetBox: true,
  });
  expect(["\\sec", "2", "\\theta", "\\sec^2\\theta"]).toContain(winnerLatex("step-4-sec2-denominator"));
  assertNoTarget("step-5-empty-near-lower-bound");
  assertResolved("step-5-upper-denominator", {
    expectedLatex: "2",
    geometry: ["precise_leaf"],
    withinTargetBox: true,
  });
  assertResolved("step-6-signed-coefficient", {
    expectedLatex: "-2",
    geometry: ["precise_leaf"],
    withinTargetBox: true,
  });
  expect(winnerLatex("step-6-signed-coefficient")).not.toBe("2");
  assertResolved("step-8-lhs-ln-cos", {
    expectedLatex: "\\ln",
    geometry: ["precise_leaf"],
  });
  expect(winnerLatex("step-8-lhs-ln-cos")).not.toBe("\\cos");
  assertResolved("step-8-rhs-theta", {
    expectedLatex: "\\theta",
    geometry: ["precise_leaf"],
    withinTargetBox: true,
  });
  assertResolved("step-8-differential-d", {
    expectedLatex: "d",
    geometry: ["precise_leaf"],
    withinTargetBox: true,
  });
  assertResolved("step-9-left-expression", {
    expectedLatex: "\\ln",
    geometry: ["precise_leaf"],
    withinTargetBox: true,
  });
  expect(winnerLatex("step-9-left-expression")).not.toBe("d\\theta");
  assertResolved("final-numerator-plus", {
    expectedLatex: "+",
    geometry: ["precise_leaf"],
    withinTargetBox: true,
  });
  if (winner("final-numerator-plus")?.nodeKind) expect(winner("final-numerator-plus")?.nodeKind).toBe("operator");
  assertResolved("final-denominator-plus", {
    expectedLatex: "+",
    geometry: ["precise_leaf"],
    withinTargetBox: true,
  });
  if (winner("final-denominator-plus")?.nodeKind) expect(winner("final-denominator-plus")?.nodeKind).toBe("operator");
  assertResolved("step-7-upper-denominator", {
    expectedLatex: "2",
    geometry: ["precise_leaf"],
    withinTargetBox: true,
  });
  assertNoTarget("final-empty-below-fraction");

  const step2Snapshot = sourceRenderSnapshot.find((step) => /Step 2 transformed integral/.test(step.visibleText || step.label));
  const step2Hitboxes = step2Snapshot?.chunks?.flatMap((chunk) => chunk.semanticHitboxes || []) || [];
  const numeratorHitboxes = step2Hitboxes.filter((box) => box.role === "numerator");
  const denominatorHitboxes = step2Hitboxes.filter((box) => box.role === "denominator");
  const boundHitboxes = step2Hitboxes.filter((box) => box.role === "upperBound" || box.role === "lowerBound");
  const differentialHitboxes = step2Hitboxes.filter((box) => box.latex === "d\\theta");
  const semanticGeometry = (hitboxes) => [...Map.groupBy(hitboxes, (box) => box.semanticId).values()]
    .map((fragments) => {
      const left = Math.min(...fragments.map((box) => box.rect.left));
      const top = Math.min(...fragments.map((box) => box.rect.top));
      const right = Math.max(...fragments.map((box) => box.rect.right));
      const bottom = Math.max(...fragments.map((box) => box.rect.bottom));
      return {
        ...fragments[0],
        fragmentCount: fragments.length,
        width: right - left,
        height: bottom - top,
      };
    });
  const complexNumerator = semanticGeometry(numeratorHitboxes)
    .filter((box) => /\\ln/.test(box.latex || "") && /\\theta/.test(box.latex || ""))
    .sort((left, right) => right.width - left.width)[0];
  const denominatorGeometry = semanticGeometry(denominatorHitboxes);

  expect(complexNumerator?.width || 0).toBeGreaterThan(80);
  expect(complexNumerator?.height || 0).toBeGreaterThan(10);
  expect(complexNumerator?.height || 0).toBeLessThan(70);
  expect(complexNumerator?.fragmentCount || 0).toBeGreaterThan(1);
  expect(denominatorGeometry.some((box) => box.width > 40 && box.height > 10)).toBe(true);
  expect(boundHitboxes.length).toBeGreaterThanOrEqual(4);
  expect(differentialHitboxes.some((box) => box.width > 8 && box.height > 10)).toBe(true);
  expect(sourceRenderSnapshot.flatMap((step) => step.chunks || []).some((chunk) => chunk.semanticFallback)).toBe(false);

  for (const probe of probeResults.filter((item) => item.diagnostic?.winningCandidate?.geometryQuality?.startsWith("precise"))) {
    const candidate = probe.diagnostic.winningCandidate;
    expect(candidate.rectangleArea).toBeLessThanOrEqual(Math.max(1, candidate.paintedArea || 0) * 3.5 + 2);
  }
});

test("semantic DOM hitboxes stay tight for quadratic leaves", async ({ page }) => {
  test.slow();
  const largeDiscriminantLatex = "\\Delta=68068²-4\\cdot2\\cdot(-4455969793)";
  const largeDiscriminantTree = buildSemanticTree({
    stepId: "large-discriminant-step-chunk-large-discriminant-step",
    displayLatex: largeDiscriminantLatex,
    enabled: true,
  });
  const largeDiscriminantRender = serializeSemanticTreeToLatex(largeDiscriminantTree);
  const largeDiscriminantNode = (latex, role) => largeDiscriminantTree.flatNodes.find((node) => (
    node.latex === latex && node.role === role
  ));
  const largeDiscriminantBase = largeDiscriminantNode("68068", "base");
  const largeDiscriminantPower = largeDiscriminantNode("68068^2", "power");
  const largeDiscriminantExponent = largeDiscriminantNode("2", "exponent");
  const largeDiscriminantFactor = largeDiscriminantNode("-4455969793", "factor");
  const baseDiagnostic = largeDiscriminantRender.nodeDiagnostics.find((item) => (
    item.semanticId === largeDiscriminantBase?.id
  ));

  expect(largeDiscriminantBase).toBeTruthy();
  expect(baseDiagnostic).toMatchObject({
    annotationStatus: "unsupported",
    reason: "tex-parse-structure-changed",
    serialized: false,
  });
  for (const acceptedNode of [largeDiscriminantPower, largeDiscriminantExponent, largeDiscriminantFactor]) {
    expect(acceptedNode).toBeTruthy();
    expect(largeDiscriminantRender.annotatedNodeIds).toContain(acceptedNode.id);
  }
  const lazyRequests = [];
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Quadratic hitbox regression",
        problem: "Inspect quadratic hitboxes.",
        expression: "3x^2+5x-451=0",
        steps: [{
          id: "quadratic-source",
          label: "Quadratic source",
          math: "3x^2+5x-451=0",
          summary: "Keep the minus and constant leaves separate.",
          chunks: [{
            id: "quadratic-source-chunk",
            display: "3x^2+5x-451=0",
            latex: "3x^2+5x-451=0",
            text: "3x^2+5x-451=0",
            role: "equation",
          }],
        }, {
          id: "quadratic-region",
          label: "Quadratic first-line selection",
          math: "3x^2+5x+6\n3x^2+5x-37=0",
          summary: "Drag selection should stay on the visible line.",
          chunks: [{
            id: "quadratic-region-first",
            display: "3x^2+5x+6",
            latex: "3x^2+5x+6",
            text: "3x^2+5x+6",
            role: "equation",
          }, {
            id: "quadratic-region-second",
            display: "3x^2+5x-37=0",
            latex: "3x^2+5x-37=0",
            text: "3x^2+5x-37=0",
            role: "equation",
          }],
        }, {
          id: "quadratic-formula",
          label: "Quadratic formula",
          math: "x=\\frac{-5\\pm\\sqrt{5^2-4\\cdot3\\cdot(-445)}}{2\\cdot3}",
          summary: "Keep denominator leaves tight.",
          chunks: [{
            id: "quadratic-formula-chunk",
            display: "x=\\frac{-5\\pm\\sqrt{5^2-4\\cdot3\\cdot(-445)}}{2\\cdot3}",
            latex: "x=\\frac{-5\\pm\\sqrt{5^2-4\\cdot3\\cdot(-445)}}{2\\cdot3}",
            text: "x=\\frac{-5\\pm\\sqrt{5^2-4\\cdot3\\cdot(-445)}}{2\\cdot3}",
            role: "equation",
          }],
        }, {
          id: "quadratic-simplified-chain",
          label: "Quadratic simplified chain",
          math: "x=\\frac{-5\\pm\\sqrt{25+216}}{6}=\\frac{-5\\pm\\sqrt{241}}{6}",
          summary: "Repeated simplified denominators should stay independently targetable.",
          chunks: [{
            id: "quadratic-simplified-chain-chunk",
            display: "x=\\frac{-5\\pm\\sqrt{25+216}}{6}=\\frac{-5\\pm\\sqrt{241}}{6}",
            latex: "x=\\frac{-5\\pm\\sqrt{25+216}}{6}=\\frac{-5\\pm\\sqrt{241}}{6}",
            text: "x=\\frac{-5\\pm\\sqrt{25+216}}{6}=\\frac{-5\\pm\\sqrt{241}}{6}",
            role: "equation",
          }],
        }, {
          id: "quadratic-final-formula",
          label: "Quadratic final formula",
          math: "x=\\frac{-5+\\sqrt{241}}{6}\\quad\\text{or}\\quad x=\\frac{-5-\\sqrt{241}}{6}",
          summary: "Keep repeated final-answer leaves independently selectable.",
          chunks: [{
            id: "quadratic-final-formula-chunk",
            display: "x=\\frac{-5+\\sqrt{241}}{6}\\quad\\text{or}\\quad x=\\frac{-5-\\sqrt{241}}{6}",
            latex: "x=\\frac{-5+\\sqrt{241}}{6}\\quad\\text{or}\\quad x=\\frac{-5-\\sqrt{241}}{6}",
            text: "x=\\frac{-5+\\sqrt{241}}{6}\\quad\\text{or}\\quad x=\\frac{-5-\\sqrt{241}}{6}",
            role: "equation",
          }],
        }, {
          id: "imaginary-root-final",
          label: "Imaginary root final answer",
          math: "x=\\frac{-35\\pm i\\sqrt{278471}}{6}",
          summary: "Imaginary radical leaves should remain independently hoverable and selectable.",
          chunks: [{
            id: "imaginary-root-final-chunk",
            display: "x=\\frac{-35\\pm i\\sqrt{278471}}{6}",
            latex: "x=\\frac{-35\\pm i\\sqrt{278471}}{6}",
            text: "x=\\frac{-35\\pm i\\sqrt{278471}}{6}",
            role: "equation",
          }],
        }, {
          id: "large-quadratic-formula",
          label: "Large quadratic formula",
          math: "x=\\frac{-3634\\pm\\sqrt{19671800}}{6}",
          summary: "Every numerator and denominator descendant should be inspectable in a KaTeX fraction layout.",
          chunks: [{
            id: "large-quadratic-formula-chunk",
            display: "x=\\frac{-3634\\pm\\sqrt{19671800}}{6}",
            latex: "x=\\frac{-3634\\pm\\sqrt{19671800}}{6}",
            text: "x=\\frac{-3634\\pm\\sqrt{19671800}}{6}",
            role: "equation",
          }],
        }, {
          id: "large-discriminant-step",
          label: "Large discriminant step",
          math: largeDiscriminantLatex,
          summary: "Power bases and large negative grouped constants should remain token-sized hover targets.",
          chunks: [{
            id: "large-discriminant-step-chunk",
            display: largeDiscriminantLatex,
            latex: largeDiscriminantLatex,
            text: largeDiscriminantLatex,
            role: "equation",
          }],
        }, {
          id: "decimal-fraction-layout",
          label: "Decimal fraction layout",
          math: "\\frac{5345-5902.71}{6}",
          summary: "Integer and decimal literals in the same numerator should both be leaf hover targets.",
          chunks: [{
            id: "decimal-fraction-layout-chunk",
            display: "\\frac{5345-5902.71}{6}",
            latex: "\\frac{5345-5902.71}{6}",
            text: "\\frac{5345-5902.71}{6}",
            role: "equation",
          }],
        }, {
          id: "large-root-final-evaluation",
          label: "Large root final evaluation",
          math: "x_2=\\frac{-68068-200681.07}{4}=-66937.77",
          summary: "Signed decimal numerator terms and final evaluated roots should remain independently hoverable.",
          chunks: [{
            id: "large-root-final-evaluation-chunk",
            display: "x_2=\\frac{-68068-200681.07}{4}=-66937.77",
            latex: "x_2=\\frac{-68068-200681.07}{4}=-66937.77",
            text: "x_2=\\frac{-68068-200681.07}{4}=-66937.77",
            role: "equation",
          }],
        }, {
          id: "terminal-numeric-evaluation",
          label: "Terminal numeric evaluation",
          math: "x_1\\approx\\frac{-12085.3333+10384.548}{2}=-850.3926",
          summary: "Terminal evaluated numeric results should remain independently hoverable.",
          chunks: [{
            id: "terminal-numeric-evaluation-chunk",
            display: "x_1\\approx\\frac{-12085.3333+10384.548}{2}=-850.3926",
            latex: "x_1\\approx\\frac{-12085.3333+10384.548}{2}=-850.3926",
            text: "x_1\\approx\\frac{-12085.3333+10384.548}{2}=-850.3926",
            role: "equation",
          }],
        }, {
          id: "decimal-nested-fraction-radical-layout",
          label: "Decimal nested fraction radical layout",
          math: "\\frac{\\frac{-92.12}{0.5}}{\\sqrt{\\frac{3.14159}{-0.001}}}",
          summary: "Decimal literals inside nested fractions and radicals should stay independently hoverable.",
          chunks: [{
            id: "decimal-nested-fraction-radical-layout-chunk",
            display: "\\frac{\\frac{-92.12}{0.5}}{\\sqrt{\\frac{3.14159}{-0.001}}}",
            latex: "\\frac{\\frac{-92.12}{0.5}}{\\sqrt{\\frac{3.14159}{-0.001}}}",
            text: "\\frac{\\frac{-92.12}{0.5}}{\\sqrt{\\frac{3.14159}{-0.001}}}",
            role: "equation",
          }],
        }, {
          id: "nested-fraction-radical-layout",
          label: "Nested fraction radical layout",
          math: "\\frac{\\frac{1}{2}+\\sqrt{\\frac{9}{4}}}{\\sqrt{\\frac{16}{25}}}",
          summary: "Nested fractions, fractions inside radicals, and radicals inside fractions should all expose descendants.",
          chunks: [{
            id: "nested-fraction-radical-layout-chunk",
            display: "\\frac{\\frac{1}{2}+\\sqrt{\\frac{9}{4}}}{\\sqrt{\\frac{16}{25}}}",
            latex: "\\frac{\\frac{1}{2}+\\sqrt{\\frac{9}{4}}}{\\sqrt{\\frac{16}{25}}}",
            text: "\\frac{\\frac{1}{2}+\\sqrt{\\frac{9}{4}}}{\\sqrt{\\frac{16}{25}}}",
            role: "equation",
          }],
        }, {
          id: "decimal-raw-final-answer",
          label: "Decimal final answer",
          role: "final",
          summary: "Final answer blocks must expose decimal number leaves independently.",
          lines: [{
            id: "decimal-raw-final-answer-line",
            kind: "block",
            latex: "a\\approx5345,\\quad b\\approx5902.71,\\quad c\\approx-0.001",
          }],
        }, {
          id: "quadratic-raw-approximation",
          label: "Raw approximation line",
          summary: "Raw rendered lines must use the same semantic pipeline as chunked steps.",
          lines: [{
            id: "quadratic-raw-approximation-line",
            kind: "block",
            latex: "\\sqrt{41641}\\approx204.07,\\quad x_1\\approx33.51,\\quad x_2\\approx-34.18",
          }],
        }, {
          id: "quadratic-raw-final-answer",
          label: "Final answer",
          role: "final",
          summary: "Final answer blocks must expose the same semantic leaves.",
          lines: [{
            id: "quadratic-raw-final-answer-line",
            kind: "block",
            latex: "x_1\\approx33.51,\\quad x_2\\approx-34.18",
          }],
        }, {
          id: "approximate-final-answer-layout",
          label: "Approximate final answer",
          role: "final",
          summary: "Final answer alternatives should preserve spacing and wrap points while keeping hover targets.",
          lines: [{
            id: "approximate-final-answer-layout-line",
            kind: "block",
            latex: "x\\approx-850.39\\quad\\text{or}\\quad x\\approx-11234.94",
          }],
        }],
        finalAnswerLatex: "x=\\frac{-5+\\sqrt{241}}{6}\\quad\\text{or}\\quad x=\\frac{-5-\\sqrt{241}}{6}",
        usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
      }),
    });
  });

  for (const endpoint of ["**/api/explain-token", "**/api/explain-pin"]) {
    await page.route(endpoint, async (route) => {
      const body = route.request().postDataJSON();
      lazyRequests.push({ endpoint: endpoint.includes("pin") ? "pin" : "hover", body });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: `Selected ${body?.selectedLatex || "math"}`,
          explanation: `${body?.selectedLatex || "This expression"} was selected.`,
        }),
      });
    });
  }

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect quadratic hitboxes.");
  await expect(page.getByRole("button", { name: /Quadratic source/i })).toBeVisible();

  const largeDiscriminantStep = page.locator(".step-card")
    .filter({ hasText: "Large discriminant step" });
  await expect(largeDiscriminantStep.locator(
    `.katex-html [data-semantic-id="${largeDiscriminantBase.id}"]`,
  )).toHaveCount(0);
  await expect(largeDiscriminantStep.locator(
    `.math-semantic-hitbox[data-semantic-id="${largeDiscriminantBase.id}"]`,
  )).toHaveCount(0);
  const largeDiscriminantPowerHitbox = largeDiscriminantStep.locator(
    `.math-semantic-hitbox[data-semantic-id="${largeDiscriminantPower.id}"][data-target-kind="group"]`,
  );
  await expect.poll(() => largeDiscriminantPowerHitbox.count()).toBeGreaterThan(0);
  const largeDiscriminantPowerBox = await largeDiscriminantPowerHitbox.evaluateAll((hitboxes) => {
    const rects = hitboxes.map((hitbox) => hitbox.getBoundingClientRect());
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { width: right - left, height: bottom - top };
  });
  const largeDiscriminantStepBox = await largeDiscriminantStep.boundingBox();
  expect(largeDiscriminantStepBox).not.toBeNull();
  expect(largeDiscriminantPowerBox.width).toBeLessThan(180);
  expect(largeDiscriminantPowerBox.height).toBeLessThan(largeDiscriminantStepBox.height * 0.55);

  const tokenBox = async (stepLabel, latex, role = null) => {
    await page.waitForFunction(({ stepLabel, latex, role }) => {
      const step = [...document.querySelectorAll(".step-card")]
        .find((card) => card.textContent?.includes(stepLabel));
      return [...(step?.querySelectorAll("[data-inspectable='math-subtoken']") || [])]
        .some((candidate) => (
          candidate.getAttribute("data-token-latex") === latex
          && (!role || candidate.getAttribute("data-token-role") === role)
        ));
    }, { stepLabel, latex, role });
    return page.evaluate(({ stepLabel, latex, role }) => {
    const step = [...document.querySelectorAll(".step-card")]
      .find((card) => card.textContent?.includes(stepLabel));
    const nodes = [...(step?.querySelectorAll("[data-inspectable='math-subtoken']") || [])];
    const matches = nodes.filter((candidate) => (
      candidate.getAttribute("data-token-latex") === latex
      && (!role || candidate.getAttribute("data-token-role") === role)
    ));
    const node = matches
      .map((candidate) => ({ candidate, rect: candidate.getBoundingClientRect() }))
      .sort((left, right) => right.rect.top - left.rect.top)[0]?.candidate || null;
    if (!node) return null;
    node.scrollIntoView({ block: "center", inline: "center" });
    const rect = node.getBoundingClientRect();
    const stepRect = step.getBoundingClientRect();
    return {
      id: node.getAttribute("data-token-id"),
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      stepHeight: stepRect.height,
    };
    }, { stepLabel, latex, role });
  };

  const tokenBoxes = async (stepLabel, latex, role = null) => {
    await page.waitForFunction(({ stepLabel, latex, role }) => {
      const step = [...document.querySelectorAll(".step-card")]
        .find((card) => card.textContent?.includes(stepLabel));
      return [...(step?.querySelectorAll("[data-inspectable='math-subtoken']") || [])]
        .filter((candidate) => (
          candidate.getAttribute("data-token-latex") === latex
          && (!role || candidate.getAttribute("data-token-role") === role)
        )).length >= 2;
    }, { stepLabel, latex, role });
    return page.evaluate(({ stepLabel, latex, role }) => {
      const step = [...document.querySelectorAll(".step-card")]
        .find((card) => card.textContent?.includes(stepLabel));
      step?.scrollIntoView({ block: "center", inline: "center" });
      return [...(step?.querySelectorAll("[data-inspectable='math-subtoken']") || [])]
        .filter((candidate) => (
          candidate.getAttribute("data-token-latex") === latex
          && (!role || candidate.getAttribute("data-token-role") === role)
        ))
        .map((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return {
            id: candidate.getAttribute("data-token-id"),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        })
        .sort((left, right) => left.x - right.x || left.y - right.y);
    }, { stepLabel, latex, role });
  };

  const tokenBoxInChunk = async (chunkId, latex, role = null) => {
    await page.waitForFunction(({ chunkId, latex, role }) => {
      const chunk = document.querySelector(`[data-inspectable='math-token'][data-token-id='${chunkId}']`);
      return [...(chunk?.querySelectorAll("[data-inspectable='math-subtoken']") || [])]
        .some((candidate) => (
          candidate.getAttribute("data-token-latex") === latex
          && (!role || candidate.getAttribute("data-token-role") === role)
        ));
    }, { chunkId, latex, role });
    return page.evaluate(({ chunkId, latex, role }) => {
    const chunk = document.querySelector(`[data-inspectable='math-token'][data-token-id='${chunkId}']`);
    const nodes = [...(chunk?.querySelectorAll("[data-inspectable='math-subtoken']") || [])];
    const node = nodes.find((candidate) => (
      candidate.getAttribute("data-token-latex") === latex
      && (!role || candidate.getAttribute("data-token-role") === role)
    ));
    if (!node) return null;
    chunk.scrollIntoView({ block: "center", inline: "center" });
    const rect = node.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
    }, { chunkId, latex, role });
  };

  const freshTokenBox = async (box) => {
    expect(box).not.toBeNull();
    return box.id ? await page.evaluate((id) => {
      const escaped = CSS.escape(id);
      const node = document.querySelector(`[data-token-id='${escaped}']`);
      if (!node) return null;
      node.scrollIntoView({ block: "center", inline: "center" });
      const rect = node.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }, box.id) : box;
  };

  const freshTokenBoxPair = async (startBox, endBox) => {
    expect(startBox).not.toBeNull();
    expect(endBox).not.toBeNull();
    if (!startBox.id || !endBox.id) return [startBox, endBox];
    return page.evaluate(([startId, endId]) => {
      const readBox = (id) => {
        const node = document.querySelector(`[data-token-id='${CSS.escape(id)}']`);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      };
      const startNode = document.querySelector(`[data-token-id='${CSS.escape(startId)}']`);
      startNode?.scrollIntoView({ block: "center", inline: "center" });
      return [readBox(startId), readBox(endId)];
    }, [startBox.id, endBox.id]);
  };

  const hoverBox = async (box, position = { x: 0.5, y: 0.5 }) => {
    const currentBox = await freshTokenBox(box);
    expect(currentBox).not.toBeNull();
    await page.mouse.move(4, 4);
    await moveSemanticPointer(page, currentBox.x + currentBox.width * position.x, currentBox.y + currentBox.height * position.y);
    await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
  };

  const hoverFractionGroupGap = async (stepLabel, role, expectedLatexPattern) => {
    let target = await page.evaluate(({ stepLabel, role }) => {
      const step = [...document.querySelectorAll(".step-card")]
        .find((card) => card.textContent?.includes(stepLabel));
      const group = [...(step?.querySelectorAll(`.math-semantic-hitbox[data-target-kind='group'][data-token-role='${role}'][data-hitbox-region='internal-gap']`) || [])]
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0)
        .sort((left, right) => (right.rect.width * right.rect.height) - (left.rect.width * left.rect.height))[0];
      if (!group) return null;
      group.node.scrollIntoView({ block: "center", inline: "center" });
      const rect = group.node.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        latex: group.node.getAttribute("data-token-latex") || "",
        role: group.node.getAttribute("data-token-role") || "",
        semanticId: group.node.getAttribute("data-semantic-id") || "",
      };
    }, { stepLabel, role });
    expect(target).not.toBeNull();
    await page.waitForTimeout(80);
    target = await page.evaluate((semanticId) => {
      const node = [...document.querySelectorAll(".math-semantic-hitbox[data-hitbox-region='internal-gap']")]
        .find((candidate) => candidate.getAttribute("data-semantic-id") === semanticId);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        latex: node.getAttribute("data-token-latex") || "",
        role: node.getAttribute("data-token-role") || "",
        semanticId: node.getAttribute("data-semantic-id") || "",
      };
    }, target.semanticId);
    expect(target).not.toBeNull();
    await moveSemanticPointer(page, target.x, target.y);
    await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__?.chosenNodeId || ""))
      .toBe(target.semanticId);
    await expect.poll(() => page.evaluate(() => window.__OMNIMATH_HOVER_STATE__?.hoverState?.semanticId || ""))
      .toBe(target.semanticId);
    await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.semanticId || "")
      .toBe(target.semanticId);
    await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-semantic-id", target.semanticId);
    expect(target.role).toBe(role);
    expect(target.latex).toMatch(expectedLatexPattern);
    await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex || "")
      .toMatch(expectedLatexPattern);
  };

  const hitboxCountForStep = async (stepLabel) => page.evaluate((label) => {
    const step = [...document.querySelectorAll(".step-card")]
      .find((card) => card.textContent?.includes(label));
    return step?.querySelectorAll("[data-inspectable='math-subtoken']").length || 0;
  }, stepLabel);

  const initialFinalDenominatorSixes = await tokenBoxes("Quadratic final formula", "6", "denominator");
  expect(initialFinalDenominatorSixes).toHaveLength(2);
  expect(new Set(initialFinalDenominatorSixes.map((box) => box.id)).size).toBe(2);
  const finalHitboxCountBeforeHover = await hitboxCountForStep("Quadratic final formula");
  for (const box of initialFinalDenominatorSixes) {
    await hoverBox(box);
    await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("6");
  }
  expect(await hitboxCountForStep("Quadratic final formula")).toBeLessThanOrEqual(finalHitboxCountBeforeHover);

  const n451 = await tokenBox("Quadratic source", "-451");
  await hoverBox(n451);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("-451");

  const denominatorTwo = await tokenBox("Quadratic formula", "2");
  await hoverBox(denominatorTwo);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("2");
  expect(denominatorTwo.height).toBeLessThan(denominatorTwo.stepHeight * 0.45);

  const negativeFive = await tokenBox("Quadratic formula", "-5");
  await hoverBox(negativeFive);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("-5");
  await page.mouse.click(negativeFive.x + negativeFive.width / 2, negativeFive.y + negativeFive.height / 2, { button: "right" });
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "pin").at(-1)?.body?.selectedLatex).toBe("-5");
  await page.getByRole("button", { name: /Close explanation/i }).click();
  await expect(page.locator(".omni-floating-window")).toHaveCount(0);

  const denominatorSix = await tokenBox("Quadratic final formula", "6");
  await hoverBox(denominatorSix);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("6");
  await contextClickSemanticPointer(page, denominatorSix.x + denominatorSix.width / 2, denominatorSix.y + denominatorSix.height / 2);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "pin").at(-1)?.body?.selectedLatex).toBe("6");
  await page.getByRole("button", { name: /Close explanation/i }).click();
  await expect(page.locator(".omni-floating-window")).toHaveCount(0);

  const denominatorSixes = await tokenBoxes("Quadratic final formula", "6", "denominator");
  expect(denominatorSixes).toHaveLength(2);
  expect(new Set(denominatorSixes.map((box) => box.id)).size).toBe(2);
  for (const box of denominatorSixes) {
    await hoverBox(box);
    await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("6");
  }

  const chainDenominatorSixes = await tokenBoxes("Quadratic simplified chain", "6", "denominator");
  expect(chainDenominatorSixes).toHaveLength(2);
  expect(new Set(chainDenominatorSixes.map((box) => box.id)).size).toBe(2);
  for (const box of chainDenominatorSixes) {
    await hoverBox(box);
    await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("6");
  }
  const chainNegativeFives = await tokenBoxes("Quadratic simplified chain", "-5");
  expect(new Set(chainNegativeFives.map((box) => box.id)).size).toBeGreaterThanOrEqual(2);

  await hoverBox(await tokenBox("Imaginary root final answer", "i", "imaginaryUnit"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("i");
  await hoverBox(await tokenBox("Imaginary root final answer", "\\sqrt", "radical"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("\\sqrt");
  const imaginaryRadicand = await tokenBox("Imaginary root final answer", "278471", "radicand");
  await hoverBox(imaginaryRadicand, { x: 0.97, y: 0.5 });
  await expect.poll(async () => {
    const requestLatex = lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex;
    if (requestLatex === "278471") return requestLatex;
    return page.evaluate(() => window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__?.chosenLatex || "");
  }).toBe("278471");
  await expect.poll(async () => {
    const requestRole = lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.targetRole;
    if (requestRole === "radicand") return requestRole;
    return page.evaluate(() => window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__?.chosenRole || "");
  }).toBe("radicand");

  await hoverBox(await tokenBox("Large quadratic formula", "-3634"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("-3634");
  await hoverBox(await tokenBox("Large quadratic formula", "\\pm"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("\\pm");
  await hoverBox(await tokenBox("Large quadratic formula", "\\sqrt", "radical"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("\\sqrt");
  await hoverBox(await tokenBox("Large quadratic formula", "19671800", "radicand"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("19671800");
  await hoverBox(await tokenBox("Large quadratic formula", "6", "denominator"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("6");
  await hoverFractionGroupGap("Large quadratic formula", "numerator", /-3634.*\\pm.*\\sqrt/);

  for (const [stepLabel, latex, role] of [
    ["Decimal fraction layout", "5345", "constant"],
    ["Decimal fraction layout", "-5902.71", "constant"],
    ["Decimal fraction layout", "6", "denominator"],
    ["Large discriminant step", "2", "exponent"],
    ["Large discriminant step", "-4455969793", "factor"],
    ["Large root final evaluation", "-68068", "constant"],
    ["Large root final evaluation", "-200681.07", "constant"],
    ["Large root final evaluation", "4", "denominator"],
    ["Large root final evaluation", "-66937.77", null],
    ["Terminal numeric evaluation", "-12085.3333", "numerator"],
    ["Terminal numeric evaluation", "10384.548", "numerator"],
    ["Terminal numeric evaluation", "2", "denominator"],
    ["Terminal numeric evaluation", "-850.3926", null],
    ["Decimal nested fraction radical layout", "-92.12", "numerator"],
    ["Decimal nested fraction radical layout", "0.5", "denominator"],
    ["Decimal nested fraction radical layout", "3.14159", "numerator"],
    ["Decimal nested fraction radical layout", "-0.001", "denominator"],
    ["Decimal final answer", "5345", null],
    ["Decimal final answer", "5902.71", null],
    ["Decimal final answer", "-0.001", null],
  ]) {
    await hoverBox(await tokenBox(stepLabel, latex, role));
    await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe(latex);
  }
  const rowTightTargets = [
    await tokenBox("Large discriminant step", "-4455969793", "factor"),
    await tokenBox("Large root final evaluation", "-200681.07", "constant"),
    await tokenBox("Large root final evaluation", "-66937.77"),
  ];
  for (const box of rowTightTargets) {
    expect(box.width).toBeLessThan(180);
    expect(box.height).toBeLessThan(box.stepHeight * 0.55);
  }
  await hoverBox(await tokenBox("Decimal nested fraction radical layout", "\\sqrt", "radical"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("\\sqrt");

  for (const [latex, role] of [["1", "numerator"], ["2", "denominator"], ["9", "numerator"], ["4", "denominator"], ["16", "numerator"], ["25", "denominator"]]) {
    await hoverBox(await tokenBox("Nested fraction radical layout", latex, role));
    await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe(latex);
  }
  const nestedRadicals = await tokenBoxes("Nested fraction radical layout", "\\sqrt", "radical");
  expect(nestedRadicals.length).toBeGreaterThanOrEqual(2);
  for (const box of nestedRadicals.slice(0, 2)) {
    await hoverBox(box);
    await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("\\sqrt");
  }
  await hoverFractionGroupGap("Nested fraction radical layout", "numerator", /\\frac\{1\}\{2\}|\\sqrt/);

  const imaginaryUnit = await tokenBox("Imaginary root final answer", "i", "imaginaryUnit");
  const [currentImaginaryUnit, currentImaginaryRadicand] = await freshTokenBoxPair(imaginaryUnit, imaginaryRadicand);
  expect(currentImaginaryUnit).not.toBeNull();
  expect(currentImaginaryRadicand).not.toBeNull();
  const hoverRequestCountBeforeImaginaryDrag = lazyRequests.filter((request) => request.endpoint === "hover").length;
  await page.mouse.move(
    currentImaginaryUnit.x + currentImaginaryUnit.width / 2,
    currentImaginaryUnit.y + currentImaginaryUnit.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    currentImaginaryRadicand.x + currentImaginaryRadicand.width / 2,
    currentImaginaryRadicand.y + currentImaginaryRadicand.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(page.locator(".omni-quick-tooltip")).toContainText(/Selected region/i);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").length)
    .toBeGreaterThan(hoverRequestCountBeforeImaginaryDrag);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex)
    .toBe("i\\sqrt{278471}");
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.semanticSelection?.normalizedToNodeId || "")
    .toContain("isqrt-278471");
  await page.mouse.click(6, 6);
  await page.mouse.move(6, 6);

  for (const latex of ["241", "-5", "x"]) {
    const boxes = await tokenBoxes("Quadratic final formula", latex);
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(boxes.map((box) => box.id)).size).toBeGreaterThanOrEqual(2);
    for (const box of boxes.slice(0, 2)) {
      await hoverBox(box);
      await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe(latex);
    }
  }

  const finalNegativeFives = await tokenBoxes("Quadratic final formula", "-5");
  const finalRadicands = await tokenBoxes("Quadratic final formula", "241");
  const hoverRequestCountBeforeLeftRootDrag = lazyRequests.filter((request) => request.endpoint === "hover").length;
  const [firstFinalNegativeFive, firstDenominatorSix] = await freshTokenBoxPair(finalNegativeFives[0], denominatorSixes[0]);
  expect(firstFinalNegativeFive).not.toBeNull();
  expect(firstDenominatorSix).not.toBeNull();
  await page.mouse.move(firstFinalNegativeFive.x + firstFinalNegativeFive.width / 2, firstFinalNegativeFive.y + firstFinalNegativeFive.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstDenominatorSix.x + firstDenominatorSix.width / 2, firstDenominatorSix.y + firstDenominatorSix.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".omni-quick-tooltip")).toContainText(/Selected region/i);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").length)
    .toBeGreaterThan(hoverRequestCountBeforeLeftRootDrag);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex || "")
    .toContain("-5");
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex || "")
    .toContain("6");
  await page.mouse.click(6, 6);
  await page.mouse.move(6, 6);

  await hoverBox(denominatorSixes[1]);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("6");

  const [firstFinalRadicand, secondFinalRadicand] = await freshTokenBoxPair(finalRadicands[0], finalRadicands[1]);
  expect(firstFinalRadicand).not.toBeNull();
  expect(secondFinalRadicand).not.toBeNull();
  await page.mouse.move(firstFinalRadicand.x + firstFinalRadicand.width / 2, firstFinalRadicand.y + firstFinalRadicand.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondFinalRadicand.x + secondFinalRadicand.width / 2, secondFinalRadicand.y + secondFinalRadicand.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".omni-quick-tooltip")).toContainText(/Selected region/i);
  await expect.poll(() => page.evaluate(() => {
    const step = [...document.querySelectorAll(".step-card")]
      .find((card) => card.textContent?.includes("Quadratic final formula"));
    return [...(step?.querySelectorAll(".math-semantic-hitbox.omni-token-selected[data-token-latex='241']") || [])].length;
  })).toBeGreaterThanOrEqual(2);
  await page.mouse.click(6, 6);
  await page.mouse.move(6, 6);

  await hoverBox(finalNegativeFives[1]);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("-5");

  const firstLineChunk = page.locator("[data-inspectable='math-token'][data-token-id='quadratic-region-first']").first();
  await firstLineChunk.scrollIntoViewIfNeeded();
  const firstLineThree = await firstLineChunk.locator("[data-inspectable='math-subtoken'][data-token-latex='3']").first().boundingBox();
  const firstLineSix = await firstLineChunk.locator("[data-inspectable='math-subtoken'][data-token-latex='6']").first().boundingBox();
  expect(firstLineThree).not.toBeNull();
  expect(firstLineSix).not.toBeNull();
  const hoverRequestCountBeforeDrag = lazyRequests.filter((request) => request.endpoint === "hover").length;
  await page.mouse.move(firstLineThree.x + firstLineThree.width / 2, firstLineThree.y + firstLineThree.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstLineSix.x + firstLineSix.width / 2, firstLineSix.y + firstLineSix.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".omni-quick-tooltip")).toContainText(/Selected region/i);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").length)
    .toBeGreaterThan(hoverRequestCountBeforeDrag);
  await expect(firstLineChunk.locator(".math-semantic-hitbox.omni-token-selected")).not.toHaveCount(0);

  await page.mouse.click(6, 6);
  await page.mouse.move(4, 4);
  await hoverBox(firstLineThree);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex || "")
    .toMatch(/^(3|x)$/);

  await hoverBox(await tokenBox("Raw approximation line", "\\sqrt", "radical"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("\\sqrt");
  await hoverBox(await tokenBox("Raw approximation line", "204.07"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("204.07");
  await hoverBox(await tokenBox("Raw approximation line", "x_1"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("x_1");
  await hoverBox(await tokenBox("Raw approximation line", "x_2"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("x_2");
  await hoverBox(await tokenBox("Raw approximation line", "33.51"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("33.51");
  await hoverBox(await tokenBox("Raw approximation line", "-34.18"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("-34.18");

  await hoverBox(await tokenBox("Final answer", "33.51"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("33.51");
  await hoverBox(await tokenBox("Final answer", "-34.18"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("-34.18");

  await hoverBox(await tokenBox("Approximate final answer", "-850.39"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("-850.39");
  await hoverBox(await tokenBox("Approximate final answer", "-11234.94"));
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("-11234.94");
  const finalAnswerLayout = await page.evaluate(() => {
    const step = [...document.querySelectorAll(".step-card")]
      .find((card) => card.textContent?.includes("Approximate final answer"));
    const segments = [...(step?.querySelectorAll(".omni-equation-chain-segment") || [])]
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { text: node.textContent || "", left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
    const separator = step?.querySelector(".omni-equation-chain-separator");
    const separatorRect = separator?.getBoundingClientRect();
    return {
      text: step?.textContent || "",
      segmentCount: segments.length,
      segments,
      separator: separator ? {
        text: separator.textContent || "",
        left: separatorRect.left,
        right: separatorRect.right,
        top: separatorRect.top,
        bottom: separatorRect.bottom,
        width: separatorRect.width,
      } : null,
    };
  });
  expect(finalAnswerLayout.segmentCount).toBe(2);
  expect(finalAnswerLayout.separator?.text).toBe("or");
  expect(finalAnswerLayout.separator?.width).toBeGreaterThan(12);
  for (const segment of finalAnswerLayout.segments) {
    expect(segment.right).toBeGreaterThan(segment.left);
    expect(segment.bottom).toBeGreaterThan(segment.top);
  }
  const [firstFinalSegment, secondFinalSegment] = finalAnswerLayout.segments;
  const separator = finalAnswerLayout.separator;
  const sameRow = (left, right) => Math.abs(((left.top + left.bottom) / 2) - ((right.top + right.bottom) / 2)) < 8;
  if (sameRow(firstFinalSegment, separator)) {
    expect(separator.left).toBeGreaterThanOrEqual(firstFinalSegment.right - 1);
  }
  if (sameRow(separator, secondFinalSegment)) {
    expect(secondFinalSegment.left).toBeGreaterThanOrEqual(separator.right - 1);
  }

  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll(".math-semantic-hitbox")]
    .some((node) => node.hasAttribute("title")))).toBe(false);
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll(".math-semantic-hitbox")]
    .some((node) => node.hasAttribute("data-debug-label")))).toBe(false);
});

test("fraction result hit-testing exposes leaves and pins fraction only through drag cluster", async ({ page }) => {
  const lazyRequests = [];
  await installHierarchicalTokenApiFixtures(page, { lazyRequests });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Evaluate the cosine power integral.");

  await expect(page.getByRole("button", { name: /Cosine power integral/i })).toBeVisible();
  await expect(page.locator("[data-inspectable='math-subtoken'][data-token-latex='\\\\frac{3\\\\pi}{4}']")).toHaveCount(0);

  const hoverSemanticTarget = async (locator, expectedLatex) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    await moveSemanticPointer(page, box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe(expectedLatex);
  };

  const three = page.locator("[data-inspectable='math-subtoken'][data-token-role='coefficient'][data-token-latex='3']").first();
  const pi = page.locator("[data-inspectable='math-subtoken'][data-token-latex='\\\\pi']").first();
  await hoverSemanticTarget(three, "3");
  await hoverSemanticTarget(pi, "\\pi");
  await hoverSemanticTarget(
    page.locator("[data-inspectable='math-subtoken'][data-token-role='denominator'][data-token-latex='4']").first(),
    "4"
  );
  await hoverSemanticTarget(
    page.locator("[data-inspectable='math-subtoken'][data-token-role='exponent'][data-token-latex='4']").first(),
    "4"
  );
  await hoverSemanticTarget(
    page.locator("[data-inspectable='math-subtoken'][data-token-role='differentialOperator'][data-token-latex='d']").first(),
    "d"
  );

  const threeBox = await three.boundingBox();
  const denominatorBox = await page.locator("[data-inspectable='math-subtoken'][data-token-role='denominator'][data-token-latex='4']").first().boundingBox();
  expect(threeBox).not.toBeNull();
  expect(denominatorBox).not.toBeNull();
  await page.mouse.move(threeBox.x + threeBox.width / 2, threeBox.y + threeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(denominatorBox.x + denominatorBox.width / 2, denominatorBox.y + denominatorBox.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".omni-quick-tooltip")).toContainText(/Selected region/i);
  await page.mouse.click(denominatorBox.x + denominatorBox.width / 2, denominatorBox.y + denominatorBox.height / 2, { button: "right" });
  await expect(page.locator(".omni-floating-window")).toBeVisible();
  await expect(page.locator(".omni-floating-window")).not.toContainText("Integral of cos4 over");
});

test("radial integral hit-testing resolves visible subexpressions before parent step fallback", async ({ page }) => {
  const lazyRequests = [];
  await installHierarchicalTokenApiFixtures(page, { lazyRequests });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Evaluate the radial integral.");

  await expect(page.getByRole("button", { name: /Radial final integral/i })).toBeVisible();

  const hoverSemanticTarget = async (locator, expectedLatex) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    await moveSemanticPointer(page, box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
    await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe(expectedLatex);
  };

  const sixR = page.locator("[data-inspectable='math-subtoken'][data-token-latex='6']").first();
  await hoverSemanticTarget(sixR, "6");
  await expect(page.locator(".omni-quick-tooltip")).toContainText("6");
  await expect(page.locator(".omni-quick-tooltip")).not.toContainText("Radial final integral");

  await hoverSemanticTarget(
    page.locator("[data-inspectable='math-subtoken'][data-token-latex='12']").first(),
    "12"
  );
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex)
    .not.toBe("\\int_0^1 (6r+12r^2)\\,dr");

  await hoverSemanticTarget(
    page.locator("[data-inspectable='math-subtoken'][data-token-latex='45']").first(),
    "45"
  );

  const sixRBox = await sixR.boundingBox();
  expect(sixRBox).not.toBeNull();
  await page.mouse.click(sixRBox.x + sixRBox.width / 2, sixRBox.y + sixRBox.height / 2, { button: "right" });
  await expect(page.locator(".omni-floating-window")).toBeVisible();
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "pin").at(-1)?.body?.selectedLatex).toBe("6");
  await expect(page.locator(".omni-floating-window")).toContainText("6");
  await page.getByRole("button", { name: /Close explanation/i }).click();
  await expect(page.locator(".omni-floating-window")).toHaveCount(0);

  const stepCard = page.locator(".step-card", { has: page.getByRole("button", { name: /Radial final integral/i }) });
  const stepBox = await stepCard.boundingBox();
  expect(stepBox).not.toBeNull();
  await page.mouse.move(stepBox.x + stepBox.width - 24, stepBox.y + 24);
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex)
    .not.toBe("\\int_0^1 (6r+12r^2)\\,dr");
});

test("tiny leading coefficient before an integral resolves before the wider integral target", async ({ page }) => {
  const lazyRequests = [];
  await installHierarchicalTokenApiFixtures(page, { lazyRequests });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect the odd-function coefficient.");
  const step = page.locator(".step-card", { has: page.getByRole("button", { name: "Select step 5" }) });
  await expect(step).toBeVisible({ timeout: 20000 });
  const coefficient = step.locator("[data-inspectable='math-subtoken'][data-token-latex='3']").first();

  const wideTargetBox = async () => page.evaluate(() => {
    const step = [...document.querySelectorAll(".step-card")]
      .find((card) => card.querySelector("button[aria-label='Select step 5']"));
    const node = [...(step?.querySelectorAll("[data-inspectable='math-subtoken']") || [])]
      .find((candidate) => candidate.getAttribute("data-token-latex") === "3");
    if (!node) return null;
    node.scrollIntoView({ block: "center", inline: "center" });
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await expect.poll(() => page.evaluate(() => {
    const step = [...document.querySelectorAll(".step-card")]
      .find((card) => card.querySelector("button[aria-label='Select step 5']"));
    return [...(step?.querySelectorAll("[data-inspectable='math-subtoken']") || [])]
      .some((candidate) => candidate.getAttribute("data-token-latex") === "3");
  }), { timeout: 20000 }).toBe(true);
  await expect(coefficient).toBeVisible({ timeout: 20000 });
  const coefficientBox = await wideTargetBox();
  expect(coefficientBox).not.toBeNull();
  await moveSemanticPointer(page, coefficientBox.x + Math.min(4, coefficientBox.width * 0.04), coefficientBox.y + coefficientBox.height / 2);
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex)
    .toBe("3");

  await expect(page.locator("[data-inspectable='math-subtoken'][data-token-latex='3\\\\int_0^{2\\\\pi}\\\\cos\\\\theta']")).toHaveCount(0);
});

test("radical operator geometry stays separate from the radicand", async ({ page }) => {
  const lazyRequests = [];
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Radical hitbox regression",
        problem: "Inspect radical hitboxes.",
        expression: "x=\\frac{-35\\pm i\\sqrt{278471}}{6}",
        steps: [{
          id: "imaginary-root-final",
          label: "Imaginary root final answer",
          math: "x=\\frac{-35\\pm i\\sqrt{278471}}{6}",
          summary: "Imaginary radical leaves should remain independently hoverable and selectable.",
          chunks: [{
            id: "imaginary-root-final-chunk",
            display: "x=\\frac{-35\\pm i\\sqrt{278471}}{6}",
            latex: "x=\\frac{-35\\pm i\\sqrt{278471}}{6}",
            text: "x=\\frac{-35\\pm i\\sqrt{278471}}{6}",
            role: "equation",
          }],
        }],
        finalAnswerLatex: "x=\\frac{-35\\pm i\\sqrt{278471}}{6}",
        usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
      }),
    });
  });
  await page.route("**/api/explain-token", async (route) => {
    const body = route.request().postDataJSON();
    lazyRequests.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: `Selected ${body?.selectedLatex || "math"}`,
        explanation: `${body?.selectedLatex || "This expression"} was selected.`,
      }),
    });
  });

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect radical hitboxes.");
  await expect(page.getByRole("button", { name: /Imaginary root final answer/i })).toBeVisible();

  const readBox = async (latex, role) => page.evaluate(({ latex, role }) => {
    const node = [...document.querySelectorAll(".math-semantic-hitbox[data-token-id]")]
      .find((candidate) => (
        candidate.getAttribute("data-token-latex") === latex
        && candidate.getAttribute("data-token-role") === role
        && candidate.getAttribute("data-target-kind") === "leaf"
      ));
    if (!node) return null;
    node.scrollIntoView({ block: "center", inline: "center" });
    const rect = node.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      quality: node.getAttribute("data-geometry-quality"),
    };
  }, { latex, role });

  await page.waitForFunction(() => [...document.querySelectorAll(".math-semantic-hitbox[data-token-id]")]
    .some((candidate) => candidate.getAttribute("data-token-latex") === "\\sqrt"
      && candidate.getAttribute("data-token-role") === "radical"
      && candidate.getAttribute("data-target-kind") === "leaf"));
  const radical = await readBox("\\sqrt", "radical");
  const radicand = await readBox("278471", "radicand");
  expect(radical).not.toBeNull();
  expect(radicand).not.toBeNull();
  expect(radical.quality).toBe("precise_leaf");
  expect(radicand.quality).toBe("precise_leaf");
  expect(radical.width).toBeLessThan(radicand.width * 0.6);

  const currentRadical = await readBox("\\sqrt", "radical");
  await moveSemanticPointer(page, currentRadical.x + currentRadical.width / 2, currentRadical.y + currentRadical.height / 2);
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
  await expect.poll(() => lazyRequests.at(-1)?.selectedLatex || "").toBe("\\sqrt");

  const currentRadicand = await readBox("278471", "radicand");
  await moveSemanticPointer(page, currentRadicand.x + currentRadicand.width * 0.97, currentRadicand.y + currentRadicand.height / 2);
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
  await expect.poll(() => lazyRequests.at(-1)?.selectedLatex || "").toBe("278471");
  await expect.poll(() => lazyRequests.at(-1)?.targetRole || "").toBe("radicand");
  await expect.poll(() => page.evaluate(() => (
    window.__OMNIMATH_HOVER_PERF__?.last?.pointerResolveComplete?.layoutReadCount ?? null
  ))).toBe(0);
});

test("compound function hover targets stay leaf-sized", async ({ page }) => {
  const lazyRequests = [];
  await installHierarchicalTokenApiFixtures(page, { lazyRequests });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect zero-product simplifications.");

  const hoverExactLatex = async (latex, expectedLatex, xRatio = 0.5) => {
    const stepLabel = "Zero product simplification";
    await expect.poll(() => page.evaluate(({ targetLatex, stepLabel: label }) => {
      const step = [...document.querySelectorAll(".step-card")]
        .find((card) => card.textContent?.includes(label));
      return [...(step?.querySelectorAll("[data-inspectable='math-subtoken']") || [])]
        .some((candidate) => candidate.getAttribute("data-token-latex") === targetLatex);
    }, { targetLatex: latex, stepLabel })).toBe(true);
    const targetHandle = await page.evaluateHandle(({ targetLatex, stepLabel: label }) => {
      const step = [...document.querySelectorAll(".step-card")]
        .find((card) => card.textContent?.includes(label));
      return [...(step?.querySelectorAll("[data-inspectable='math-subtoken']") || [])]
        .find((candidate) => candidate.getAttribute("data-token-latex") === targetLatex);
    }, { targetLatex: latex, stepLabel });
    const target = targetHandle.asElement();
    expect(target).not.toBeNull();
    const box = await page.evaluate(({ targetLatex, stepLabel: label }) => {
      const step = [...document.querySelectorAll(".step-card")]
        .find((card) => card.textContent?.includes(label));
      const node = [...(step?.querySelectorAll("[data-inspectable='math-subtoken']") || [])]
        .find((candidate) => candidate.getAttribute("data-token-latex") === targetLatex);
      if (!node) return null;
      node.scrollIntoView({ block: "center", inline: "center" });
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, { targetLatex: latex, stepLabel });
    expect(box).not.toBeNull();
    const previousHoverCount = lazyRequests.filter((request) => request.endpoint === "hover").length;
    await moveSemanticPointer(page, box.x + Math.max(1, box.width * xRatio), box.y + Math.max(1, box.height / 2));
    await expect.poll(async () => {
      const hoverRequests = lazyRequests.filter((request) => request.endpoint === "hover");
      if (hoverRequests.length > previousHoverCount) return hoverRequests.at(-1)?.body?.selectedLatex;
      return page.evaluate(() => window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__?.chosenLatex || "");
    })
      .toBe(expectedLatex);
  };

  await hoverExactLatex("\\sin", "\\sin", 0.5);
  await hoverExactLatex("0", "0", 0.82);
  await hoverExactLatex("\\cos", "\\cos", 0.5);
  await hoverExactLatex("2", "2", 0.84);
  await hoverExactLatex("\\theta", "\\theta", 0.5);
  await expect(page.locator("[data-inspectable='math-subtoken'][data-token-latex='e^{4\\\\cos^2\\\\theta}\\\\sin(0)']")).toHaveCount(0);
  await expect(page.locator("[data-inspectable='math-subtoken'][data-token-latex='(0)(-2\\\\sin\\\\theta)']")).toHaveCount(0);
});

test("small product hover prefers coefficient, function name, exponent, and variable leaves", async ({ page }) => {
  const lazyRequests = [];
  await installHierarchicalTokenApiFixtures(page, { lazyRequests });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect 4r squared cosine squared theta.");

  await expect(page.getByRole("button", { name: /Small token product/i })).toBeVisible();
  const step = page.locator(".step-card", { has: page.getByRole("button", { name: /Small token product/i }) });

  const hoverInStep = async (latex, expectedLatex = latex) => {
    const target = step.locator(`[data-inspectable='math-subtoken'][data-token-latex='${latex}']`).first();
    await expect(target).toBeVisible();
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    await moveSemanticPointer(page, box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
    await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex)
      .toBe(expectedLatex);
    return target;
  };

  await hoverInStep("4");
  await expect(page.locator(".omni-quick-tooltip")).not.toContainText(/^Base$/);
  await hoverInStep("\\\\sin", "\\sin");
  await hoverInStep("2");
  await hoverInStep("\\\\theta", "\\theta");
  await expect(step.locator("[data-inspectable='math-subtoken'][data-token-latex='4r^2\\\\cos^2\\\\theta']")).toHaveCount(0);
});

test("long vector-field equations scroll inside math containers without page overflow", async ({ page }) => {
  await installLongLatexApiFixtures(page);
  await page.setViewportSize({ width: 1680, height: 1050 });

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, LONG_STOKES_PROBLEM);

  await expect(page.getByRole("button", { name: /Apply Stokes['’] theorem/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Final answer/i })).toBeVisible();
  await expect(page.locator(".step-card")).toHaveCount(4);
  const summaryCard = page.locator(".omni-problem-summary-card");
  await expect(summaryCard).toBeVisible();
  await expect(summaryCard).toContainText(/Stokes/i);
  await expect(summaryCard).not.toContainText(/y\^2z\+e\^\{x\^2\}\\sin\(yz\)/);

  const collapsedPreview = await summaryCard.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      height: rect.height,
      katexCount: node.querySelectorAll(".katex").length,
      text: node.textContent || "",
    };
  });
  expect(collapsedPreview.height).toBeLessThan(240);
  expect(collapsedPreview.katexCount).toBe(0);

  await page.getByRole("button", { name: /View full problem/i }).click();
  await expect(summaryCard).toContainText(/Full problem text/i);
  await expect(summaryCard).toContainText(/Math preview/i);
  await expect(summaryCard).toContainText(/y\^2z\+e\^\{x\^2\}\\sin\(yz\)/);

  const layout = await page.evaluate(() => {
    const tolerance = 2;
    const pageOverflow = document.documentElement.scrollWidth - window.innerWidth;
    const boardRect = document.querySelector(".solution-board")?.getBoundingClientRect();
    const flowRect = document.querySelector(".omni-solution-flow")?.getBoundingClientRect();
    const mathFontSizes = [...document.querySelectorAll(".omni-solution-flow .omni-equation-line, .omni-solution-flow .omni-math-block")]
      .map((node) => Number.parseFloat(getComputedStyle(node).fontSize))
      .filter(Number.isFinite);
    const stepRects = [...document.querySelectorAll(".step-card")].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        text: node.textContent?.slice(0, 80) || "",
        width: rect.width,
        height: rect.height,
        visible: rect.bottom > 0 && rect.top < window.innerHeight,
      };
    });
    const finalAnswer = document.querySelector(".final-answer-step[data-final-answer='true']");
    const finalAnswerRect = finalAnswer?.getBoundingClientRect();
    const finalAnswerStyle = finalAnswer ? getComputedStyle(finalAnswer) : null;
    const nestedVerticalScrollbars = [...document.querySelectorAll(".solution-board *")]
      .filter((node) => {
        const style = getComputedStyle(node);
        return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 12;
      })
      .map((node) => ({
        className: node.className || node.tagName,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      }));
    const mathShells = [...document.querySelectorAll(".math-render-shell-block, .omni-math-block")].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        escapesViewport: rect.left < -tolerance || rect.right > window.innerWidth + tolerance,
      };
    });

    return {
      pageOverflow,
      boardWidth: boardRect?.width || 0,
      flowWidth: flowRect?.width || 0,
      minMathFontSize: Math.min(...mathFontSizes),
      stepRects,
      finalAnswer: finalAnswer ? {
        visible: finalAnswerRect.width > 0 && finalAnswerRect.height > 0,
        boxShadow: finalAnswerStyle.boxShadow,
        background: finalAnswerStyle.backgroundImage || finalAnswerStyle.backgroundColor,
      } : null,
      nestedVerticalScrollbars,
      mathShells,
      hasInternalMathScroll: mathShells.some((shell) => shell.scrollWidth > shell.clientWidth + tolerance),
      summaryCard: (() => {
        const node = document.querySelector(".omni-problem-summary-card");
        const rect = node?.getBoundingClientRect();
        return node ? {
          width: rect.width,
          height: rect.height,
          escapesViewport: rect.left < -tolerance || rect.right > window.innerWidth + tolerance,
        } : null;
      })(),
    };
  });

  expect(layout.pageOverflow).toBeLessThanOrEqual(2);
  expect(layout.boardWidth).toBeGreaterThanOrEqual(1260);
  expect(layout.flowWidth).toBeGreaterThanOrEqual(1180);
  expect(layout.minMathFontSize).toBeGreaterThanOrEqual(20);
  expect(layout.stepRects.every((rect) => rect.width > 0 && rect.height >= 104 && rect.height <= 420)).toBe(true);
  expect(layout.finalAnswer?.visible).toBe(true);
  expect(`${layout.finalAnswer?.boxShadow || ""} ${layout.finalAnswer?.background || ""}`).toMatch(/emerald|rgba|linear-gradient/i);
  expect(layout.summaryCard?.width).toBeGreaterThanOrEqual(1000);
  expect(layout.summaryCard?.height).toBeGreaterThan(240);
  expect(layout.summaryCard?.escapesViewport).toBe(false);
  expect(layout.nestedVerticalScrollbars).toEqual([]);
  expect(layout.mathShells.every((shell) => shell.width > 0 && shell.height > 0 && !shell.escapesViewport)).toBe(true);
  expect(layout.hasInternalMathScroll).toBe(true);

  await expect(page.locator(".omni-solution-flow .math-token-defer-subtokens .math-interaction-layer")).toHaveCount(0);
  const substitutionStep = page.locator(".step-card").filter({ hasText: "Substitute parametric variables into the integrand" });
  await expect(substitutionStep).toBeVisible();
  const xCubedToken = substitutionStep.locator("[data-inspectable='math-subtoken'][data-token-latex='x']").first();
  await expect(xCubedToken).toBeVisible();
  const cosineToken = substitutionStep.locator("[data-inspectable='math-subtoken'][data-token-latex='\\\\cos']").first();
  const arctanToken = substitutionStep.locator("[data-inspectable='math-subtoken'][data-token-latex='\\\\arctan']").first();
  await expect(cosineToken).toBeVisible();
  await expect(arctanToken).toBeVisible();
  const tokenTarget = await xCubedToken.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const stepRect = node.closest(".step-card")?.getBoundingClientRect();
    return {
      inspectable: node.getAttribute("data-inspectable"),
      width: rect.width,
      stepWidth: stepRect?.width || 0,
    };
  });
  expect(tokenTarget.inspectable).toBe("math-subtoken");
  expect(tokenTarget.width).toBeGreaterThan(0);
  expect(tokenTarget.width).toBeLessThan(tokenTarget.stepWidth / 3);
  const moveToToken = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    await moveSemanticPointer(page, box.x + box.width / 2, box.y + box.height / 2);
  };

  await moveToToken(xCubedToken);
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
  await moveToToken(cosineToken);
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
  await moveToToken(arctanToken);
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();

  const xBox = await xCubedToken.boundingBox();
  const cosBox = await cosineToken.boundingBox();
  expect(xBox).not.toBeNull();
  expect(cosBox).not.toBeNull();
  await page.mouse.move(xBox.x + xBox.width / 2, xBox.y + xBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cosBox.x + cosBox.width / 2, cosBox.y + cosBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".omni-solution-flow .omni-token-selected")).not.toHaveCount(0);

  const xCubedBoxForPin = await xCubedToken.boundingBox();
  expect(xCubedBoxForPin).not.toBeNull();
  await page.mouse.click(
    xCubedBoxForPin.x + xCubedBoxForPin.width / 2,
    xCubedBoxForPin.y + xCubedBoxForPin.height / 2,
    { button: "right" }
  );
  await expect(page.locator(".omni-floating-window")).toBeVisible();

  const hoverTarget = page.locator("[data-explainable='true']").first();
  await expect(hoverTarget).toBeVisible();
  await hoverTarget.evaluate((node) => node.setAttribute("data-layout-hover-target", "true"));
  await hoverTarget.focus();
  await expect(hoverTarget).toBeFocused();
  await hoverTarget.click();
  for (let attempt = 0; attempt < 4 && await page.locator(".omni-floating-window").count(); attempt += 1) {
    await page.getByRole("button", { name: /Close explanation/i }).first().click({ force: true, timeout: 2000 }).catch(() => {});
  }
  await expect(page.locator(".omni-floating-window")).toHaveCount(0);

  await assertLayoutIntegrity(page);
});

test("spaced evaluation delimiters do not collapse to an arrow-only step", async ({ page }) => {
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createEvaluationDelimiterApiResponse()),
    });
  });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Evaluate the antiderivative at the bounds.");

  const step = page.locator(".step-card", { has: page.getByRole("button", { name: /Evaluate at the bounds/i }) });
  await expect(step).toBeVisible();
  await expect(step.locator(".omni-equation-chain-separator")).toHaveCount(0);
  await expect(step.locator("[data-math-render-error='true']")).toHaveCount(0);
  await expect(step.locator(".katex")).not.toHaveCount(0);
  await expect(step).toContainText(/I/);
  await expect(step).toContainText(/1/);
  await expect(step).not.toContainText("=>");
});

test("bare trig applications keep command boundaries through client annotation and KaTeX", async ({ page }) => {
  const latex = "I = -2 \\int_0^{\\pi/2} (t \\ln(\\sin t) - \\int \\ln(\\sin t) \\, dt) \\tan t \\, dt";
  const token = { id: "bare-trig-token", display: latex, latex, text: latex, role: "equation" };
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Bare trig command rendering",
        problem: "Preserve bare trig command boundaries.",
        originalProblem: "Preserve bare trig command boundaries.",
        expression: "\\int_0^{\\pi/2} \\sin t\\,dt",
        finalAnswer: latex,
        finalAnswerLatex: latex,
        steps: [{
          id: "bare-trig-step",
          label: "Preserve bare trig commands",
          math: latex,
          summary: "Keep each function command separate from its argument.",
          chunks: [token],
          expressions: [{ id: "bare-trig-expression", latex, role: "equation", tokens: [] }],
          lines: [{ id: "bare-trig-line", kind: "math", latex, tokens: [token] }],
        }],
        usage: { kind: "explanation", tier: "test", remaining: 999, limit: 999 },
        saved: false,
        source: "playwright bare trig fixture",
        demoMode: true,
      }),
    });
  });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Preserve bare trig command boundaries.");

  const step = page.locator(".step-card", { has: page.getByRole("button", { name: /Preserve bare trig commands/i }) });
  await expect(step).toBeVisible();
  await expect(step.locator("[data-math-render-error='true']")).toHaveCount(0);
  await expect(step.locator(".katex")).not.toHaveCount(0);
  const renderedLatex = await step.locator("[data-inspectable='math-token']").first().getAttribute("data-token-latex");
  expect(renderedLatex).toContain("\\sin t");
  expect(renderedLatex).toContain("\\tan t");
  expect(renderedLatex).not.toMatch(/\\(?:sint|tant)\b/u);
});

test("semantic hitboxes remain interactive across internal horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  const semanticRequests = [];
  const latex = "L=\\sin a+\\cos b+\\tan c+\\ln(d^2+1)+\\sqrt{e^2+f^2}+\\frac{g^2+h^2}{1+i^2}+\\exp j+\\arctan k+\\cot z";
  const token = { id: "horizontal-scroll-token", display: latex, latex, text: latex, role: "equation" };
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Horizontal semantic scrolling",
        problem: "Inspect a long equation.",
        originalProblem: "Inspect a long equation.",
        expression: latex,
        finalAnswer: latex,
        finalAnswerLatex: latex,
        steps: [{
          id: "horizontal-scroll-step",
          label: "Inspect the long equation",
          math: latex,
          summary: "Every term remains interactive while scrolling.",
          chunks: [token],
          expressions: [{ id: "horizontal-scroll-expression", latex, role: "equation", tokens: [] }],
          lines: [{ id: "horizontal-scroll-line", kind: "math", latex, tokens: [token] }],
        }],
        usage: { kind: "explanation", tier: "test", remaining: 999, limit: 999 },
        saved: false,
        source: "playwright horizontal scroll fixture",
        demoMode: true,
      }),
    });
  });
  for (const endpoint of ["**/api/explain-token", "**/api/explain-pin"]) await page.route(endpoint, async (route) => {
    semanticRequests.push({ endpoint, body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createLazyExplanationResponse()),
    });
  });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect a long equation.");

  const step = page.locator(".step-card", { has: page.getByRole("button", { name: /Inspect the long equation/i }) });
  await expect(step).toBeVisible();
  const scrollContainer = step.locator(".math-render-shell-block").first();
  await expect.poll(() => scrollContainer.evaluate((node) => node.scrollWidth > node.clientWidth + 20)).toBe(true);

  const semanticTokens = step.locator("[data-inspectable='math-subtoken']");
  const leftToken = semanticTokens.first();
  const rightToken = semanticTokens.last();
  await expect(step.locator(".math-semantic-hitbox").first()).toBeAttached({ timeout: 30_000 });
  await expect.poll(() => semanticTokens.count()).toBeGreaterThan(1);
  const initialTargetCount = await step.locator("[data-inspectable='math-subtoken']").count();
  const initialTargetIds = await step.locator("[data-inspectable='math-subtoken']").evaluateAll((nodes) => (
    nodes.map((node) => node.getAttribute("data-token-id"))
  ));
  const initialUniqueTargetIds = [...new Set(initialTargetIds)].sort();
  expect(initialUniqueTargetIds.length).toBeGreaterThan(0);
  const semanticTargetGroups = await step.locator("[data-inspectable='math-subtoken']").evaluateAll((nodes) => {
    const groups = new Map();
    for (const node of nodes) {
      const semanticId = node.getAttribute("data-semantic-id");
      const current = groups.get(semanticId) || {
        semanticId,
        latex: node.getAttribute("data-token-latex"),
        role: node.getAttribute("data-token-role"),
        count: 0,
      };
      current.count += 1;
      groups.set(semanticId, current);
    }
    return [...groups.values()];
  });
  const fragmentedTargets = semanticTargetGroups
    .filter((target) => target.count > 1)
    .map(({ latex: targetLatex, role, count }) => ({ latex: targetLatex, role, count }))
    .sort((left, right) => left.latex.localeCompare(right.latex));
  expect(fragmentedTargets).toEqual([]);
  expect(initialTargetCount).toBe(initialUniqueTargetIds.length);
  expect(semanticTargetGroups.filter((target) => target.latex === "c")).toEqual([
    expect.objectContaining({ role: "argument", count: 1 }),
  ]);
  expect(semanticTargetGroups.filter((target) => target.latex === "i")).toEqual([
    expect.objectContaining({ role: "base", count: 1 }),
  ]);

  const sinFragments = step.locator("[data-inspectable='math-subtoken'][data-token-latex='\\\\sin']");
  await expect(sinFragments).toHaveCount(1);
  const sinSemanticId = await sinFragments.first().getAttribute("data-semantic-id");
  const iSemanticId = semanticTargetGroups.find((target) => target.latex === "i")?.semanticId;
  expect(iSemanticId).toBeTruthy();
  const sinOwner = step.locator(`.katex-html [data-semantic-id="${sinSemanticId}"]`).first();
  await expect(sinOwner.locator(`[data-semantic-id="${iSemanticId}"]`)).toHaveCount(0);
  for (let index = 0; index < await sinFragments.count(); index += 1) {
    const box = await sinFragments.nth(index).boundingBox();
    expect(box).not.toBeNull();
    await moveSemanticPointer(page, box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", sinSemanticId);
  }
  await expect.poll(() => semanticRequests.filter((request) => request.endpoint.endsWith("explain-token")).at(-1)?.body?.semanticId)
    .toBe(sinSemanticId);
  const lastSinBox = await sinFragments.last().boundingBox();
  await contextClickSemanticPointer(page, lastSinBox.x + lastSinBox.width / 2, lastSinBox.y + lastSinBox.height / 2);
  await expect(page.locator(".omni-floating-window")).toHaveAttribute("data-semantic-id", sinSemanticId);
  await expect.poll(() => semanticRequests.filter((request) => request.endpoint.endsWith("explain-pin")).at(-1)?.body?.semanticId)
    .toBe(sinSemanticId);
  await page.getByRole("button", { name: /Close explanation/i }).click();
  await expect(page.locator(".omni-floating-window")).toHaveCount(0);
  const firstSinBox = await sinFragments.first().boundingBox();
  await page.mouse.move(firstSinBox.x + firstSinBox.width / 2, firstSinBox.y + firstSinBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(lastSinBox.x + lastSinBox.width / 2, lastSinBox.y + lastSinBox.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(step.locator("[data-inspectable='math-subtoken'][data-token-latex='\\\\sin'].omni-token-selected")).toHaveCount(1);
  await expect.poll(() => semanticRequests.filter((request) => request.endpoint.endsWith("explain-token")).at(-1)?.body?.semanticSelection?.leafIds || [])
    .toEqual([sinSemanticId]);
  await page.mouse.click(6, 6);
  await page.mouse.move(6, 6);

  const initialContainerBox = await scrollContainer.boundingBox();
  const initialLeftBox = await leftToken.boundingBox();
  const initialRightBox = await rightToken.boundingBox();
  expect(initialContainerBox).not.toBeNull();
  expect(initialLeftBox).not.toBeNull();
  expect(initialRightBox).not.toBeNull();
  expect(initialLeftBox.x).toBeLessThan(initialContainerBox.x + initialContainerBox.width);
  expect(initialRightBox.x).toBeGreaterThan(initialContainerBox.x + initialContainerBox.width);

  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__OMNIMATH_HOVER_PERF__?.reset?.();
    window.__OMNIMATH_SCROLL_COORDINATOR__?.reset?.();
    window.__OMNIMATH_PERF__?.reset?.();
  });

  const maxScrollLeft = await scrollContainer.evaluate((node) => {
    const maximum = node.scrollWidth - node.clientWidth;
    node.scrollLeft = maximum;
    node.dispatchEvent(new Event("scroll"));
    return maximum;
  });
  expect(maxScrollLeft).toBeGreaterThan(20);
  await page.waitForTimeout(100);

  const revealedContainerBox = await scrollContainer.boundingBox();
  const revealedRightBox = await rightToken.boundingBox();
  expect(revealedRightBox.x).toBeGreaterThanOrEqual(revealedContainerBox.x - 2);
  expect(revealedRightBox.x + revealedRightBox.width).toBeLessThanOrEqual(
    revealedContainerBox.x + revealedContainerBox.width + 2,
  );
  const rightAlignment = await rightToken.evaluate((hitbox) => {
    const semanticId = hitbox.getAttribute("data-semantic-id");
    const owner = hitbox.closest("[data-math-chunk-owner]");
    const renderedNode = [...owner.querySelectorAll(`[data-semantic-id="${CSS.escape(semanticId)}"]`)]
      .find((node) => !node.closest(".math-semantic-overlay-layer"));
    const hitboxRect = hitbox.getBoundingClientRect();
    const paintedRects = [];
    if (renderedNode) {
      const walker = document.createTreeWalker(renderedNode, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode) {
        if (textNode.textContent) {
          const range = document.createRange();
          range.selectNodeContents(textNode);
          paintedRects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0));
          range.detach?.();
        }
        textNode = walker.nextNode();
      }
    }
    const domRect = paintedRects.length > 0 ? {
      left: Math.min(...paintedRects.map((rect) => rect.left)),
      right: Math.max(...paintedRects.map((rect) => rect.right)),
      top: Math.min(...paintedRects.map((rect) => rect.top)),
      bottom: Math.max(...paintedRects.map((rect) => rect.bottom)),
      get width() { return this.right - this.left; },
      get height() { return this.bottom - this.top; },
    } : renderedNode?.getBoundingClientRect();
    return domRect ? {
      left: Math.abs(hitboxRect.left - domRect.left),
      top: Math.abs(hitboxRect.top - domRect.top),
      width: Math.abs(hitboxRect.width - domRect.width),
      height: Math.abs(hitboxRect.height - domRect.height),
    } : null;
  });
  expect(rightAlignment).not.toBeNull();
  expect(rightAlignment.left).toBeLessThanOrEqual(2);
  expect(rightAlignment.top).toBeLessThanOrEqual(2);
  expect(rightAlignment.width).toBeLessThanOrEqual(3);
  expect(rightAlignment.height).toBeLessThanOrEqual(3);

  await page.mouse.move(
    revealedRightBox.x + revealedRightBox.width / 2,
    revealedRightBox.y + revealedRightBox.height / 2,
  );
  await expect(rightToken).toHaveAttribute("data-active-target", "true");
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();

  await page.evaluate(() => {
    window.__OMNIMATH_HOVER_PERF__?.reset?.();
    window.__OMNIMATH_SCROLL_COORDINATOR__?.reset?.();
    window.__OMNIMATH_PERF__?.reset?.();
  });

  for (const scrollLeft of [0, maxScrollLeft, 0, maxScrollLeft, 0]) {
    await scrollContainer.evaluate((node, value) => {
      node.scrollLeft = value;
      node.dispatchEvent(new Event("scroll"));
    }, scrollLeft);
    await page.waitForTimeout(50);
    await expect(step.locator("[data-inspectable='math-subtoken']")).toHaveCount(initialTargetCount);
    const ids = await step.locator("[data-inspectable='math-subtoken']").evaluateAll((nodes) => (
      nodes.map((node) => node.getAttribute("data-token-id"))
    ));
    expect([...new Set(ids)].sort()).toEqual(initialUniqueTargetIds);
  }

  const scrollPerf = await page.evaluate(() => ({
    hover: window.__OMNIMATH_HOVER_PERF__?.counters || null,
    app: window.__OMNIMATH_PERF__?.counters || {},
    coordinator: window.__OMNIMATH_SCROLL_COORDINATOR__
      ? {
          physicalScrollCallbacks: window.__OMNIMATH_SCROLL_COORDINATOR__.physicalScrollCallbacks,
          subscriberNotifications: window.__OMNIMATH_SCROLL_COORDINATOR__.subscriberNotifications,
        }
      : null,
  }));
  if (scrollPerf.hover) {
    expect(scrollPerf.hover.geometryTranslation || 0).toBeGreaterThan(0);
    expect(scrollPerf.hover.geometryReconstruction || 0).toBe(0);
    expect(scrollPerf.hover.geometryMeasurement || 0).toBe(0);
    expect(scrollPerf.hover.getClientRectsCalls || 0).toBe(0);
    expect(scrollPerf.hover.querySelectorAllCalls || 0).toBe(0);
    expect(scrollPerf.hover.mathChunkRender || 0).toBe(0);
    expect(scrollPerf.app["semantic-tree.generate"] || 0).toBe(0);
  }
  expect(scrollPerf.coordinator.physicalScrollCallbacks).toBeGreaterThan(0);

  const returnedLeftBox = await leftToken.boundingBox();
  await page.mouse.move(
    returnedLeftBox.x + returnedLeftBox.width / 2,
    returnedLeftBox.y + returnedLeftBox.height / 2,
  );
  await expect(leftToken).toHaveAttribute("data-active-target", "true");
});

test("low-confidence image review can continue with canonical extracted text", async ({ page }) => {
  await installApiFixtures(page);

  let solveRequestBody = null;
  await page.route("**/api/extract-image-problem", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        extractedProblemText: LOW_CONFIDENCE_OCR_TEXT,
        rawExtractedText: LOW_CONFIDENCE_OCR_TEXT,
        rawOcrText: LOW_CONFIDENCE_OCR_TEXT,
        cleanedPlainText: LOW_CONFIDENCE_OCR_TEXT,
        extractedProblemLatex: "\\frac{e^{x^2}}{",
        confidence: 50,
        mathIntegrityScore: 50,
        confidenceTier: "low",
        ocrConfidence: 92,
        issues: [
          {
            type: "low_math_confidence",
            severity: "high",
            critical: true,
            message: "Review required before solving.",
          },
        ],
        extractionValidation: {
          status: "danger",
          tier: "low",
          critical: true,
          confidence: 50,
          mathIntegrityScore: 50,
          ocrConfidence: 92,
          issues: [
            {
              type: "low_math_confidence",
              severity: "high",
              critical: true,
              message: "Review required before solving.",
            },
          ],
        },
        displaySegments: [
          {
            type: "math",
            text: "e^{x^2}",
            latex: "\\frac{e^{x^2}}{",
            renderIssue: "KaTeX parse error",
          },
        ],
        usage: { kind: "image", remaining: 998, limit: 999 },
      }),
    });
  });

  await page.route("**/api/solve-extracted-problem", async (route) => {
    solveRequestBody = route.request().postDataJSON();
    expect(solveRequestBody.problem).toBe(LOW_CONFIDENCE_OCR_TEXT);
    expect(solveRequestBody.problemLatex || "").toBe("");
    expect(solveRequestBody.problem).not.toContain("\\frac{e^{x^2}}{");
    expect(solveRequestBody.extraction.normalizedText).toBe(LOW_CONFIDENCE_OCR_TEXT);
    expect(solveRequestBody.extraction.previewMath?.[0]?.renderIssue).toBe("KaTeX parse error");

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createStokesApiResponse()),
    });
  });

  await page.goto("/?mockAuth=1");
  await page.locator("input[type='file']").setInputFiles({
    name: "readable-math.png",
    mimeType: "image/png",
    buffer: createReadableMathPng(),
  });

  await expect(page.getByRole("button", { name: /Analyze with AI/i })).toBeEnabled();
  await page.getByRole("button", { name: /Analyze with AI/i }).click();

  await expect(page.getByText(/Review the extracted text/i)).toBeVisible();
  await expect(page.getByText(/Math 50% · low/i)).toBeVisible();
  const continueButton = page.getByRole("button", { name: /Continue with reviewed text/i });
  await expect(continueButton).toBeVisible();
  await expect(continueButton).toBeEnabled();

  await continueButton.click();
  await expect(page.getByText(/Explanation ready/i)).toBeVisible();
  expect(solveRequestBody).not.toBeNull();
});

test("typed solve status only becomes ready when rendered solution steps exist", async ({ page }) => {
  const requests = [];
  await page.route("**/api/explain", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const isQuadratic = String(body.problem || "").includes("x^2");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Math Problem",
        expression: body.problem,
        problem: body.problem,
        steps: isQuadratic
          ? [{ id: "q1", label: "Step 1", math: "x=\\frac{-5\\pm\\sqrt{109}}{6}", summary: "Use the quadratic formula." }]
          : [
              { id: "l1", label: "Step 1", math: "3x+45=67", summary: "Start with the equation." },
              { id: "l2", label: "Step 2", math: "x=\\frac{22}{3}", summary: "Solve for x." },
            ],
        finalAnswerLatex: isQuadratic ? "x=\\frac{-5\\pm\\sqrt{109}}{6}" : "x=\\frac{22}{3}",
        usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
      }),
    });
  });

  for (const endpoint of ["**/api/explain-token", "**/api/explain-pin"]) {
    await page.route(endpoint, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createLazyExplanationResponse()),
      });
    });
  }

  await page.goto("/?mockAuth=1");

  const solveAndAssert = async (input, expectedStepText) => {
    await submitCurrentComposer(page, input);
    await expect(page.getByText(/Explanation ready/i)).toBeVisible();
    await expect(page.getByText(expectedStepText)).toBeVisible();
    await expect(page.getByText(/Enter a problem or upload an image/i)).not.toBeVisible();
    await expect(page.getByText(/No solution steps are available yet/i)).not.toBeVisible();
    const renderedStepCount = await page.locator(".omni-solution-flow .step-card").count();
    const statusText = await page.locator("[role='status']").innerText();
    expect(renderedStepCount).toBeGreaterThan(0);
    expect(statusText).toContain(`${renderedStepCount} step${renderedStepCount === 1 ? "" : "s"} generated`);
  };

  await solveAndAssert("3x+45=67", "Start with the equation.");
  await solveAndAssert("3x^2 + 5x - 7 = 0", "Use the quadratic formula.");
  expect(requests.map((request) => request.problem)).toEqual([
    "3x+45=67",
    "3x^2 + 5x - 7 = 0",
  ]);
});
