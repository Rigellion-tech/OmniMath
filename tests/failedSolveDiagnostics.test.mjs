import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  classifySolveCandidate,
  classifySolveFailure,
  compareSafeSolveCandidates,
  decideSolveFailureAction,
  decideSolveEscalation,
  resolveInitialSolveRouting,
  selectBestSafeSolveCandidate,
} from "../server/app.js";
import { analyzeSymbolOrigins } from "../server/symbolInventory.js";

const repoRoot = process.cwd();
const appUrl = pathToFileURL(join(repoRoot, "server", "app.js")).href;
const problem = "x + 35^2 = 0";
const reviewedOcrText = "Evaluate x + 35^2 = 0.";
const regressionIntegralProblem = "Evaluate the integral from 0 to infinity of (ln(1 + x^2) times arctan x) divided by (x times (1 + x^2)) with respect to x.";
const regressionIntegralPlainOcrProblem = "Evaluate the integral from 0 to infinity of the quantity ln(1 + x^2) times arctan x divided by x times (1 + x^2) dx.";
const regressionIntegralLatex = "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx";
const terraDifferentialFixturePath = join(
  repoRoot,
  "tests",
  "fixtures",
  "orchestration",
  "terra-differential-quality-repair.json",
);

async function readTerraDifferentialFixture() {
  return JSON.parse(await readFile(terraDifferentialFixturePath, "utf8"));
}

function createJsonResponseRecorder() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk = "") {
      this.body += chunk;
    },
    json() {
      return JSON.parse(this.body || "{}");
    },
  };
}

function openAiBody(outputText, extra = {}) {
  return {
    id: `resp_${Math.random().toString(36).slice(2)}`,
    status: "completed",
    output_text: outputText,
    model: "test-solver-model",
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
    },
    ...extra,
  };
}

function truncatedOpenAiBody(marker = "truncated", outputTokens = 6500) {
  return openAiBody(undefined, {
    id: `resp_${marker}`,
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [
      { type: "reasoning", id: `reasoning_${marker}`, summary: [] },
      { type: "message", id: `message_${marker}`, role: "assistant", content: [] },
    ],
    usage: {
      input_tokens: 40,
      output_tokens: outputTokens,
      total_tokens: 40 + outputTokens,
      output_tokens_details: { reasoning_tokens: outputTokens },
    },
  });
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function invalidSolveOutput(marker = "initial") {
  return JSON.stringify({
    title: `Invalid ${marker} simple power solve`,
    problemLatex: "x+35^2=0",
    steps: [
      {
        id: `${marker}-start`,
        heading: "Start",
        latex: "x+35^2=0",
        reasoning: `Start from the equation. ${marker}`,
        anchors: [],
      },
      {
        id: `${marker}-final`,
        heading: "Final Answer",
        latex: "x=-35",
        reasoning: "This incorrectly treats 35^2 as 35.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "x=-35",
    numericCheck: "",
  });
}

function validSolveOutput() {
  return JSON.stringify({
    title: "Valid simple power solve",
    problemLatex: "x+35^2=0",
    steps: [
      {
        id: "valid-start",
        heading: "Start",
        latex: "x+35^2=0",
        reasoning: "Start from the equation.",
        anchors: [],
      },
      {
        id: "valid-evaluate",
        heading: "Evaluate the power",
        latex: "x+1225=0",
        reasoning: "Since 35^2=1225, substitute the evaluated power.",
        anchors: [],
      },
      {
        id: "valid-final",
        heading: "Final Answer",
        latex: "x=-1225",
        reasoning: "Subtract 1225 from both sides.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "x=-1225",
    numericCheck: "",
  });
}

function validLinearSolveOutput() {
  return JSON.stringify({
    title: "Solve a linear equation",
    problemLatex: "2x+1=5",
    steps: [
      {
        id: "linear-start",
        heading: "Isolate the variable term",
        latex: "2x=4",
        reasoning: "Subtract 1 from both sides.",
        anchors: [],
      },
      {
        id: "linear-final",
        heading: "Final Answer",
        latex: "x=2",
        reasoning: "Divide both sides by 2.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "x=2",
    numericCheck: "",
  });
}

function invalidIntegrationByPartsIntegralOutput() {
  return JSON.stringify({
    title: "Integral with unsupported integration by parts",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Use the tangent substitution",
        latex: "x=\\tan t,\\quad I=2\\int_0^{\\pi/2}\\frac{t\\ln(\\sec t)}{\\tan t}\\,dt",
        reasoning: "Set x=\\tan t and keep the tangent denominator from x.",
        anchors: [],
      },
      {
        id: "s2",
        heading: "Use integration by parts",
        latex: "u=t,\\quad dv=\\cot t\\ln(\\cos t)\\,dt",
        reasoning: "Declare the integration by parts setup.",
        anchors: [],
      },
      {
        id: "s3",
        heading: "Final answer",
        latex: "\\frac{\\pi}{2}\\ln^2 2",
        reasoning: "Jump to the known value without supplying v.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
    numericCheck: "0.7546938294602481",
  });
}

function validRepairedIntegralOutput() {
  return JSON.stringify({
    title: "Integral repaired without unsupported integration by parts",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Use the tangent substitution",
        latex: "x=\\tan t,\\quad I=2\\int_0^{\\pi/2}\\frac{t\\ln(\\sec t)}{\\tan t}\\,dt",
        reasoning: "The substitution maps the interval to 0\\le t<\\pi/2 and cancels the secant-square factor.",
        anchors: [],
      },
      {
        id: "s2",
        heading: "Final answer",
        latex: "I=\\frac{\\pi}{2}\\ln^2 2",
        reasoning: "A verified evaluation gives the same positive value as the numerical cross-check.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
    numericCheck: "0.7546938294602481",
  });
}

function concisePassingIntegralOutput() {
  return JSON.stringify({
    title: "Integral value",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Final answer",
        latex: "I=\\frac{\\pi}{2}\\ln^2 2",
        reasoning: "A verified evaluation gives the stated positive value.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
    numericCheck: "0.7546938294602481",
  });
}

function fallbackSafePresentationIntegralOutput(marker = "fallback-safe", { compact = false, extraReasoning = "" } = {}) {
  const response = {
    title: `Integral value ${marker}`,
    problemLatex: regressionIntegralLatex,
    steps: [
      {
        id: `${marker}-final`,
        heading: "Final answer",
        latex: "I=\\frac{\\pi}{2}\\ln^2 2",
        reasoning: `A verified evaluation gives the stated positive value. The presentation note \\(G\\) is not used in any equation. ${extraReasoning}`.trim(),
        anchors: [],
      },
    ],
  };
  if (!compact) {
    response.finalAnswerLatex = "\\frac{\\pi}{2}\\ln^2 2";
    response.numericCheck = "0.7546938294602481";
  }
  return JSON.stringify(response);
}

function compactPassingIntegralOutput(marker = "compact-valid") {
  return JSON.stringify({
    title: `Integral value ${marker}`,
    problemLatex: regressionIntegralLatex,
    steps: [
      {
        id: `${marker}-final`,
        heading: "Final answer",
        latex: "I=\\frac{\\pi}{2}\\ln^2 2",
        reasoning: "A verified evaluation gives the stated positive value.",
        anchors: [],
      },
    ],
  });
}

function compactWrongPiCubedIntegralOutput(marker = "compact-wrong") {
  return JSON.stringify({
    title: `Wrong integral value ${marker}`,
    problemLatex: regressionIntegralLatex,
    steps: [
      {
        id: `${marker}-final`,
        heading: "Final answer",
        latex: "I=\\frac{\\pi^3}{12}",
        reasoning: "State a numerically incorrect value.",
        anchors: [],
      },
    ],
  });
}

function compactWrongIntegralWithCommandBoundariesOutput() {
  return JSON.stringify({
    title: "Compact integral with preserved commands",
    problemLatex: regressionIntegralLatex,
    steps: [
      {
        id: "compact-transform",
        heading: "Transform",
        latex: "I=2\\int_0^{\\pi/2}t\\ln(\\sec t)\\cot t\\,dt,\\quad I>0",
        reasoning: "Keep the trigonometric control words separated from their arguments.",
        anchors: [],
      },
      {
        id: "compact-final",
        heading: "Final answer",
        latex: "I=\\frac{\\pi^3}{12}",
        reasoning: "This intentionally incorrect value must trigger mathematical validation.",
        anchors: [],
      },
    ],
  });
}

function fullEqualityPoweredLogIntegralOutput() {
  const finalAnswerLatex = "\\int_{0}^{\\infty}\\frac{\\ln(1+x^{2})\\arctan x}{x(1+x^{2})}\\,dx=\\frac{\\pi}{2}\\ln^{2}(2)";
  return JSON.stringify({
    title: "Integral value",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Final answer",
        latex: finalAnswerLatex,
        reasoning: "State the evaluated integral as an equality.",
        anchors: [],
      },
    ],
    finalAnswerLatex,
    numericCheck: "0.7546938294602481",
  });
}

function negativeIntegralOutput() {
  return JSON.stringify({
    title: "Integral with negative value",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Final answer",
        latex: "I=\\pi\\ln 2-\\pi",
        reasoning: "This gives a negative value for a positive integrand.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "\\pi\\ln 2-\\pi",
    numericCheck: "-0.9640065632861909",
  });
}

function wrongPiCubedIntegralOutput() {
  return JSON.stringify({
    title: "Integral with wrong pi cubed value",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Final answer",
        latex: "I=\\frac{\\pi^3}{12}",
        reasoning: "This is a structurally valid but numerically wrong value.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "\\frac{\\pi^3}{12}",
    numericCheck: "2.5838563900249847",
  });
}

function approximateSeriesMismatchOutput() {
  return JSON.stringify({
    title: "Integral with wrong approximate series value",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Series evaluation",
        latex: "I=\\pi\\sum_{n=1}^{\\infty}\\frac{1}{n(2n+1)^2}\\approx 1.2913",
        reasoning: "Use a proposed series expression and state a decimal approximation.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "\\pi\\sum_{n=1}^{\\infty}\\frac{1}{n(2n+1)^2}\\approx 1.2913",
    numericCheck: "1.2913",
  });
}

function bernoulliCoefficientIntegralOutput() {
  return JSON.stringify({
    title: "Integral with undefined Bernoulli and coefficient notation",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Use the tangent substitution",
        latex: "x=\\tan\\theta, I=-2\\int_0^{\\pi/2}\\theta\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta",
        reasoning: "This introduces the substitution variable before using it.",
        anchors: [],
      },
      {
        id: "s2",
        heading: "Expand both factors",
        latex: "\\ln(\\cos \\theta)=-\\sum_{n=1}^{\\infty}\\frac{(2^{2n}-1)|B_{2n}|}{2n(2n)!}(2\\theta)^{2n},\\quad \\cot\\theta=\\frac{1}{\\theta}-\\sum_{m=1}^{\\infty}\\frac{2^{2m}|B_{2m}|}{(2m)!}\\theta^{2m-1}",
        reasoning: "Use Bernoulli numbers \\(B_{2n}\\) and \\(B_{2m}\\) in the displayed series.",
        anchors: [],
        lines: [
          { latex: "\\ln(\\cos \\theta)=-\\sum_{n=1}^{\\infty}" },
          { latex: "\\frac{(2^{2n}-1)|B_{2n}|}{2n(2n)!}(2\\theta)^{2n}" },
        ],
      },
      {
        id: "s3",
        heading: "Collect coefficients",
        latex: "I=\\sum_{k=1}^{\\infty} C_k\\frac{(\\pi/2)^{2k+1}}{2k+1}",
        reasoning: "The coefficients \\(C_k\\) are not defined in rendered math.",
        anchors: [],
      },
      {
        id: "s4",
        heading: "Final answer",
        latex: "I\\approx 0.754693",
        reasoning: "State the numerical value.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2\\approx 0.754693",
    numericCheck: "0.754693",
  });
}

function tSubstitutionUndefinedCatalanOutput() {
  return JSON.stringify({
    title: "Integral with t substitution and undefined Catalan notation",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Use the substitution \\(t=\\arctan x\\)",
        latex: "t=\\arctan x,\\quad x=\\tan t,\\quad dx=\\sec^2 t\\,dt",
        reasoning: "The rendered substitution defines \\(t\\) before it is used.",
        anchors: [],
      },
      {
        id: "s2",
        heading: "Introduce a constant",
        latex: "I=\\frac{\\pi}{2}\\ln^2 2+G",
        reasoning: "The extra inline symbol \\(G\\) is described only in prose as Catalan's constant.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2+G",
    numericCheck: "",
  });
}

function unexplainedSymbolsIntegralOutput() {
  return JSON.stringify({
    title: "Integral with unexplained generated symbols",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Introduce unbound notation",
        latex: "I=B+\\theta+\\sum_n \\frac{1}{n^2}+\\sum_m \\frac{1}{m^2}",
        reasoning: "This uses symbols without defining or binding them in rendered math.",
        anchors: [],
      },
      {
        id: "s2",
        heading: "Final answer",
        latex: "I=\\frac{\\pi}{2}\\ln^2 2",
        reasoning: "The final value is numerically correct, but earlier notation was not defined.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
    numericCheck: "0.7546938294602481",
  });
}

function structurallyInvalidThetaIntegralOutput() {
  return JSON.stringify({
    title: "Integral with correct value and missing theta introduction",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Use the logarithm series",
        latex: "-\\ln(\\cos\\theta)=\\sum_{n=1}^{\\infty}\\frac{(\\sin\\theta)^{2n}}{2n}",
        reasoning: "The identity is used after a substitution variable should have been introduced.",
        anchors: [],
      },
      {
        id: "s2",
        heading: "Final answer",
        latex: "I=\\frac{\\pi}{2}\\ln^2 2",
        reasoning: "The numerical cross-check agrees with this exact value.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
    numericCheck: "0.7546938294602481",
  });
}

function structurallyRepairedThetaIntegralOutput() {
  return JSON.stringify({
    title: "Integral with theta introduced",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Introduce the substitution variable",
        latex: "x=\\tan\\theta,\\quad -\\ln(\\cos\\theta)=\\sum_{n=1}^{\\infty}\\frac{(\\sin\\theta)^{2n}}{2n}",
        reasoning: "This preserves the existing derivation while defining theta before it is reused.",
        anchors: [],
      },
      {
        id: "s2",
        heading: "Final answer",
        latex: "I=\\frac{\\pi}{2}\\ln^2 2",
        reasoning: "The same final value is preserved.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
    numericCheck: "0.7546938294602481",
  });
}

function intervalSyntaxWrongIntegralOutput() {
  return JSON.stringify({
    title: "Integral with half-open interval notation",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Use tangent substitution",
        latex: "x=\\tan t,\\quad t=\\arctan x,\\quad dx=\\sec^2 t\\,dt,\\quad t \\in [0,\\frac{\\pi}{2})",
        reasoning: "The substitution maps x from zero to infinity onto the half-open interval for t.",
        anchors: [],
      },
      {
        id: "s2",
        heading: "Final answer",
        latex: "I=0",
        reasoning: "This intentionally wrong value should fail numerical validation, not syntax validation.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "0",
    numericCheck: "0",
  });
}

function specialFunctionHallucinationIntegralOutput() {
  return JSON.stringify({
    title: "Integral with unsupported polylogarithm jump",
    problemLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    steps: [
      {
        id: "s1",
        heading: "Introduce a special function",
        latex: "I=\\operatorname{Li}_3\\left(\\frac{1}{2}\\right)+\\frac{\\pi^2}{6}\\ln 2",
        reasoning: "Introduce a polylogarithm expression without deriving it from the integral.",
        anchors: [],
      },
      {
        id: "s2",
        heading: "Final answer",
        latex: "I=2.0466220244727404",
        reasoning: "Use the unsupported special-function value.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "2.0466220244727404",
    numericCheck: "2.0466220244727404",
  });
}

function invalidFinalAnswerStructureFullOutput(marker = "full") {
  return JSON.stringify({
    title: `Invalid final-answer structure ${marker}`,
    problemLatex: "\\int_0^1 x\\,dx",
    steps: [
      {
        id: `${marker}-step`,
        heading: "Evaluate",
        latex: "I=\\frac{1}{2}",
        reasoning: "Evaluate the integral.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "I=\\frac{1}{2}\\Rightarrow y=2",
    numericCheck: "",
  });
}

function invalidMultilineFinalAnswerFullOutput(marker = "full") {
  return JSON.stringify({
    title: `Invalid multiline final-answer structure ${marker}`,
    problemLatex: "\\int_0^1 x\\,dx",
    steps: [
      {
        id: `${marker}-step`,
        heading: "Evaluate",
        latex: "I=\\frac{1}{2}",
        reasoning: "Evaluate the integral.",
        anchors: [],
      },
    ],
    finalAnswerLatex: "I=2\n\\frac{1}{2}",
    numericCheck: "",
  });
}

function invalidFinalAnswerStructureCompactOutput(marker = "compact") {
  return JSON.stringify({
    title: `Invalid compact final-answer structure ${marker}`,
    problemLatex: "\\int_0^1 x\\,dx",
    steps: [
      {
        id: `${marker}-step`,
        heading: "Final Answer",
        latex: "I=\\frac{1}{2}\\Rightarrow y=2",
        reasoning: "State the final answer.",
        anchors: [],
      },
    ],
  });
}

function validCompactHalfOutput(marker = "compact") {
  return JSON.stringify({
    title: `Valid compact answer ${marker}`,
    problemLatex: "\\int_0^1 x\\,dx",
    steps: [
      {
        id: `${marker}-step`,
        heading: "Final Answer",
        latex: "\\frac{1}{2}",
        reasoning: "State only the final value in the compact final step.",
        anchors: [],
      },
    ],
  });
}

function scalarFinalAnswerOutput(finalAnswerLatex, problemLatex = "Evaluate I.") {
  return JSON.stringify({
    title: "Scalar final answer",
    problemLatex,
    steps: [
      {
        id: "s1",
        heading: "Final Answer",
        latex: `I=${finalAnswerLatex}`,
        reasoning: "State the final answer.",
        anchors: [],
      },
    ],
    finalAnswerLatex,
    numericCheck: "",
  });
}

function setValuedAnswerOutput(finalAnswerLatex, problemLatex = "Solve the equation.") {
  return JSON.stringify({
    title: "Set-valued final answer",
    problemLatex,
    steps: [
      {
        id: "s1",
        heading: "Final Answer",
        latex: finalAnswerLatex,
        reasoning: "State all values.",
        anchors: [],
      },
    ],
    finalAnswerLatex,
    numericCheck: "",
  });
}

async function readArtifacts(cwd) {
  const directory = join(cwd, "logs", "failed-solves");
  try {
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map(async (name) => ({
      name,
      path: join(directory, name),
      body: JSON.parse(await readFile(join(directory, name), "utf8")),
    })));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  }
}

async function readUsageStore(cwd) {
  try {
    return JSON.parse(await readFile(join(cwd, ".data", "usage.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function readSolveUsageCounts(cwd) {
  const store = await readUsageStore(cwd);
  const identityKey = "local-dev-solve-extracted-problem";
  const countFor = (metric, identity = identityKey) => {
    const key = Object.keys(store).find((candidate) => (
      candidate.startsWith("usage:daily:")
      && candidate.includes(`:${metric}:`)
      && candidate.endsWith(`:${identity}`)
    ));
    return key ? Number(store[key]?.count || 0) : 0;
  };
  return {
    requests: countFor("requests"),
    tokens: countFor("tokens"),
    globalTokens: countFor("tokens", "global"),
    globalCostMicros: countFor("costMicros", "global"),
  };
}

function assertUsageSettlement(body, {
  providerCalls,
  totalTokens,
  inputTokens = providerCalls * 10,
  outputTokens = providerCalls * 20,
  reason,
}) {
  assert.equal(body.usage?.settlement?.providerCalls, providerCalls);
  assert.equal(body.usage?.settlement?.actualInputTokens, inputTokens);
  assert.equal(body.usage?.settlement?.actualOutputTokens, outputTokens);
  assert.equal(body.usage?.settlement?.actualTotalTokens, totalTokens);
  assert.equal(body.usage?.settlement?.settledTokens, totalTokens);
  assert.equal(body.usage?.settlement?.settlementReason, reason);
  assert.ok(body.usage?.settlement?.releasedTokens >= 0);
}

async function withRuntime({ capture = false, blockDiagnosticDirectory = false } = {}, callback) {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_SOLVER_MODEL: process.env.OPENAI_SOLVER_MODEL,
    OPENAI_ESCALATION_MODEL: process.env.OPENAI_ESCALATION_MODEL,
    OMNIMATH_SOLVER_MODEL: process.env.OMNIMATH_SOLVER_MODEL,
    OMNIMATH_REPAIR_MODEL: process.env.OMNIMATH_REPAIR_MODEL,
    OMNIMATH_ESCALATION_MODEL: process.env.OMNIMATH_ESCALATION_MODEL,
    OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS: process.env.OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS,
    OMNIMATH_CAPTURE_FAILED_SOLVES: process.env.OMNIMATH_CAPTURE_FAILED_SOLVES,
    DATABASE_URL: process.env.DATABASE_URL,
    POSTGRES_URL: process.env.POSTGRES_URL,
    USAGE_LOCAL_STORE_PATH: process.env.USAGE_LOCAL_STORE_PATH,
    USAGE_KV_REST_API_URL: process.env.USAGE_KV_REST_API_URL,
    USAGE_KV_REST_API_TOKEN: process.env.USAGE_KV_REST_API_TOKEN,
    AI_RATE_LIMIT_PER_MINUTE: process.env.AI_RATE_LIMIT_PER_MINUTE,
    AI_RATE_LIMIT_PER_HOUR: process.env.AI_RATE_LIMIT_PER_HOUR,
    DAILY_AI_LIMIT: process.env.DAILY_AI_LIMIT,
    MONTHLY_AI_LIMIT: process.env.MONTHLY_AI_LIMIT,
    DAILY_TOKEN_LIMIT: process.env.DAILY_TOKEN_LIMIT,
    MONTHLY_TOKEN_LIMIT: process.env.MONTHLY_TOKEN_LIMIT,
  };
  const cwd = join(tmpdir(), `omnimath-failed-solves-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(cwd, { recursive: true });
  if (blockDiagnosticDirectory) {
    await mkdir(join(cwd, "logs"), { recursive: true });
    await writeFile(join(cwd, "logs", "failed-solves"), "not a directory", "utf8");
  }

  process.chdir(cwd);
  process.env.NODE_ENV = "test";
  delete process.env.VERCEL;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "test-solver-model";
  process.env.OPENAI_SOLVER_MODEL = "test-solver-model";
  process.env.OPENAI_ESCALATION_MODEL = "test-escalation-model";
  process.env.OMNIMATH_SOLVER_MODEL = "test-solver-model";
  process.env.OMNIMATH_REPAIR_MODEL = "test-solver-model";
  process.env.OMNIMATH_ESCALATION_MODEL = "test-escalation-model";
  process.env.OMNIMATH_CAPTURE_FAILED_SOLVES = capture ? "1" : "";
  process.env.DATABASE_URL = "";
  process.env.POSTGRES_URL = "";
  process.env.USAGE_KV_REST_API_URL = "";
  process.env.USAGE_KV_REST_API_TOKEN = "";
  process.env.USAGE_LOCAL_STORE_PATH = join(cwd, ".data", "usage.json");
  process.env.AI_RATE_LIMIT_PER_MINUTE = "1000";
  process.env.AI_RATE_LIMIT_PER_HOUR = "1000";
  process.env.DAILY_AI_LIMIT = "1000";
  process.env.MONTHLY_AI_LIMIT = "1000";
  process.env.DAILY_TOKEN_LIMIT = "1000000";
  process.env.MONTHLY_TOKEN_LIMIT = "10000000";

  try {
    const imported = await import(`${appUrl}?failed-solves-${Date.now()}-${Math.random()}`);
    return await callback({
      cwd,
      handleExplainRequest: imported.handleExplainRequest,
      handleSolveExtractedProblemRequest: imported.handleSolveExtractedProblemRequest,
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("common mathematical evidence through HTTP solve routes", () => {
  it("typed and reviewed OCR accept the same contradicted candidate without new provider retries", async () => {
    await withRuntime({ capture: false }, async ({ handleExplainRequest, handleSolveExtractedProblemRequest }) => {
      let calls = 0;
      const input = String.raw`\int_0^1 (2*x+1)\,dx`;
      globalThis.fetch = async () => {
        calls++;
        return jsonResponse(openAiBody(JSON.stringify({
          title: "Candidate evidence route test", problemLatex: input,
          steps: [{ id: "s1", heading: "Final answer", latex: "3", reasoning: "Claimed result.", anchors: [] }],
          finalAnswerLatex: "3", numericCheck: "Provider says this is correct.",
        })));
      };
      const typed = await invokeTypedSolve(handleExplainRequest, { problemValue: input, requestId: "trust-typed" });
      const ocr = await invokeSolve(handleSolveExtractedProblemRequest, { problemValue: input, canonicalLatexValue: input, reviewedTextValue: input, requestId: "trust-ocr" });
      for (const response of [typed, ocr]) {
        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.candidateAcceptance.mode, "evidence_only");
        assert.equal(body.candidateAcceptance.accepted, true);
        assert.equal(body.verification.checks.at(-1).state, "contradicted");
        assert.equal(body.verification.checks.at(-1).exactIntegral, "2");
        assert.equal(body.verification.summary.solutionCorrectness, "not_established");
      }
      assert.equal(calls, 2);
      const cached = await invokeTypedSolve(handleExplainRequest, { problemValue: input, requestId: "trust-typed-cache" });
      assert.equal(cached.statusCode, 200);
      assert.equal(cached.json().verification.checks.at(-1).state, "contradicted");
      assert.equal(calls, 2);
    });
  });

  it("typed and reviewed OCR reject the same invalid provider response with the same compact retry policy", async () => {
    await withRuntime({ capture: false }, async ({ handleExplainRequest, handleSolveExtractedProblemRequest }) => {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return jsonResponse(openAiBody("not valid explanation JSON"));
      };
      const input = "Solve x + 2 = 3.";
      const typed = await invokeTypedSolve(handleExplainRequest, {
        problemValue: input,
        requestId: "invalid-parity-typed",
      });
      const ocr = await invokeSolve(handleSolveExtractedProblemRequest, {
        problemValue: input,
        canonicalTextValue: input,
        reviewedTextValue: input,
        requestId: "invalid-parity-ocr",
      });

      assert.equal(typed.statusCode, ocr.statusCode);
      assert.equal(typed.json().code, ocr.json().code);
      assert.equal(typed.json().code, "AI_RESPONSE_INVALID");
      assert.equal(calls, 4);
    });
  });
});

async function invokeTypedSolve(handler, {
  requestId = "typed-routing-test",
  problemValue = "2x+1=5",
} = {}) {
  const req = {
    method: "POST",
    url: "/api/explain",
    headers: {
      "content-type": "application/json",
      host: "localhost:8787",
    },
    socket: { remoteAddress: `127.1.0.${Math.floor(Math.random() * 200) + 1}` },
    body: {
      problem: problemValue,
      canonicalProblem: {
        canonicalText: problemValue,
        canonicalLatex: problemValue,
        source: "typed",
      },
      debugRequestId: requestId,
    },
  };
  const res = createJsonResponseRecorder();
  await handler(req, res);
  return res;
}

async function invokeSolve(handler, {
  requestId = "diag-test-request",
  problemValue = problem,
  reviewedTextValue = reviewedOcrText,
  problemLatexValue = "",
  canonicalTextValue = problemValue,
  canonicalLatexValue = "",
} = {}) {
  const req = {
    method: "POST",
    url: "/api/solve-extracted-problem",
    headers: {
      authorization: "Bearer should-not-be-captured",
      cookie: "session=should-not-be-captured",
      "x-api-key": "should-not-be-captured",
      "content-type": "application/json",
      host: "localhost:8787",
    },
    socket: { remoteAddress: `127.0.0.${Math.floor(Math.random() * 200) + 1}` },
    body: {
      problem: problemValue,
      problemText: reviewedTextValue,
      problemLatex: problemLatexValue,
      canonicalProblem: {
        canonicalText: canonicalTextValue,
        canonicalLatex: canonicalLatexValue,
        source: "ocr-reviewed",
        extractionWarnings: [],
        extractionConfidence: 91,
        hash: "test-hash",
      },
      extraction: {
        normalizedText: problemValue,
        validationText: problemValue,
        extractedProblemLatex: canonicalLatexValue,
        rawExtractedLatex: canonicalLatexValue,
        confidence: 91,
        ocrConfidence: 88,
        mathIntegrityScore: 91,
        confidenceTier: "high",
        issues: [{ type: "test", severity: "low", message: "test issue", critical: false }],
        extractionValidation: {
          confidence: 91,
          ocrConfidence: 88,
          mathIntegrityScore: 91,
          tier: "high",
          issues: [],
        },
      },
      solveDecision: "direct",
      debugRequestId: requestId,
    },
  };
  const res = createJsonResponseRecorder();
  await handler(req, res);
  return res;
}

async function captureOrchestrationTelemetry(callback) {
  const originalInfo = console.info;
  const stages = [];
  const summaries = [];
  console.info = (...args) => {
    if (args[0] === "[omnimath:solve-orchestration-stage]") stages.push(args[1]);
    if (args[0] === "[omnimath:solve-orchestration-summary]") summaries.push(args[1]);
  };
  try {
    const value = await callback();
    return { value, stages, summary: summaries.at(-1) || null };
  } finally {
    console.info = originalInfo;
  }
}

function assertTelemetryIsRedacted(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /input_text|output_text|generatedPrompt|authorization|cookie|should-not-be-captured/u);
  assert.doesNotMatch(serialized, /\\int|arctan|ln\(1\+x\^2\)|Bearer|test-key/u);
}

function assertCompleteStageTelemetry(stage) {
  for (const field of [
    "requestId",
    "solveId",
    "endpoint",
    "modelRole",
    "model",
    "solveMode",
    "generationStage",
    "attemptIndex",
    "httpAttemptCount",
    "responseClassification",
    "candidateProduced",
    "candidateId",
    "candidateProvenance",
    "validationOutcome",
    "compactRetryAttempted",
    "compactRetrySuppressedByPolicy",
    "qualityRepairAttempted",
    "freshEscalationAttempted",
    "fallbackUsed",
    "inputTokens",
    "visibleOutputTokens",
    "reasoningTokens",
    "totalTokens",
    "durationMs",
    "estimatedCostUsd",
  ]) {
    assert.equal(Object.hasOwn(stage, field), true, `missing stage telemetry field ${field}`);
  }
}

function assertCompleteSummaryTelemetry(summary) {
  for (const field of [
    "generationCount",
    "HTTPAttemptCount",
    "initialCompactUsed",
    "repairUsed",
    "repairCompactUsed",
    "escalationUsed",
    "escalationCompactUsed",
    "lateCompactSuppressed",
    "fallbackUsed",
    "finalOutcome",
    "finalFailureClassification",
    "totalInputTokens",
    "totalVisibleOutputTokens",
    "totalReasoningTokens",
    "totalTokens",
    "totalDurationMs",
    "totalEstimatedCostUsd",
  ]) {
    assert.equal(Object.hasOwn(summary, field), true, `missing summary telemetry field ${field}`);
  }
}

describe.skip("legacy validator-driven solve diagnostics", () => {
  it("selects initial model roles deterministically without making a provider call", async () => {
    await withRuntime({ capture: false }, async () => {
      process.env.OMNIMATH_SOLVER_MODEL = "test-luna-model";
      process.env.OMNIMATH_REPAIR_MODEL = "test-terra-model";
      process.env.OMNIMATH_ESCALATION_MODEL = "test-sol-model";
      let providerCalls = 0;
      globalThis.fetch = async () => {
        providerCalls += 1;
        throw new Error("Routing must not call the provider.");
      };

      assert.deepEqual(resolveInitialSolveRouting({ canonicalLatex: "x+1=2" }), {
        routingDecision: "standard",
        routingReason: "default_standard",
        selectedInitialModelRole: "solver",
        selectedInitialModel: "test-luna-model",
        routeSource: "default",
      });
      assert.deepEqual(resolveInitialSolveRouting({ canonicalLatex: "\\int_0^1 x^2\\,dx" }), {
        routingDecision: "standard",
        routingReason: "one_dimensional_integral",
        selectedInitialModelRole: "solver",
        selectedInitialModel: "test-luna-model",
        routeSource: "default",
      });
      assert.deepEqual(resolveInitialSolveRouting({ canonicalLatex: regressionIntegralLatex }), {
        routingDecision: "repair",
        routingReason: "improper_integral",
        selectedInitialModelRole: "repair",
        selectedInitialModel: "test-terra-model",
        routeSource: "difficulty-based",
      });
      assert.deepEqual(resolveInitialSolveRouting({ canonicalLatex: "\\oint_C F\\cdot dr" }), {
        routingDecision: "escalation",
        routingReason: "vector_or_multivariable_calculus",
        selectedInitialModelRole: "escalation",
        selectedInitialModel: "test-sol-model",
        routeSource: "difficulty-based",
      });
      assert.equal(providerCalls, 0);
    });
  });

  it("keeps a typed ordinary algebra solve on the Luna role", async () => {
    await withRuntime({ capture: false }, async ({ handleExplainRequest }) => {
      process.env.OMNIMATH_SOLVER_MODEL = "test-luna-model";
      process.env.OMNIMATH_REPAIR_MODEL = "test-terra-model";
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(openAiBody(validLinearSolveOutput()));
      };

      const response = await invokeTypedSolve(handleExplainRequest);

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, "test-luna-model");
      assert.equal(response.json().usage.settlement.providerCalls, 1);
    });
  });

  it("starts the reviewed improper-integral fixture with Terra and emits redacted routing diagnostics", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      process.env.OMNIMATH_SOLVER_MODEL = "test-luna-model";
      process.env.OMNIMATH_REPAIR_MODEL = "test-terra-model";
      const requests = [];
      const routingLogs = [];
      const stageTelemetry = [];
      const summaryTelemetry = [];
      const originalInfo = console.info;
      console.info = (...args) => {
        if (args[0] === "[omnimath:solve-routing]") routingLogs.push(args[1]);
        if (args[0] === "[omnimath:solve-orchestration-stage]") stageTelemetry.push(args[1]);
        if (args[0] === "[omnimath:solve-orchestration-summary]") summaryTelemetry.push(args[1]);
      };
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(openAiBody(concisePassingIntegralOutput()));
      };

      try {
        const response = await invokeSolve(handleSolveExtractedProblemRequest, {
          requestId: "routing-known-improper-integral",
          problemValue: regressionIntegralProblem,
          reviewedTextValue: regressionIntegralPlainOcrProblem,
          canonicalTextValue: regressionIntegralPlainOcrProblem,
          canonicalLatexValue: regressionIntegralLatex,
        });

        assert.equal(response.statusCode, 200);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].model, "test-terra-model");
        assert.equal(requests.some((request) => request.model === "test-luna-model"), false);
        assert.equal(response.json().usage.settlement.providerCalls, 1);
        assert.deepEqual(routingLogs, [{
          requestId: "routing-known-improper-integral",
          endpoint: "/api/solve-extracted-problem",
          routingDecision: "repair",
          routingReason: "improper_integral",
          selectedInitialModelRole: "repair",
          selectedInitialModel: "test-terra-model",
          routeSource: "difficulty-based",
        }]);
        assert.doesNotMatch(JSON.stringify(routingLogs), /arctan|\\int|ln\(1\+x\^2\)/u);
        assert.equal(stageTelemetry.length, 1);
        assertCompleteStageTelemetry(stageTelemetry[0]);
        assertCompleteSummaryTelemetry(summaryTelemetry[0]);
        assert.deepEqual(stageTelemetry.map((stage) => stage.generationStage), ["initial"]);
        assert.equal(stageTelemetry[0].validationOutcome, "passed");
        assert.equal(stageTelemetry[0].selectedForFinal, true);
        assert.equal(summaryTelemetry[0].generationCount, 1);
        assert.equal(summaryTelemetry[0].HTTPAttemptCount, 1);
        assert.equal(summaryTelemetry[0].finalOutcome, "success");
        assert.equal(summaryTelemetry[0].totalTokens, 30);
        assertTelemetryIsRedacted({ stageTelemetry, summaryTelemetry });
      } finally {
        console.info = originalInfo;
      }
    });
  });

  it("preserves validation and the bounded repair attempt after a Terra-routed initial failure", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      process.env.OMNIMATH_SOLVER_MODEL = "test-luna-model";
      process.env.OMNIMATH_REPAIR_MODEL = "gpt-5.6-terra";
      const requests = [];
      const outputs = [invalidIntegrationByPartsIntegralOutput(), validRepairedIntegralOutput()];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "routing-terra-validation-repair",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const artifacts = await readArtifacts(cwd);
      const initialFailure = artifacts.find((artifact) => artifact.body.metadata.failureStage === "initial");

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 2, "initial plus the existing single repair attempt");
      assert.deepEqual(requests.map((request) => request.model), ["gpt-5.6-terra", "gpt-5.6-terra"]);
      assert.equal(response.json().runtime.source, "live AI repair call");
      assert.equal(response.json().usage.settlement.providerCalls, 2);
      assert.equal(response.json().usage.settlement.reservedTokens >= 16000, true);
      assert.equal(response.json().usage.settlement.actualTotalTokens, 60);
      assert.equal(response.json().usage.settlement.settledTokens, 60);
      assert.equal(response.json().usage.settlement.releasedTokens > 0, true);
      assert.ok(initialFailure.body.validation.solutionIssues.includes("unsupported_integration_by_parts_setup"));
      assert.equal(initialFailure.body.metadata.routingDecision, "repair");
      assert.equal(initialFailure.body.metadata.routingReason, "improper_integral");
      assert.equal(initialFailure.body.metadata.selectedInitialModelRole, "repair");
      assert.equal(initialFailure.body.metadata.selectedInitialModel, "gpt-5.6-terra");
      assert.equal(initialFailure.body.metadata.routeSource, "difficulty-based");
    });
  });

  it("accepts the live d[Li2] differential without hiding arbitrary free d", async () => {
    const fixture = await readTerraDifferentialFixture();
    const candidate = {
      expression: fixture.problem.latex,
      originalProblem: fixture.problem.latex,
      finalAnswerLatex: fixture.initialSolve.finalAnswerLatex,
      steps: fixture.initialSolve.steps.map((step) => ({
        ...step,
        math: step.latex,
        summary: step.reasoning,
      })),
    };

    const analysis = analyzeSymbolOrigins(fixture.problem.latex, candidate);
    const differentialField = analysis.fieldReports.find((field) => (
      field.fieldPath === "steps[1].math"
    ));

    assert.equal(analysis.unexplainedSymbols.includes("d"), false);
    assert.deepEqual(differentialField?.unexplainedSymbols, []);
    assert.equal(differentialField?.value, "d\\!\\left[\\operatorname{Li}_2(\\sin^2 t)\\right]");
  });

  it("accepts the observed Terra candidate without starting a quality repair", async () => {
    const fixture = await readTerraDifferentialFixture();
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      process.env.OMNIMATH_SOLVER_MODEL = "gpt-5.6-luna";
      process.env.OMNIMATH_REPAIR_MODEL = fixture.expected.initialModel;
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (requests.length > 1) throw new Error("The accepted observed candidate must not trigger repair.");
        return jsonResponse(openAiBody(JSON.stringify(fixture.initialSolve), {
          model: fixture.expected.initialModel,
        }));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: `${fixture.caseId}-accepted`,
        problemValue: fixture.problem.text,
        reviewedTextValue: fixture.problem.text,
        canonicalTextValue: fixture.problem.text,
        canonicalLatexValue: fixture.problem.latex,
      });
      const artifacts = await readArtifacts(cwd);

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, fixture.expected.initialModel);
      assert.equal(response.json().usage.settlement.providerCalls, 1);
      assert.equal(artifacts.length, 0);
    });
  });

  it("uses repair-role attempt bounds for quality repair and keeps request timeout non-retryable", async () => {
    const fixture = await readTerraDifferentialFixture();
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      process.env.OMNIMATH_SOLVER_MODEL = "gpt-5.6-luna";
      process.env.OMNIMATH_REPAIR_MODEL = fixture.expected.initialModel;
      process.env.OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS = String(fixture.repairFailure.timeoutMs);
      const requests = [];
      const timeoutLogs = [];
      const exceptionLogs = [];
      const transportErrors = [];
      const originalInfo = console.info;
      const originalError = console.error;
      console.info = (...args) => {
        if (args[0] === "[omnimath:openai-timeout]") timeoutLogs.push(args[1]);
      };
      console.error = (...args) => {
        if (args[0] === "[omnimath:openai-exception]") exceptionLogs.push(args[1]);
        if (args[0]?.openAiTransportDiagnostics) transportErrors.push(args[0]);
      };
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (requests.length === 1) {
          return jsonResponse(openAiBody(JSON.stringify(fixture.repairTriggerSolve), {
            model: fixture.expected.initialModel,
          }));
        }
        throw new DOMException(
          fixture.repairFailure.message,
          fixture.repairFailure.name,
        );
      };

      try {
        const response = await invokeSolve(handleSolveExtractedProblemRequest, {
          requestId: fixture.caseId,
          problemValue: fixture.problem.text,
          reviewedTextValue: fixture.problem.text,
          canonicalTextValue: fixture.problem.text,
          canonicalLatexValue: fixture.problem.latex,
        });
        const artifacts = await readArtifacts(cwd);
        const initialFailure = artifacts.find((artifact) => (
          artifact.body.metadata.failureStage === "initial"
        ));
        const repairTimeout = timeoutLogs.find((entry) => entry.solveMode === fixture.expected.repairSolveMode);
        const repairException = exceptionLogs.find((entry) => entry.solveMode === fixture.expected.repairSolveMode);
        const repairTransport = transportErrors.find((error) => (
          error.openAiTransportDiagnostics?.solveMode === fixture.expected.repairSolveMode
        ))?.openAiTransportDiagnostics;

        assert.equal(response.statusCode, 503);
        assert.equal(requests.length, 2);
        assert.deepEqual(requests.map((request) => request.model), [
          fixture.expected.initialModel,
          fixture.expected.repairModel,
        ]);
        assert.ok(initialFailure.body.validation.solutionIssues.includes(fixture.expected.validationIssue));
        assert.equal(initialFailure.body.validation.solutionIssues.length, 1);
        assert.equal(initialFailure.body.metadata.selectedInitialModelRole, fixture.expected.initialRoutingRole);
        assert.equal(repairTimeout.modelRole, fixture.expected.repairRoutingRole);
        assert.equal(repairTimeout.model, fixture.expected.repairModel);
        assert.equal(repairTimeout.timeoutMs, fixture.repairFailure.timeoutMs);
        assert.equal(repairTimeout.solveMode, fixture.expected.repairSolveMode);
        assert.equal(repairException.failureType, "request_timeout");
        assert.equal(repairException.timeoutScope, fixture.repairFailure.timeoutScope);
        assert.equal(repairException.normalizedErrorCode, fixture.repairFailure.name);
        assert.equal(repairTransport.modelPath, fixture.expected.repairTransportModelPath);
        assert.equal(repairTransport.maxAttempts, fixture.expected.repairTransportMaxAttempts);
        assert.equal(repairTransport.transportAttempts, fixture.expected.transportAttemptsAfterRepairTimeout);
        assert.equal(repairTransport.retryCount, fixture.expected.transportRetriesAfterRepairTimeout);
      } finally {
        console.info = originalInfo;
        console.error = originalError;
      }
    });
  });

  it("does not escalate structural failures before normal repair", () => {
    const decision = decideSolveEscalation({
      message: "Solution failed quality validation.",
      solutionIssues: ["strict_generated_latex", "unexplained_generated_symbol:\\theta"],
      solutionRuleEvaluations: [
        { result: "fail", name: "strict_generated_latex", issue: "strict_generated_latex" },
      ],
    });

    assert.equal(decision.shouldEscalate, false);
    assert.equal(decision.reason, "no_affirmative_mathematical_invalidity");
  });

  it("escalates numerical mismatch validator failures", () => {
    const decision = decideSolveEscalation({
      message: "Solution failed quality validation.",
      solutionIssues: ["numerical_final_answer_mismatch"],
      solutionRuleEvaluations: [
        { result: "fail", name: "numerical_final_answer_mismatch", issue: "numerical_final_answer_mismatch" },
      ],
    });

    assert.equal(decision.shouldEscalate, true);
    assert.equal(decision.reason, "affirmative_mathematical_validator_failure");
    assert.deepEqual(decision.triggeringValidatorIssues, ["numerical_final_answer_mismatch"]);
  });

  it("does not create an artifact when capture is unset", async () => {
    await withRuntime({ capture: false }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      globalThis.fetch = async () => jsonResponse(openAiBody(invalidSolveOutput("uncaptured")));

      const response = await invokeSolve(handleSolveExtractedProblemRequest, { requestId: "diag-disabled" });
      const artifacts = await readArtifacts(cwd);

      assert.equal(response.statusCode, 502);
      assert.equal(artifacts.length, 0);
    });
  });

  it("captures an initial validation failure and keeps diagnostics out of the API response", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [invalidSolveOutput("initial-marker"), validSolveOutput()];
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      const response = await invokeSolve(handleSolveExtractedProblemRequest, { requestId: "diag-initial-success" });
      const responseText = response.body;
      const artifacts = await readArtifacts(cwd);

      assert.equal(response.statusCode, 200);
      assert.equal(artifacts.length, 1);
      assert.deepEqual((await readdir(join(cwd, "logs"))).includes("failed-solves"), true);
      assert.match(artifacts[0].name, /_initial\.json$/);
      assert.equal(artifacts[0].body.metadata.requestId, "diag-initial-success");
      assert.deepEqual(artifacts[0].body.metadata.usageSettlement, {
        providerCalls: 1,
        actualInputTokens: 10,
        actualOutputTokens: 20,
        actualReasoningTokens: 0,
        actualTotalTokens: 30,
        settlementReason: "failure",
      });
      assert.equal(artifacts[0].body.input.canonicalNormalizedSolverInput, problem);
      assert.equal(artifacts[0].body.input.originalReviewedOcrText, reviewedOcrText);
      assert.match(artifacts[0].body.modelResult.rawResponsesOutputText, /initial-marker/);
      assert.equal(artifacts[0].body.modelResult.parsedJsonBeforeSchemaNormalization.finalAnswerLatex, "x=-35");
      assert.equal(artifacts[0].body.modelResult.sanitizedNormalizedSolutionJson.finalAnswerLatex, "x=-35");
      assert.ok(artifacts[0].body.validation.solutionIssues.includes("incorrect_simple_power_equation_final"));
      assert.equal(artifacts[0].body.validation.exactFailedRule, "incorrect_simple_power_equation_final");
      assert.equal(artifacts[0].body.validation.initialValidationPassed, false);
      assert.equal(artifacts[0].body.validation.repairAttempted, true);
      assert.doesNotMatch(responseText, /_omniOpenAiDiagnostics|rawResponsesOutputText|parsedJsonBeforeSchemaNormalization|initial-marker/);
    });
  });

  it("captures a correlated repair artifact when repair validation fails", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [invalidSolveOutput("initial-correlated"), invalidSolveOutput("repair-correlated")];
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      const response = await invokeSolve(handleSolveExtractedProblemRequest, { requestId: "diag-repair-fails" });
      const artifacts = await readArtifacts(cwd);
      const stages = artifacts.map((artifact) => artifact.body.metadata.failureStage).sort();

      assert.equal(response.statusCode, 502);
      assert.deepEqual(stages, ["initial", "repair"]);
      assert.equal(new Set(artifacts.map((artifact) => artifact.body.metadata.requestId)).size, 1);
      assert.equal(artifacts[0].body.metadata.requestId, "diag-repair-fails");
      assert.ok(artifacts.some((artifact) => /repair-correlated/.test(artifact.body.modelResult.rawResponsesOutputText)));
      for (const artifact of artifacts) {
        assert.equal(artifact.body.validation.exactFailedRule, "incorrect_simple_power_equation_final");
        assert.ok(artifact.body.validation.solutionIssues.includes("incorrect_simple_power_equation_final"));
        assert.equal(artifact.body.input.canonicalNormalizedSolverInput, problem);
        assert.equal(artifact.body.modelResult.parsedJsonBeforeSchemaNormalization.finalAnswerLatex, "x=-35");
        assert.equal(artifact.body.modelResult.sanitizedNormalizedSolutionJson.finalAnswerLatex, "x=-35");
      }
    });
  });

  it("repairs the regression integral with targeted integration-by-parts guidance without compact retry", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [invalidIntegrationByPartsIntegralOutput(), validRepairedIntegralOutput()];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-integral-repair",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });
      const body = response.json();
      const artifacts = await readArtifacts(cwd);
      const repairPrompt = requests[1]?.input?.[0]?.content?.[0]?.text || "";

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].text.format.name, "math_fast_solve");
      assert.equal(requests[1].text.format.name, "math_fast_solve");
      assert.ok(requests.every((request) => request.model !== "test-escalation-model"));
      assert.doesNotMatch(JSON.stringify(requests), /math_compact_solve/);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].body.validation.exactFailedRule, "unsupported_integration_by_parts_setup");
      assert.match(repairPrompt, /unsupported_integration_by_parts_setup/);
      assert.match(repairPrompt, /explicitly provide u, dv, du, a correct explicit v/);
      assert.match(repairPrompt, /Verify v by differentiating/);
      assert.match(repairPrompt, /Do not leave v as an unevaluated integral/);
      assert.match(repairPrompt, /abandon that integration-by-parts choice/);
      assert.match(repairPrompt, /u=t/);
      assert.match(repairPrompt, /dv=\\cot t\\ln\(\\cos t\)/);
      assert.equal(body.finalAnswerLatex, "\\frac{\\pi}{2}\\ln^2 2");
      assert.equal(body.runtime.source, "live AI repair call");
    });
  });

  it("captures mathematical validation diagnostics for sign and numerical failures", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [negativeIntegralOutput(), concisePassingIntegralOutput()];
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-math-sign",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });
      const artifacts = await readArtifacts(cwd);

      assert.equal(response.statusCode, 200);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].body.metadata.requestId, "diag-math-sign");
      assert.equal(artifacts[0].body.validation.exactFailedRule, "sign_contradiction_positive_integrand_negative_answer");
      assert.ok(artifacts[0].body.validation.solutionIssues.includes("numerical_final_answer_mismatch"));
      assert.equal(artifacts[0].body.validation.signAnalysisResult.issue, "sign_contradiction_positive_integrand_negative_answer");
      assert.equal(artifacts[0].body.validation.numericalCrossCheckResult.issue, "numerical_final_answer_mismatch");
      assert.equal(artifacts[0].body.validation.firstFailingStepId, null);
      assert.match(artifacts[0].body.validation.issueDetails.map((issue) => issue.failureEvidence || "").join("\n"), /finalValue=/);
      assert.match(artifacts[0].body.modelResult.rawResponsesOutputText, /\\\\pi\\\\ln 2-\\\\pi/);
      assert.doesNotMatch(JSON.stringify(artifacts[0].body), /should-not-be-captured|test-key/);
    });
  });

  it("sends exact numerical mismatch feedback to repair for the regression integral", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [wrongPiCubedIntegralOutput(), concisePassingIntegralOutput()];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-pi-cubed-repair",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });
      const artifacts = await readArtifacts(cwd);
      const repairPrompt = requests[1]?.input?.[0]?.content?.[0]?.text || "";

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].text.format.name, "math_fast_solve");
      assert.equal(requests[1].text.format.name, "math_fast_solve");
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].body.validation.exactFailedRule, "numerical_final_answer_mismatch");
      assert.equal(artifacts[0].body.validation.numericalCrossCheckResult.issue, "numerical_final_answer_mismatch");
      assert.match(repairPrompt, /numerical_final_answer_mismatch/);
      assert.match(repairPrompt, /estimate=/);
      assert.match(repairPrompt, /proposed=/);
      assert.match(repairPrompt, /Rebuild the derivation from the earliest suspect step/);
      assert.match(repairPrompt, /do not change only finalAnswerLatex/);
      assert.match(repairPrompt, /Verify substitutions, derivatives, signs, and special-function simplifications/);
    });
  });

  it("captures explicit numeric approximations after unsupported symbolic prefixes", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [approximateSeriesMismatchOutput(), concisePassingIntegralOutput()];
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-approx-series-mismatch",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralProblem,
        canonicalTextValue: regressionIntegralProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const artifacts = await readArtifacts(cwd);

      assert.equal(response.statusCode, 200);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].body.validation.exactFailedRule, "numerical_final_answer_mismatch");
      assert.equal(artifacts[0].body.validation.finalAnswerLatex, "\\pi\\sum_{n=1}^{\\infty}\\frac{1}{n(2n+1)^2}\\approx 1.2913");
      assert.equal(artifacts[0].body.validation.numericParserStatus, "evaluable");
      assert.equal(artifacts[0].body.validation.extractedNumericApproximation, "1.2913");
      assert.equal(artifacts[0].body.validation.numericalCrossCheckResult.proposedValue, 1.2913);
      assert.ok(artifacts[0].body.validation.summationBindingProvenance.some((binding) => binding.symbol === "n"));
      assert.equal(artifacts[0].body.validation.firstFailedMathematicalRule, "numerical_final_answer_mismatch");
    });
  });

  it("replays the exact improper integral through symbol, numerical, and escalation validation", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        tSubstitutionUndefinedCatalanOutput(),
        approximateSeriesMismatchOutput(),
        concisePassingIntegralOutput(),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-exact-integral-autonomous-loop",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const body = response.json();
      const artifacts = await readArtifacts(cwd);
      const initial = artifacts.find((artifact) => artifact.body.metadata.failureStage === "initial");
      const repair = artifacts.find((artifact) => artifact.body.metadata.failureStage === "repair");
      const repairPrompt = requests[1]?.input?.[0]?.content?.[0]?.text || "";

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 3);
      assert.equal(requests[0].text.format.name, "math_fast_solve");
      assert.equal(requests[1].text.format.name, "math_fast_solve");
      assert.equal(requests[2].text.format.name, "math_fast_solve");
      assert.equal(requests[2].model, "test-escalation-model");
      assert.doesNotMatch(JSON.stringify(requests), /math_compact_solve/);
      assert.equal(body.runtime.source, "live AI escalation call");
      assert.equal(body.finalAnswerLatex, "\\frac{\\pi}{2}\\ln^2 2");
      assert.equal(body.usage.settlement.providerCalls, 3);

      assert.ok(initial);
      assert.ok(initial.body.validation.solutionIssues.includes("unexplained_generated_symbol:G"));
      assert.equal(initial.body.validation.solutionIssues.includes("unexplained_generated_symbol:t"), false);
      assert.equal(initial.body.validation.firstFailedMathematicalRule, null);
      assert.equal(initial.body.validation.symbolOriginDiagnostics.explicitDefinitions.includes("t"), true);
      assert.ok(initial.body.validation.symbolOriginDiagnostics.fieldReports.some((field) => (
        /^steps\[0\]\.(?:heading|label|title)$/u.test(field.fieldPath)
        && field.value === "t=\\arctan x"
        && field.extractionReason === "inline_math_parentheses"
        && field.fragmentStart >= 0
        && field.fragmentEnd > field.fragmentStart
      )));
      assert.ok(initial.body.validation.symbolOriginDiagnostics.fieldReports.some((field) => (
        /^steps\[1\]\.(?:reasoning|summary|plainExplanation)$/u.test(field.fieldPath)
        && field.value === "G"
        && field.unexplainedSymbols.includes("G")
        && field.extractionReason === "inline_math_parentheses"
      )));
      assert.match(repairPrompt, /"symbol":"G"/);
      assert.match(repairPrompt, /"fieldPath":"steps\[1\]\.math"/);
      assert.match(repairPrompt, /"classification":"undefined_free_symbol"/);
      assert.match(repairPrompt, /define it explicitly in rendered LaTeX before first use/);

      assert.ok(repair);
      assert.equal(repair.body.validation.exactFailedRule, "numerical_final_answer_mismatch");
      assert.equal(repair.body.validation.solutionIssues.includes("unexplained_generated_symbol:n"), false);
      assert.equal(repair.body.validation.numericParserStatus, "evaluable");
      assert.equal(repair.body.validation.extractedNumericApproximation, "1.2913");
      assert.equal(repair.body.validation.numericalCrossCheckResult.proposedValue, 1.2913);
      assert.equal(repair.body.validation.firstFailedMathematicalRule, "numerical_final_answer_mismatch");
      assert.ok(repair.body.validation.summationBindingProvenance.some((binding) => binding.symbol === "n"));
      assert.equal(repair.body.validation.repairFeedback.escalation.reason, "affirmative_mathematical_validator_failure");
    });
  });

  it("records undefined Bernoulli and coefficient notation before structural recovery", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        wrongPiCubedIntegralOutput(),
        bernoulliCoefficientIntegralOutput(),
        concisePassingIntegralOutput(),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-exact-integral-bernoulli-coefficients",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const body = response.json();
      const artifacts = await readArtifacts(cwd);
      const repair = artifacts.find((artifact) => artifact.body.metadata.failureStage === "repair");

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 3);
      assert.equal(requests[2].model, "test-escalation-model");
      assert.equal(body.runtime.source, "live AI structural recovery call");
      assert.ok(repair);
      assert.equal(repair.body.validation.repairFeedback.escalation.reason, "structural_recovery_after_failed_repair");
      assert.ok(repair.body.validation.solutionIssues.includes("unexplained_generated_symbol:B"));
      assert.ok(repair.body.validation.solutionIssues.includes("unexplained_generated_symbol:C"));
      assert.equal(repair.body.validation.solutionIssues.includes("unexplained_generated_symbol:n"), false);
      assert.equal(repair.body.validation.solutionIssues.includes("unexplained_generated_symbol:m"), false);
      assert.equal(repair.body.validation.solutionIssues.includes("unexplained_generated_symbol:k"), false);
      assert.equal(repair.body.validation.numericParserStatus, "evaluable");
      assert.equal(repair.body.validation.extractedNumericApproximation, "0.754693");
      assert.equal(repair.body.validation.numericalCrossCheckResult.issue, null);
      assert.ok(repair.body.validation.summationBindingProvenance.some((binding) => (
        binding.command === "sum" && binding.symbol === "n"
      )));
      assert.ok(repair.body.validation.summationBindingProvenance.some((binding) => (
        binding.command === "sum" && binding.symbol === "k"
      )));
      assert.ok(repair.body.validation.symbolOriginDiagnostics.fieldReports.some((field) => (
        field.fieldPath.startsWith("steps[1].")
        && field.symbols.some((item) => item.symbol === "n" && item.classification === "bound_by_step_math_context")
      )));
      assert.ok(repair.body.validation.symbolOriginDiagnostics.fieldReports.some((field) => (
        field.fieldPath.startsWith("steps[2].")
        && field.value.includes("C_k")
        && field.unexplainedSymbols.includes("C")
      )));
    });
  });

  it("does not display a numerically failing pi-cubed repair over a numerically verified initial candidate", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        unexplainedSymbolsIntegralOutput(),
        wrongPiCubedIntegralOutput(),
        concisePassingIntegralOutput(),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-symbol-repair-pi-cubed",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
        canonicalTextValue: regressionIntegralProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const body = response.json();
      const artifacts = await readArtifacts(cwd);
      const initialArtifact = artifacts.find((artifact) => artifact.body.metadata.failureStage === "initial");
      const repairArtifact = artifacts.find((artifact) => artifact.body.metadata.failureStage === "repair");

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 3);
      assert.equal(requests[0].model, "test-solver-model");
      assert.equal(requests[1].model, "test-solver-model");
      assert.equal(requests[2].model, "test-escalation-model");
      assert.equal(body.runtime.source, "live AI escalation call");
      assert.equal(body.finalAnswerLatex, "\\frac{\\pi}{2}\\ln^2 2");
      assert.notEqual(body.finalAnswerLatex, "\\frac{\\pi^3}{12}");

      assert.ok(initialArtifact);
      assert.ok(initialArtifact.body.validation.solutionIssues.includes("unexplained_generated_symbol:\\theta"));
      assert.equal(initialArtifact.body.validation.numericalCrossCheckResult.issue, null);
      assert.equal(initialArtifact.body.validation.numericalCrossCheckResult.proposedValue, 0.7546938294602481);
      assert.equal(initialArtifact.body.validation.numericalCrossCheckResult.confidence, "agreement");

      assert.ok(repairArtifact);
      assert.equal(repairArtifact.body.validation.exactFailedRule, "numerical_final_answer_mismatch");
      assert.equal(repairArtifact.body.validation.numericalCrossCheckResult.issue, "numerical_final_answer_mismatch");
      assert.equal(repairArtifact.body.validation.numericalCrossCheckResult.proposedValue, 2.5838563900249847);
      assert.equal(repairArtifact.body.validation.repairFeedback.escalation.reason, "affirmative_mathematical_validator_failure");
    });
  });

  it("sends unexplained generated symbol binding guidance to repair for the regression integral", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [unexplainedSymbolsIntegralOutput(), concisePassingIntegralOutput()];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-integral-symbol-repair",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
        canonicalTextValue: regressionIntegralProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const artifacts = await readArtifacts(cwd);
      const repairPrompt = requests[1]?.input?.[0]?.content?.[0]?.text || "";

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].text.format.name, "math_fast_solve");
      assert.equal(requests[1].text.format.name, "math_fast_solve");
      assert.equal(artifacts.length, 1);
      assert.ok(artifacts[0].body.validation.solutionIssues.includes("unexplained_generated_symbol:\\theta"));
      assert.ok(artifacts[0].body.validation.solutionIssues.includes("unexplained_generated_symbol:B"));
      assert.ok(artifacts[0].body.validation.solutionIssues.includes("unexplained_generated_symbol:n"));
      assert.ok(artifacts[0].body.validation.solutionIssues.includes("unexplained_generated_symbol:m"));
      assert.match(repairPrompt, /Undefined generated symbols detected:/);
      assert.match(repairPrompt, /- \\theta/);
      assert.match(repairPrompt, /- B/);
      assert.match(repairPrompt, /- n/);
      assert.match(repairPrompt, /- m/);
      assert.match(repairPrompt, /Every substitution variable must be explicitly defined in rendered LaTeX before first use/);
      assert.match(repairPrompt, /Every summation or product index must be bound in the summation\/product notation/);
      assert.match(repairPrompt, /A symbol mentioned only in prose is not considered defined/);
      assert.match(repairPrompt, /Do not introduce additional symbols while repairing the listed ones/);
    });
  });

  it("uses narrow structural repair and preserves the correct improper-integral final answer", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        structurallyInvalidThetaIntegralOutput(),
        structurallyRepairedThetaIntegralOutput(),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-integral-structural-repair-preserves-answer",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
        canonicalTextValue: regressionIntegralProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const body = response.json();
      const artifacts = await readArtifacts(cwd);
      const repairPrompt = requests[1]?.input?.[0]?.content?.[0]?.text || "";

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].text.format.name, "math_fast_solve");
      assert.equal(requests[1].text.format.name, "math_fast_solve");
      assert.equal(body.runtime.source, "live AI repair call");
      assert.equal(body.finalAnswerLatex, "\\frac{\\pi}{2}\\ln^2 2");
      assert.equal(body.numericCheck, "0.7546938294602481");

      assert.equal(artifacts.length, 1);
      assert.ok(artifacts[0].body.validation.solutionIssues.includes("unexplained_generated_symbol:\\theta"));
      assert.equal(artifacts[0].body.validation.solutionIssues.includes("unexplained_generated_symbol:n"), false);
      assert.equal(artifacts[0].body.validation.numericalCrossCheckResult.issue, null);
      assert.equal(artifacts[0].body.validation.numericalCrossCheckResult.proposedValue, 0.7546938294602481);
      assert.equal(artifacts[0].body.validation.repairFeedback.repairCategory, "structural");
      assert.equal(artifacts[0].body.validation.failureClassification, "parsed_candidate_failure");
      assert.equal(artifacts[0].body.validation.qualityRepairAttempted, true);
      assert.equal(artifacts[0].body.validation.freshEscalationAttempted, false);

      assert.match(repairPrompt, /Structural repair task:/);
      assert.match(repairPrompt, /Preserve derivation/);
      assert.match(repairPrompt, /Preserve mathematics/);
      assert.match(repairPrompt, /Preserve final answer/);
      assert.match(repairPrompt, /Only repair symbol introduction/);
      assert.match(repairPrompt, /Do not recompute/);
      assert.match(repairPrompt, /\\frac\{\\pi\}\{2\}\\ln\^2 2/);
      assert.doesNotMatch(repairPrompt, /Reconstruct the solution from scratch/);
      assert.doesNotMatch(repairPrompt, /Assume the previous derivation is mathematically unreliable/);
    });
  });

  it("uses exactly one stronger recovery attempt after failed structural repair", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        structurallyInvalidThetaIntegralOutput(),
        structurallyInvalidThetaIntegralOutput(),
        structurallyRepairedThetaIntegralOutput(),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-structural-recovery",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
        canonicalTextValue: regressionIntegralProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const body = response.json();
      const artifacts = await readArtifacts(cwd);
      const stages = artifacts.map((artifact) => artifact.body.metadata.failureStage).sort();
      const repairArtifact = artifacts.find((artifact) => artifact.body.metadata.failureStage === "repair");

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 3);
      assert.equal(requests[0].model, "test-solver-model");
      assert.equal(requests[1].model, "test-solver-model");
      assert.equal(requests[2].model, "test-escalation-model");
      assert.equal(body.runtime.source, "live AI structural recovery call");
      assert.equal(body.finalAnswerLatex, "\\frac{\\pi}{2}\\ln^2 2");
      assert.deepEqual(stages, ["initial", "repair"]);
      assert.equal(repairArtifact.body.validation.repairFeedback.escalation.reason, "structural_recovery_after_failed_repair");
      assert.ok(repairArtifact.body.validation.repairFeedback.escalation.triggeringValidatorIssues.includes("unexplained_generated_symbol:\\theta"));
    });
  });

  it("throws when the stronger structural recovery result is still invalid", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        structurallyInvalidThetaIntegralOutput(),
        structurallyInvalidThetaIntegralOutput(),
        structurallyInvalidThetaIntegralOutput(),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-structural-recovery-fails",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
        canonicalTextValue: regressionIntegralProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const body = response.json();
      const artifacts = await readArtifacts(cwd);
      const stages = artifacts.map((artifact) => artifact.body.metadata.failureStage).sort();

      assert.equal(response.statusCode, 502);
      assert.equal(body.code, "AI_SOLUTION_QUALITY_INVALID");
      assert.equal(requests.length, 3);
      assert.equal(requests[2].model, "test-escalation-model");
      assert.deepEqual(stages, ["escalation", "initial", "repair"]);
      assert.ok(body.solutionIssues.includes("unexplained_generated_symbol:\\theta"));
    });
  });

  it("does not reject half-open interval notation as latex syntax before numerical validation", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        intervalSyntaxWrongIntegralOutput(),
        intervalSyntaxWrongIntegralOutput(),
        intervalSyntaxWrongIntegralOutput(),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-interval-syntax-numerical-failure",
        problemValue: regressionIntegralPlainOcrProblem,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const body = response.json();
      const artifacts = await readArtifacts(cwd);
      const serializedArtifacts = JSON.stringify(artifacts);

      assert.equal(response.statusCode, 502);
      assert.equal(requests.length, 3);
      assert.equal(body.code, "AI_SOLUTION_QUALITY_INVALID");
      assert.ok(body.solutionIssues.includes("numerical_final_answer_mismatch"));
      assert.equal(body.solutionIssues.some((issue) => issue.includes("invalid_latex")), false);
      assert.doesNotMatch(serializedArtifacts, /latex_syntax|unmatched_delimiters/);
      assert.match(serializedArtifacts, /numerical_final_answer_mismatch/);
      assert.match(serializedArtifacts, /t \\\\in \[0,\\\\frac\{\\\\pi\}\{2\}\)/);
    });
  });

  it("uses canonical LaTeX for exact OCR integral validation while keeping readable text in the prompt", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(concisePassingIntegralOutput()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-canonical-latex-success",
        problemValue: regressionIntegralPlainOcrProblem,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const body = response.json();
      const promptText = requests[0]?.input?.[0]?.content?.[0]?.text || "";

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 1);
      assert.match(promptText, /Human-readable problem:/);
      assert.match(promptText, new RegExp(regressionIntegralPlainOcrProblem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(promptText, /Canonical mathematical form:/);
      assert.match(promptText, /\\int_0\^\\infty/);
      assert.equal(body.finalAnswerLatex, "\\frac{\\pi}{2}\\ln^2 2");
      assert.equal(body.imageSource.finalProblemText, regressionIntegralPlainOcrProblem);
      assert.equal(body.imageSource.finalProblemLatex, regressionIntegralLatex);
    });
  });

  it("rejects pi cubed for exact OCR integral when canonical LaTeX is present", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        wrongPiCubedIntegralOutput(),
        wrongPiCubedIntegralOutput(),
        wrongPiCubedIntegralOutput(),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-canonical-latex-rejects-pi-cubed",
        problemValue: regressionIntegralPlainOcrProblem,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const body = response.json();
      const artifacts = await readArtifacts(cwd);
      const stages = artifacts.map((artifact) => artifact.body.metadata.failureStage).sort();

      assert.equal(response.statusCode, 502);
      assert.equal(requests.length, 3);
      assert.equal(requests[0].model, "test-solver-model");
      assert.equal(requests[1].model, "test-solver-model");
      assert.equal(requests[2].model, "test-escalation-model");
      for (const request of requests) {
        const promptText = request.input?.[0]?.content?.[0]?.text || "";
        assert.match(promptText, /\\int_0\^\\infty/);
      }
      assert.ok(body.solutionIssues.includes("numerical_final_answer_mismatch"));
      assert.deepEqual(stages, ["escalation", "initial", "repair"]);
      for (const artifact of artifacts) {
        assert.equal(artifact.body.input.canonicalText, regressionIntegralPlainOcrProblem);
        assert.equal(artifact.body.input.canonicalLatex, regressionIntegralLatex);
        assert.equal(artifact.body.input.canonicalMathInput, regressionIntegralLatex);
        assert.equal(artifact.body.input.canonicalMathInputSource, "canonicalLatex");
        assert.equal(artifact.body.input.canonicalDisplayText, regressionIntegralPlainOcrProblem);
        assert.equal(artifact.body.input.canonicalDisplaySource, "canonicalText");
        assert.equal(artifact.body.validation.numericalCrossCheckResult.issue, "numerical_final_answer_mismatch");
      }
    });
  });

  it("accepts canonical LaTeX-only OCR solve payloads", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(concisePassingIntegralOutput()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-canonical-latex-only",
        problemValue: "",
        reviewedTextValue: "",
        canonicalTextValue: "",
        canonicalLatexValue: regressionIntegralLatex,
      });
      const promptText = requests[0]?.input?.[0]?.content?.[0]?.text || "";

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 1);
      assert.doesNotMatch(promptText, /Human-readable problem:/);
      assert.match(promptText, /\\int_0\^\\infty/);
    });
  });

  it("accepts full equality powered-log final answers without repair", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(fullEqualityPoweredLogIntegralOutput()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-powered-log-final-answer",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
        problemLatexValue: regressionIntegralLatex,
        canonicalTextValue: regressionIntegralProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const body = response.json();

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, "test-solver-model");
      assert.equal(body.runtime.source, "live AI call");
      assert.match(body.finalAnswerLatex, /\\frac\{\\pi\}\{2\}\\ln\^\{2\}\(2\)$/);
    });
  });

  it("escalates after repair repeats a numerical final-answer mismatch", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        wrongPiCubedIntegralOutput(),
        wrongPiCubedIntegralOutput(),
        concisePassingIntegralOutput(),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-escalate-numeric",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });
      const body = response.json();
      const artifacts = await readArtifacts(cwd);

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 3);
      assert.equal(requests[0].model, "test-solver-model");
      assert.equal(requests[1].model, "test-solver-model");
      assert.equal(requests[2].model, "test-escalation-model");
      assert.equal(requests[2].text.format.name, "math_fast_solve");
      assert.equal(body.runtime.source, "live AI escalation call");
      assert.equal(body.finalAnswerLatex, "\\frac{\\pi}{2}\\ln^2 2");
      assert.equal(artifacts.find((artifact) => artifact.body.metadata.failureStage === "repair").body.validation.repairFeedback.escalation.reason, "affirmative_mathematical_validator_failure");
    });
  });

  it("escalates after repair repeats unsupported integration by parts", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      const outputs = [
        invalidIntegrationByPartsIntegralOutput(),
        invalidIntegrationByPartsIntegralOutput(),
        concisePassingIntegralOutput(),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-escalate-ibp",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 3);
      assert.equal(requests[2].model, "test-escalation-model");
      assert.equal(response.json().runtime.source, "live AI escalation call");
    });
  });

  it("escalates after repair repeats abrupt special-function introduction", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      const outputs = [
        specialFunctionHallucinationIntegralOutput(),
        specialFunctionHallucinationIntegralOutput(),
        concisePassingIntegralOutput(),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-escalate-special-function",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralLatex,
      });

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 3);
      assert.equal(requests[2].model, "test-escalation-model");
      assert.equal(response.json().runtime.source, "live AI escalation call");
    });
  });

  it("persists repair feedback and repeated-method diagnostics", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        invalidIntegrationByPartsIntegralOutput(),
        invalidIntegrationByPartsIntegralOutput(),
        invalidIntegrationByPartsIntegralOutput(),
      ];
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-repeated-method",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });
      const artifacts = await readArtifacts(cwd);
      const initial = artifacts.find((artifact) => artifact.body.metadata.failureStage === "initial");
      const repair = artifacts.find((artifact) => artifact.body.metadata.failureStage === "repair");
      const escalation = artifacts.find((artifact) => artifact.body.metadata.failureStage === "escalation");

      assert.equal(response.statusCode, 502);
      assert.ok(initial);
      assert.ok(repair);
      assert.ok(escalation);
      assert.equal(initial.body.metadata.requestId, "diag-repeated-method");
      assert.equal(repair.body.metadata.requestId, "diag-repeated-method");
      assert.equal(escalation.body.metadata.requestId, "diag-repeated-method");
      assert.equal(initial.body.metadata.operationId, "/api/solve-extracted-problem:diag-repeated-method");
      assert.equal(initial.body.metadata.solveId, "diag-repeated-method");
      assert.equal(initial.body.metadata.candidateId, "diag-repeated-method:1");
      assert.equal(repair.body.metadata.candidateId, "diag-repeated-method:2");
      assert.equal(escalation.body.metadata.candidateId, "diag-repeated-method:3");
      assert.equal(initial.body.metadata.solveStage, "initial");
      assert.equal(repair.body.metadata.solveStage, "repair");
      assert.equal(escalation.body.metadata.solveStage, "escalation");
      assert.ok(initial.body.metadata.originatingProblemHash);
      assert.equal(repair.body.metadata.originatingProblemHash, initial.body.metadata.originatingProblemHash);
      assert.equal(escalation.body.metadata.originatingProblemHash, initial.body.metadata.originatingProblemHash);
      assert.equal(initial.body.validation.exactFailedRule, "unsupported_integration_by_parts_setup");
      assert.equal(repair.body.validation.exactFailedRule, "unsupported_integration_by_parts_setup");
      assert.equal(escalation.body.validation.exactFailedRule, "unsupported_integration_by_parts_setup");
      assert.equal(repair.body.metadata.usageSettlement.providerCalls, 2);
      assert.equal(repair.body.metadata.usageSettlement.actualTotalTokens, 60);
      assert.equal(escalation.body.metadata.usageSettlement.providerCalls, 3);
      assert.equal(escalation.body.metadata.usageSettlement.actualTotalTokens, 90);
      assert.ok(initial.body.validation.repairFeedback);
      assert.ok(initial.body.validation.issueCodes.includes("unsupported_integration_by_parts_setup"));
      assert.match(initial.body.validation.requestedCorrectionStrategy, /explicitly provide u, dv, du/);
      assert.ok(repair.body.validation.previousMethodFingerprint);
      assert.ok(repair.body.validation.currentMethodFingerprint);
      assert.equal(repair.body.validation.repeatedMethodDetected, true);
      assert.equal(repair.body.validation.repairFeedback.escalation.attempted, true);
      assert.equal(repair.body.validation.repairFeedback.escalation.model, "test-escalation-model");
      assert.equal(escalation.body.validation.repairFeedback.escalation.success, false);
      assert.equal(initial.body.validation.failureKind, "unsupported_reasoning");
      assert.match(initial.body.validation.firstDecisiveFailedMathematicalClaim, /integration by parts/i);
      assert.doesNotMatch(JSON.stringify(repair.body), /should-not-be-captured|test-key/);
    });
  });

  it("captures exhausted generated-response contract failures without mathematical repair", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        invalidFinalAnswerStructureFullOutput("initial-full"),
        invalidFinalAnswerStructureCompactOutput("initial-compact"),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-generated-contract",
        problemValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
        reviewedTextValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
      });
      const artifacts = await readArtifacts(cwd);
      const stages = artifacts.map((artifact) => artifact.body.metadata.failureStage).sort();
      const serializedResponse = response.body;

      assert.equal(response.statusCode, 502);
      assert.equal(response.json().message, "Generated solution has invalid final-answer structure.");
      assert.doesNotMatch(serializedResponse, /invalid LaTeX/);
      assert.deepEqual(stages, ["initial-compact", "initial-full"]);
      assert.equal(requests.length, 2);
      assert.ok(requests.every((request) => request.model !== "test-escalation-model"));
      assert.equal(requests[1].text.format.name, "math_compact_solve");

      for (const artifact of artifacts) {
        assert.equal(artifact.body.metadata.requestId, "diag-generated-contract");
        assert.equal(artifact.body.metadata.responseFailureType, "field_structure");
        assert.equal(artifact.body.metadata.errorCode, "AI_RESPONSE_INVALID");
        assert.equal(artifact.body.metadata.compactRetryable, true);
        assert.equal(artifact.body.validation.responseFailureType, "field_structure");
        assert.equal(artifact.body.validation.failureClassification, "response_generation_failure");
        assert.equal(artifact.body.validation.qualityRepairAttempted, false);
        assert.equal(artifact.body.validation.freshEscalationAttempted, false);
        assert.ok(artifact.body.validation.solutionIssues.includes("invalid_latex:finalAnswerLatex:final_answer_contains_derivation_arrow"));
        assert.equal(artifact.body.validation.latexValidationIssues[0].fieldPath, "finalAnswerLatex");
        assert.match(artifact.body.modelResult.rawResponsesOutputText, /Rightarrow/);
        assert.equal(artifact.body.modelResult.parsedJsonBeforeSchemaNormalization.problemLatex, "\\int_0^1 x\\,dx");
        assert.equal(artifact.body.modelResult.schemaSanitizedJson, null);
        assert.equal(artifact.body.modelResult.sanitizedNormalizedSolutionJson, null);
      }
    });
  });

  it("continues normally when malformed full JSON recovers to a valid compact candidate", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        '{"title":}',
        validCompactHalfOutput("json-recovered"),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "json-compact-recovers",
        problemValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
        reviewedTextValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
      });
      const artifacts = await readArtifacts(cwd);

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().finalAnswerLatex, "\\frac{1}{2}");
      assert.equal(requests.length, 2);
      assert.equal(requests[1].text.format.name, "math_compact_solve");
      assert.doesNotMatch(JSON.stringify(requests), /repairing a rejected solution/u);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].body.validation.failureClassification, "response_generation_failure");
      assert.equal(artifacts[0].body.validation.qualityRepairAttempted, false);
    });
  });

  it("hard-fails exhausted reviewed response-generation failures without quality repair", async () => {
    const cases = [
      {
        label: "json",
        outputs: ['{"title":}', '{"title":}'],
        expectedCode: "AI_RESPONSE_INVALID",
        expectedCalls: 2,
      },
      {
        label: "schema",
        outputs: [JSON.stringify({ title: "Missing fields" }), JSON.stringify({ title: "Still missing" })],
        expectedCode: "AI_RESPONSE_INVALID",
        expectedCalls: 2,
      },
      {
        label: "missing-text",
        outputs: [null, null],
        expectedCode: "AI_RESPONSE_INVALID",
        expectedCalls: 2,
      },
      {
        label: "truncation",
        outputs: ["truncated", "truncated"],
        expectedCode: "AI_RESPONSE_TRUNCATED",
        expectedCalls: 2,
      },
      {
        label: "refusal",
        outputs: ["refusal"],
        expectedCode: "AI_REQUEST_REFUSED",
        expectedCalls: 1,
      },
    ];

    for (const testCase of cases) {
      await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
        const outputs = [...testCase.outputs];
        const requests = [];
        globalThis.fetch = async (_url, options) => {
          requests.push(JSON.parse(options.body));
          const output = outputs.shift();
          if (output === "truncated") return jsonResponse(truncatedOpenAiBody(`${testCase.label}-${requests.length}`));
          if (output === "refusal") {
            return jsonResponse(openAiBody(undefined, {
              output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "refusal", refusal: "The request was declined." }],
              }],
            }));
          }
          if (output === null) return jsonResponse(openAiBody(undefined, { output: [] }));
          return jsonResponse(openAiBody(output));
        };

        const response = await invokeSolve(handleSolveExtractedProblemRequest, {
          requestId: `response-generation-${testCase.label}`,
          problemValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
          reviewedTextValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
        });

        assert.equal(response.statusCode, 502, testCase.label);
        assert.equal(response.json().code, testCase.expectedCode, testCase.label);
        assert.equal(requests.length, testCase.expectedCalls, testCase.label);
        assert.doesNotMatch(JSON.stringify(requests), /repairing a rejected solution/u, testCase.label);
        assert.equal(requests.some((request) => request.model === "test-escalation-model"), false, testCase.label);
      });
    }
  });

  it("recovers truncation through compact output without entering quality repair", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      const outputs = [truncatedOpenAiBody("compact-recovers"), openAiBody(validCompactHalfOutput("truncation-recovered"))];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(outputs.shift());
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "truncation-compact-recovers",
        problemValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
        reviewedTextValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().finalAnswerLatex, "\\frac{1}{2}");
      assert.equal(requests.length, 2);
      assert.equal(requests[1].text.format.name, "math_compact_solve");
      assert.doesNotMatch(JSON.stringify(requests), /repairing a rejected solution/u);
    });
  });

  it("preserves typed-solve hard failure after exhausted response-format recovery", async () => {
    await withRuntime({ capture: false }, async ({ handleExplainRequest }) => {
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(openAiBody('{"title":}'));
      };

      const response = await invokeTypedSolve(handleExplainRequest, {
        requestId: "typed-response-generation-failure",
        problemValue: "Solve 2x+1=5.",
      });

      assert.equal(response.statusCode, 502);
      assert.equal(response.json().code, "AI_RESPONSE_INVALID");
      assert.equal(requests.length, 2);
      assert.doesNotMatch(JSON.stringify(requests), /repairing a rejected solution/u);
    });
  });

  it("reproduces multiline finalAnswerLatex as field_structure with issue-aware compact retry and artifacts", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        invalidMultilineFinalAnswerFullOutput("initial-full"),
        invalidFinalAnswerStructureCompactOutput("initial-compact"),
        invalidFinalAnswerStructureFullOutput("repair-full"),
        invalidFinalAnswerStructureCompactOutput("repair-compact"),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-multiline-repro",
        problemValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
        reviewedTextValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
      });
      const artifacts = await readArtifacts(cwd);
      const initialFull = artifacts.find((artifact) => artifact.body.metadata.failureStage === "initial-full");
      const retryPrompt = requests[1]?.input?.[0]?.content?.[0]?.text || "";

      assert.equal(response.statusCode, 502);
      assert.ok(initialFull);
      assert.equal(initialFull.body.metadata.responseFailureType, "field_structure");
      assert.ok(initialFull.body.validation.solutionIssues.includes("invalid_latex:finalAnswerLatex:final_answer_contains_multiple_physical_lines"));
      assert.match(initialFull.body.modelResult.rawResponsesOutputText, /I=2\\n/);
      assert.match(retryPrompt, /final-answer field contract/i);
      assert.match(retryPrompt, /final_answer_contains_multiple_physical_lines/);
      assert.match(retryPrompt, /Do not include line breaks/);
      assert.equal(artifacts.some((artifact) => artifact.body.metadata.failureStage === "initial-compact"), true);
    });
  });

  it("settles exact usage for a successful one-call solve", async () => {
    await withRuntime({ capture: false }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      globalThis.fetch = async () => jsonResponse(openAiBody(concisePassingIntegralOutput()));

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "usage-one-call",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });
      const body = response.json();
      const counts = await readSolveUsageCounts(cwd);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(counts, {
        requests: 1,
        tokens: 30,
        globalTokens: 30,
        globalCostMicros: 651,
      });
      assertUsageSettlement(body, { providerCalls: 1, totalTokens: 30, reason: "success" });
    });
  });

  it("accepts short, set-valued, and derivative final answers through the route", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      const cases = [
        {
          requestId: "route-short-one",
          problemValue: "Determine I from I=1.",
          reviewedTextValue: "Determine I from I=1.",
          output: scalarFinalAnswerOutput("1", "1"),
          expected: "1",
        },
        {
          requestId: "route-short-negative-two",
          problemValue: "Determine I from I=-2.",
          reviewedTextValue: "Determine I from I=-2.",
          output: scalarFinalAnswerOutput("-2", "-2"),
          expected: "-2",
        },
        {
          requestId: "route-set-valued",
          problemValue: "Solve x^2-5x+6=0.",
          reviewedTextValue: "Solve x^2-5x+6=0.",
          output: setValuedAnswerOutput("x=2,3", "x^2-5x+6=0"),
          expected: "x=2,3",
        },
        {
          requestId: "route-derivative",
          problemValue: "Compute the requested rate expression for x^2 with respect to x.",
          reviewedTextValue: "Compute the requested rate expression for x^2 with respect to x.",
          output: setValuedAnswerOutput("\\frac{d}{dx}(x^2)=2x", "\\frac{d}{dx}(x^2)"),
          expected: "\\frac{d}{dx}(x^2)=2x",
        },
      ];
      const outputs = cases.map((item) => item.output);
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      for (const item of cases) {
        const response = await invokeSolve(handleSolveExtractedProblemRequest, {
          requestId: item.requestId,
          problemValue: item.problemValue,
          reviewedTextValue: item.reviewedTextValue,
        });
        const body = response.json();

        assert.equal(response.statusCode, 200, `${item.requestId}: ${response.body}`);
        assert.equal(body.finalAnswerLatex, item.expected);
        assert.equal(body.solutionIssues, undefined);
      }
    });
  });

  it("settles exact usage for a full response plus compact success", async () => {
    await withRuntime({ capture: false }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        invalidFinalAnswerStructureFullOutput("usage-full"),
        validCompactHalfOutput("usage-compact"),
      ];
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      const telemetry = await captureOrchestrationTelemetry(() => invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "usage-compact-success",
        problemValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
        reviewedTextValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
      }));
      const response = telemetry.value;
      const body = response.json();
      const counts = await readSolveUsageCounts(cwd);

      assert.equal(response.statusCode, 200);
      assert.equal(body.finalAnswerLatex, "\\frac{1}{2}");
      assert.deepEqual(counts, {
        requests: 2,
        tokens: 60,
        globalTokens: 60,
        globalCostMicros: 1301,
      });
      assertUsageSettlement(body, { providerCalls: 2, totalTokens: 60, reason: "success" });
      assert.deepEqual(telemetry.stages.map((stage) => stage.generationStage), ["initial", "initial_compact"]);
      assert.equal(telemetry.stages[0].responseClassification, "response_generation_failure");
      assert.equal(telemetry.stages[0].compactRetryAttempted, true);
      assert.equal(telemetry.stages[1].validationOutcome, "passed");
      assert.equal(telemetry.stages[1].selectedForFinal, true);
      assert.equal(telemetry.summary.initialCompactUsed, true);
      assert.equal(telemetry.summary.generationCount, 2);
      assert.equal(telemetry.summary.totalTokens, 60);
      assertTelemetryIsRedacted({ stages: telemetry.stages, summary: telemetry.summary });
    });
  });

  it("settles exact usage for mathematical failure followed by successful repair", async () => {
    await withRuntime({ capture: false }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [wrongPiCubedIntegralOutput(), concisePassingIntegralOutput()];
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      const telemetry = await captureOrchestrationTelemetry(() => invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "usage-repair-success",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      }));
      const response = telemetry.value;
      const body = response.json();
      const counts = await readSolveUsageCounts(cwd);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(counts, {
        requests: 2,
        tokens: 60,
        globalTokens: 60,
        globalCostMicros: 1301,
      });
      assertUsageSettlement(body, { providerCalls: 2, totalTokens: 60, reason: "success" });
      assert.deepEqual(telemetry.stages.map((stage) => stage.generationStage), ["initial", "quality_repair"]);
      assert.equal(telemetry.stages[0].validationOutcome, "failed");
      assert.equal(telemetry.stages[0].transitionTo, "quality_repair");
      assert.equal(telemetry.stages[0].transitionFailureClassification.category, "parsed_candidate_failure");
      assert.equal(telemetry.stages[1].qualityRepairAttempted, true);
      assert.equal(telemetry.stages[1].validationOutcome, "passed");
      assert.equal(telemetry.summary.repairUsed, true);
      assert.equal(telemetry.summary.finalGenerationStage, "quality_repair");
    });
  });

  it("settles actual provider usage when repair also fails quality validation", async () => {
    await withRuntime({ capture: false }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [wrongPiCubedIntegralOutput(), wrongPiCubedIntegralOutput(), wrongPiCubedIntegralOutput()];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(openAiBody(outputs.shift()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "usage-repair-fails",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });
      const body = response.json();
      const counts = await readSolveUsageCounts(cwd);

      assert.equal(response.statusCode, 502);
      assert.equal(requests.length, 3);
      assert.equal(requests[2].model, "test-escalation-model");
      assert.equal(body.code, "AI_SOLUTION_QUALITY_INVALID");
      assert.ok(body.solutionIssues.includes("numerical_final_answer_mismatch"));
      assert.equal(body.retryable, true);
      assert.equal(body.retryType, "reviewed_problem");
      assert.match(body.validationSummary, /numerical check/i);
      assert.equal(body.solutionRuleEvaluations, undefined);
      assert.equal(body.solutionValidationContext, undefined);
      assert.equal(body.omniDebugContext, undefined);
      assert.equal(body.stack, undefined);
      assert.deepEqual(counts, {
        requests: 3,
        tokens: 90,
        globalTokens: 90,
        globalCostMicros: 1951,
      });
      assertUsageSettlement(body, { providerCalls: 3, totalTokens: 90, reason: "failure" });
    });
  });

  it("settles exact usage for a two-provider-call generated-response failure", async () => {
    await withRuntime({ capture: false }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        invalidFinalAnswerStructureFullOutput("usage-initial-full"),
        invalidFinalAnswerStructureCompactOutput("usage-initial-compact"),
      ];
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      const telemetry = await captureOrchestrationTelemetry(() => invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "usage-four-call-failure",
        problemValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
        reviewedTextValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
      }));
      const response = telemetry.value;
      const body = response.json();
      const counts = await readSolveUsageCounts(cwd);

      assert.equal(response.statusCode, 502);
      assert.equal(body.code, "AI_RESPONSE_INVALID");
      assert.deepEqual(counts, {
        requests: 2,
        tokens: 60,
        globalTokens: 60,
        globalCostMicros: 1301,
      });
      assertUsageSettlement(body, { providerCalls: 2, totalTokens: 60, reason: "failure" });
      assert.deepEqual(telemetry.stages.map((stage) => stage.generationStage), ["initial", "initial_compact"]);
      assert.ok(telemetry.stages.every((stage) => stage.responseClassification === "response_generation_failure"));
      assert.equal(telemetry.summary.finalOutcome, "hard_failure");
      assert.equal(telemetry.summary.finalFailureClassification.category, "response_generation_failure");
      assert.equal(telemetry.summary.fallbackUsed, false);
      assert.equal(telemetry.summary.totalTokens, 60);
    });
  });

  it("counts a provider transport failure as a request without inventing token usage", async () => {
    await withRuntime({ capture: false }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          async text() {
            return JSON.stringify({ error: { type: "invalid_request_error", code: "bad_request", message: "bad request" } });
          },
        };
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "usage-provider-transport",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });
      const body = response.json();
      const counts = await readSolveUsageCounts(cwd);

      assert.equal(response.statusCode, 502);
      assert.equal(body.code, "AI_SERVICE_ERROR");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, "test-solver-model");
      assert.deepEqual(counts, {
        requests: 1,
        tokens: 0,
        globalTokens: 0,
        globalCostMicros: 0,
      });
      assertUsageSettlement(body, {
        providerCalls: 1,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reason: "failure",
      });
    });
  });

  it("does not count duplicate in-flight solves as additional provider calls", async () => {
    await withRuntime({ capture: false }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      let fetchCalls = 0;
      let releaseFetch;
      const fetchGate = new Promise((resolve) => {
        releaseFetch = resolve;
      });
      globalThis.fetch = async () => {
        fetchCalls += 1;
        await fetchGate;
        return jsonResponse(openAiBody(concisePassingIntegralOutput()));
      };

      const first = invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "usage-duplicate-a",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });
      const second = invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "usage-duplicate-b",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseFetch();
      const responses = await Promise.all([first, second]);
      const counts = await readSolveUsageCounts(cwd);

      assert.equal(fetchCalls, 1);
      assert.equal(responses[0].statusCode, 200);
      assert.equal(responses[1].statusCode, 200);
      assert.deepEqual(counts, {
        requests: 1,
        tokens: 30,
        globalTokens: 30,
        globalCostMicros: 651,
      });
    });
  });

  it("does not mask generated-response contract failures when artifact writing fails", async () => {
    await withRuntime({ capture: true, blockDiagnosticDirectory: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        invalidFinalAnswerStructureFullOutput("write-failure-full"),
        invalidFinalAnswerStructureCompactOutput("write-failure-compact"),
      ];
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "diag-generated-write-fails",
        problemValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
        reviewedTextValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
      });
      const artifacts = await readArtifacts(cwd);
      const body = response.json();
      const counts = await readSolveUsageCounts(cwd);

      assert.equal(response.statusCode, 502);
      assert.equal(body.code, "AI_RESPONSE_INVALID");
      assert.equal(body.message, "Generated solution has invalid final-answer structure.");
      assert.equal(artifacts.length, 0);
      assert.deepEqual(counts, {
        requests: 2,
        tokens: 60,
        globalTokens: 60,
        globalCostMicros: 1301,
      });
    });
  });

  it("does not alter the normal 502 response when diagnostic writing fails", async () => {
    await withRuntime({ capture: true, blockDiagnosticDirectory: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      globalThis.fetch = async () => jsonResponse(openAiBody(invalidSolveOutput("write-failure")));

      const response = await invokeSolve(handleSolveExtractedProblemRequest, { requestId: "diag-write-fails" });
      const artifacts = await readArtifacts(cwd);
      const body = response.json();

      assert.equal(response.statusCode, 502);
      assert.equal(body.code, "AI_SOLUTION_QUALITY_INVALID");
      assert.equal(body.message, "Solution failed quality validation.");
      assert.deepEqual(body.solutionIssues, ["incorrect_simple_power_equation_final"]);
      assert.equal(body.retryable, true);
      assert.equal(body.solutionRuleEvaluations, undefined);
      assert.equal(body.solutionValidationContext, undefined);
      assert.equal(artifacts.length, 0);
    });
  });

  it("returns a valid repair compact candidate without escalating", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      const responses = [
        openAiBody(wrongPiCubedIntegralOutput()),
        truncatedOpenAiBody("repair-full-valid-compact"),
        openAiBody(compactPassingIntegralOutput()),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(responses.shift());
      };

      const telemetry = await captureOrchestrationTelemetry(() => invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "fallback-valid-repair-compact",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      }));
      const response = telemetry.value;
      const body = response.json();

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 3);
      assert.equal(requests[2].text.format.name, "math_compact_solve");
      assert.ok(requests.every((request) => request.model !== "test-escalation-model"));
      assert.equal(body.runtime.source, "live AI repair call");
      assert.equal(body.runtime.degradedFallback, undefined);
      assert.equal(body.finalAnswerLatex, "I=\\frac{\\pi}{2}\\ln^2 2");
      assert.deepEqual(telemetry.stages.map((stage) => stage.generationStage), [
        "initial",
        "quality_repair",
        "quality_repair_compact",
      ]);
      assert.equal(telemetry.stages[1].compactRetryAttempted, true);
      assert.equal(telemetry.stages[2].validationOutcome, "passed");
      assert.equal(telemetry.stages[2].selectedForFinal, true);
      assert.equal(telemetry.summary.repairCompactUsed, true);
      assert.equal(telemetry.summary.finalGenerationStage, "quality_repair_compact");
    });
  });

  it("escalates when a repair compact candidate has an affirmative mathematical failure", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      const responses = [
        openAiBody(wrongPiCubedIntegralOutput("initial")),
        truncatedOpenAiBody("repair-full-math-failure"),
        openAiBody(compactWrongPiCubedIntegralOutput()),
        openAiBody(concisePassingIntegralOutput()),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(responses.shift());
      };

      const telemetry = await captureOrchestrationTelemetry(() => invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "fallback-repair-compact-math-failure",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      }));
      const response = telemetry.value;

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 4);
      assert.equal(requests[3].model, "test-escalation-model");
      assert.equal(response.json().runtime.source, "live AI escalation call");
      assert.deepEqual(telemetry.stages.map((stage) => stage.generationStage), [
        "initial",
        "quality_repair",
        "quality_repair_compact",
        "fresh_escalation",
      ]);
      assert.equal(telemetry.stages[2].validationOutcome, "failed");
      assert.equal(telemetry.stages[2].transitionFailureClassification.category, "parsed_candidate_failure");
      assert.equal(telemetry.stages[3].freshEscalationAttempted, true);
      assert.equal(telemetry.stages[3].validationOutcome, "passed");
      assert.equal(telemetry.summary.escalationUsed, true);
      assert.equal(telemetry.summary.finalGenerationStage, "fresh_escalation");
    });
  });

  it("preserves the exact integral and TeX boundaries through repair compact and fresh escalation", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      process.env.OMNIMATH_REPAIR_MODEL = "gpt-5.6-terra";
      const responses = [
        openAiBody(wrongPiCubedIntegralOutput("initial-clean")),
        truncatedOpenAiBody("repair-full-clean"),
        openAiBody(compactWrongIntegralWithCommandBoundariesOutput()),
        openAiBody(concisePassingIntegralOutput()),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(responses.shift());
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "integral-boundary-regression",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 4, "no incidental local-rule candidate or extra provider retry");
      assert.equal(requests[0].model, "gpt-5.6-terra");
      assert.equal(requests[2].reasoning?.effort, "medium");
      assert.equal(requests[3].model, "test-escalation-model");
      for (const request of requests) {
        const promptText = request.input?.[0]?.content?.find((item) => item.type === "input_text")?.text || "";
        assert.doesNotMatch(promptText, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u);
        assert.doesNotMatch(promptText, /\\(?:cost|cott|quadI)\b/u);
      }
      const escalationPrompt = requests[3].input[0].content[0].text;
      assert.match(escalationPrompt, /\\int_0\^\\infty \\frac\{\\ln\(1\+x\^2\)\\arctan x\}\{x\(1\+x\^2\)\}\\,dx/u);
      assert.match(escalationPrompt, /Solve the canonical original problem from scratch/u);
      assert.equal(response.json().runtime.source, "live AI escalation call");
    });
  });

  it("reports only genuine mathematical defects when every exact-integral candidate is invalid", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      process.env.OMNIMATH_REPAIR_MODEL = "gpt-5.6-terra";
      const responses = [
        openAiBody(specialFunctionHallucinationIntegralOutput()),
        truncatedOpenAiBody("repair-full-current-failure"),
        openAiBody(compactWrongPiCubedIntegralOutput("repair-compact-current-failure")),
        openAiBody(intervalSyntaxWrongIntegralOutput()),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(responses.shift());
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "integral-current-math-failure",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const artifacts = await readArtifacts(cwd);
      const qualityArtifacts = artifacts.filter((artifact) => artifact.body.validation.solutionIssues.length > 0);

      assert.equal(response.statusCode, 502);
      assert.equal(response.json().code, "AI_SOLUTION_QUALITY_INVALID");
      assert.equal(requests.length, 4);
      assert.equal(requests[2].reasoning?.effort, "medium");
      assert.equal(requests[3].model, "test-escalation-model");
      assert.match(requests[3].input[0].content[0].text, /Solve the canonical original problem from scratch/u);
      assert.match(requests[3].input[0].content[0].text, /Independently verify the final result numerically/u);
      for (const request of requests) {
        const promptText = request.input?.[0]?.content?.find((item) => item.type === "input_text")?.text || "";
        assert.doesNotMatch(promptText, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u);
        assert.doesNotMatch(promptText, /\\(?:cost|cott|quadI)\b/u);
      }
      assert.ok(qualityArtifacts.some((artifact) => artifact.body.validation.solutionIssues.includes("abrupt_special_function_introduction:polylogarithm")));
      assert.ok(qualityArtifacts.filter((artifact) => artifact.body.validation.solutionIssues.includes("numerical_final_answer_mismatch")).length >= 2);
      assert.ok(qualityArtifacts.every((artifact) => artifact.body.validation.failureKind === "unsupported_reasoning" || artifact.body.validation.failureKind === "numeric_inconsistency"));
      assert.ok(qualityArtifacts.every((artifact) => !artifact.body.validation.solutionIssues.includes("strict_generated_latex")));
      const escalation = qualityArtifacts.find((artifact) => artifact.body.metadata.solveStage === "escalation");
      assert.equal(escalation.body.validation.failureKind, "numeric_inconsistency");
      assert.match(escalation.body.validation.firstDecisiveFailedMathematicalClaim, /estimate=.*proposed=0/u);
    });
  });

  it("returns a structurally safe repair compact fallback after escalation truncates", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      const responses = [
        openAiBody(wrongPiCubedIntegralOutput()),
        truncatedOpenAiBody("repair-full-safe"),
        openAiBody(fallbackSafePresentationIntegralOutput("repair-compact-safe", { compact: true })),
        truncatedOpenAiBody("escalation-full-safe"),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(responses.shift());
      };

      const telemetry = await captureOrchestrationTelemetry(() => invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "fallback-repair-compact-safe",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      }));
      const response = telemetry.value;
      const body = response.json();

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 4);
      assert.equal(body.runtime.degradedFallback, true);
      assert.equal(body.runtime.degradedFallbackSource, "repair-compact");
      assert.equal(body.runtime.failedLaterStage, "escalation");
      assert.equal(body.runtime.source, "live AI repair-compact degraded fallback");
      assert.equal(body.usage.settlement.providerCalls, 4);
      assert.equal(body.finalAnswerLatex, "I=\\frac{\\pi}{2}\\ln^2 2");
      assert.equal(telemetry.stages.find((stage) => stage.generationStage === "quality_repair_compact").fallbackUsed, true);
      assert.equal(telemetry.stages.find((stage) => stage.generationStage === "quality_repair_compact").selectedForFinal, true);
      assert.equal(telemetry.summary.fallbackUsed, true);
      assert.equal(telemetry.summary.finalOutcome, "fallback");
      assert.equal(telemetry.summary.finalGenerationStage, "quality_repair_compact");
    });
  });

  it("does not return a numerically mismatched repair compact candidate after escalation truncates", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      const responses = [
        openAiBody(wrongPiCubedIntegralOutput()),
        truncatedOpenAiBody("repair-full-numeric"),
        openAiBody(compactWrongPiCubedIntegralOutput()),
        truncatedOpenAiBody("escalation-full-numeric"),
        truncatedOpenAiBody("escalation-compact-numeric"),
      ];
      globalThis.fetch = async () => jsonResponse(responses.shift());

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "fallback-reject-numeric",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const body = response.json();

      assert.equal(response.statusCode, 502);
      assert.equal(body.code, "AI_RESPONSE_TRUNCATED");
      assert.equal(body.runtime, undefined);
    });
  });

  it("suppresses escalation compact after repair consumes the shared late retry", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      process.env.OMNIMATH_REPAIR_MODEL = "gpt-5.6-terra";
      process.env.OMNIMATH_ESCALATION_MODEL = "gpt-5.6-sol";
      const responses = [
        openAiBody(wrongPiCubedIntegralOutput("initial-wrong")),
        truncatedOpenAiBody("repair-full-truncated"),
        openAiBody(compactWrongPiCubedIntegralOutput("repair-compact-wrong")),
        truncatedOpenAiBody("escalation-full-truncated"),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(responses.shift());
      };

      const telemetry = await captureOrchestrationTelemetry(() => invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "bounded-five-stage-math-failure",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      }));
      const response = telemetry.value;
      const body = response.json();

      assert.equal(requests.length, 4);
      assert.equal(requests[0].model, "gpt-5.6-terra");
      assert.equal(requests[1].model, "gpt-5.6-terra");
      assert.equal(requests[2].model, "gpt-5.6-terra");
      assert.equal(requests[2].reasoning?.effort, "medium");
      assert.equal(requests[3].model, "gpt-5.6-sol");
      assert.match(requests[2].input[0].content[0].text, /numerical_final_answer_mismatch/u);
      assert.equal(response.statusCode, 502);
      assert.equal(body.code, "AI_RESPONSE_TRUNCATED");
      assert.equal(body.runtime, undefined);
      assert.equal(responses.length, 0);
      assert.deepEqual(telemetry.stages.map((stage) => stage.generationStage), [
        "initial",
        "quality_repair",
        "quality_repair_compact",
        "fresh_escalation",
      ]);
      assert.equal(telemetry.stages[3].compactRetrySuppressedByPolicy, true);
      assert.equal(telemetry.summary.lateCompactSuppressed, true);
      assert.equal(telemetry.summary.escalationCompactUsed, false);
      assert.equal(telemetry.summary.finalOutcome, "hard_failure");
    });
  });

  it("shares one late compact retry and caps the old six-generation reviewed path at five", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const responses = [
        truncatedOpenAiBody("initial-full-six"),
        openAiBody(compactWrongPiCubedIntegralOutput("initial-compact-six")),
        truncatedOpenAiBody("repair-full-six"),
        openAiBody(compactWrongPiCubedIntegralOutput("repair-compact-six")),
        truncatedOpenAiBody("escalation-full-six"),
      ];
      const maximumRequests = responses.length;
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (requests.length > maximumRequests) {
          throw new Error("The shared late compact allowance must prevent a sixth generation.");
        }
        return jsonResponse(responses.shift());
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "bounded-six-generation-candidate-path",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });

      const artifacts = await readArtifacts(cwd);
      const escalationFull = artifacts.find((artifact) => artifact.body.metadata.failureStage === "escalation-full");

      assert.equal(response.statusCode, 502);
      assert.equal(response.json().code, "AI_RESPONSE_TRUNCATED");
      assert.equal(requests.length, 5);
      assert.deepEqual(requests.map((request) => request.text.format.name), [
        "math_fast_solve",
        "math_compact_solve",
        "math_fast_solve",
        "math_compact_solve",
        "math_fast_solve",
      ]);
      assert.equal(requests[4].model, "test-escalation-model");
      assert.ok(escalationFull);
      assert.equal(escalationFull.body.validation.compactRetryAttempted, false);
    });
  });

  it("keeps the late compact allowance for escalation when repair returns a full parsed failure", async () => {
    await withRuntime({ capture: false }, async ({ handleSolveExtractedProblemRequest }) => {
      const responses = [
        openAiBody(wrongPiCubedIntegralOutput("initial-full-wrong")),
        openAiBody(wrongPiCubedIntegralOutput("repair-full-wrong")),
        truncatedOpenAiBody("escalation-full-truncated"),
        openAiBody(compactPassingIntegralOutput("escalation-compact-passing")),
      ];
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(responses.shift());
      };

      const telemetry = await captureOrchestrationTelemetry(() => invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "late-compact-reserved-for-escalation",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      }));
      const response = telemetry.value;

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().finalAnswerLatex, "I=\\frac{\\pi}{2}\\ln^2 2");
      assert.equal(requests.length, 4);
      assert.deepEqual(requests.map((request) => request.text.format.name), [
        "math_fast_solve",
        "math_fast_solve",
        "math_fast_solve",
        "math_compact_solve",
      ]);
      assert.equal(requests[2].model, "test-escalation-model");
      assert.equal(requests[3].model, "test-escalation-model");
      assert.deepEqual(telemetry.stages.map((stage) => stage.generationStage), [
        "initial",
        "quality_repair",
        "fresh_escalation",
        "fresh_escalation_compact",
      ]);
      assert.equal(telemetry.stages[2].responseClassification, "response_generation_failure");
      assert.equal(telemetry.stages[3].validationOutcome, "passed");
      assert.equal(telemetry.summary.escalationCompactUsed, true);
      assert.equal(telemetry.summary.lateCompactSuppressed, false);
      assert.equal(telemetry.summary.finalGenerationStage, "fresh_escalation_compact");
    });
  });

  it("accepts a fallback-safe initial presentation candidate without quality repair", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (requests.length > 1) throw new Error("Presentation-only acceptance must not call quality repair.");
        return jsonResponse(openAiBody(fallbackSafePresentationIntegralOutput("initial-safe")));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "presentation-degraded-one-call",
        problemValue: regressionIntegralLatex,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });
      const body = response.json();
      const artifacts = await readArtifacts(cwd);

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 1);
      assert.equal(body.runtime.source, "live AI initial presentation-degraded");
      assert.equal(body.runtime.presentationDegraded, true);
      assert.equal(body.runtime.presentationDegradedSource, "initial");
      assert.deepEqual(body.runtime.presentationDegradedIssueCodes, ["unexplained_generated_symbol:G"]);
      assert.equal(body.runtime.degradedFallback, undefined);
      assert.equal(body.usage.settlement.providerCalls, 1);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].body.metadata.failureStage, "initial");
      assert.equal(artifacts[0].body.validation.repairAttempted, false);
      assert.equal(artifacts[0].body.validation.failureClassification, "parsed_candidate_failure");
      assert.equal(artifacts[0].body.validation.qualityRepairAttempted, false);
      assert.equal(artifacts[0].body.validation.freshEscalationAttempted, false);
      assert.deepEqual(artifacts[0].body.validation.solutionIssues, ["unexplained_generated_symbol:G"]);
    });
  });

  it("ranks candidate mathematical safety ahead of cosmetics, completeness, and stage order", () => {
    const safeEarlier = {
      source: "initial",
      fallbackEligible: true,
      affirmativeMathematicalFailure: false,
      numericalMismatch: false,
      numericalAgreement: true,
      issueClassifications: [
        { code: "presentation:a", severity: "presentation" },
        { code: "presentation:b", severity: "presentation" },
      ],
      completeness: { score: 2 },
    };
    const unsafeLater = {
      source: "escalation-compact",
      fallbackEligible: true,
      affirmativeMathematicalFailure: true,
      numericalMismatch: false,
      numericalAgreement: true,
      issueClassifications: [],
      completeness: { score: 10 },
    };

    assert.ok(compareSafeSolveCandidates(safeEarlier, unsafeLater) < 0);
    assert.equal(selectBestSafeSolveCandidate([unsafeLater, safeEarlier]), safeEarlier);
  });

  it("classifies only the existing fallback-safe presentation floor as immediate degraded acceptance", () => {
    const result = {
      finalAnswerLatex: "I=1",
      steps: [{ math: "I=1", summary: "A concise explanation." }],
    };
    const symbolEvaluation = ({ symbol, fieldPath, sourceType }) => ({
      result: "fail",
      name: "unexplained_generated_symbol",
      issue: `unexplained_generated_symbol:${symbol}`,
      inputFields: [fieldPath],
      failureEvidence: JSON.stringify({
        symbol,
        fieldPath,
        sourceType,
        classification: "undefined_free_symbol",
      }),
    });
    const actionFor = (error, accepted = false) => decideSolveFailureAction({
      source: "initial",
      result,
      error,
      parseSchemaSuccess: true,
      accepted,
    }).action;

    assert.equal(actionFor(null, true), "accept", "clean candidates remain normal accepts");

    const onePresentationIssue = {
      solutionIssues: ["unexplained_generated_symbol:G"],
      solutionRuleEvaluations: [symbolEvaluation({
        symbol: "G",
        fieldPath: "steps[0].reasoning",
        sourceType: "reasoning",
      })],
    };
    assert.equal(
      actionFor(onePresentationIssue),
      "accept_presentation_degraded",
      "a reasoning-only unexplained symbol uses the existing presentation floor",
    );

    const multiplePresentationIssues = {
      solutionIssues: ["unexplained_generated_symbol:G", "unexplained_generated_symbol:H"],
      solutionRuleEvaluations: [
        symbolEvaluation({ symbol: "G", fieldPath: "steps[0].heading", sourceType: "heading" }),
        symbolEvaluation({ symbol: "H", fieldPath: "steps[0].reasoning", sourceType: "reasoning" }),
      ],
    };
    assert.equal(actionFor(multiplePresentationIssues), "accept_presentation_degraded");

    assert.equal(actionFor({
      ...onePresentationIssue,
      solutionIssues: [
        ...onePresentationIssue.solutionIssues,
        "numerical_final_answer_mismatch",
      ],
    }), "targeted_mathematical_repair", "mixed presentation and math findings still repair");

    assert.equal(actionFor({
      solutionIssues: ["unexplained_generated_symbol:G"],
      solutionRuleEvaluations: [symbolEvaluation({
        symbol: "G",
        fieldPath: "steps[0].math",
        sourceType: "math",
      })],
    }), "targeted_structural_repair", "equation symbols remain below the fallback floor");

    assert.equal(actionFor({
      solutionIssues: ["unexplained_generated_symbol:G"],
      solutionRuleEvaluations: [symbolEvaluation({
        symbol: "G",
        fieldPath: "finalAnswerLatex",
        sourceType: "finalAnswer",
      })],
    }), "targeted_mathematical_repair", "final-answer symbols remain mathematical");

    assert.equal(actionFor({
      solutionIssues: ["numerical_final_answer_mismatch"],
    }), "targeted_mathematical_repair", "numerical disagreement still repairs");

    assert.equal(actionFor({
      solutionIssues: ["strict_generated_latex"],
    }), "targeted_structural_repair", "malformed LaTeX still repairs");
  });

  it("separates response-generation failures from parsed-candidate failures by code and candidate provenance", () => {
    const candidate = {
      finalAnswerLatex: "x=2",
      steps: [{ math: "x=2", summary: "Solve the equation." }],
    };

    for (const code of ["AI_RESPONSE_INVALID", "AI_RESPONSE_TRUNCATED", "AI_REQUEST_REFUSED"]) {
      assert.deepEqual(classifySolveFailure({ error: { code }, candidate: null }), {
        category: "response_generation_failure",
        errorCode: code,
        responseFailureType: null,
        hasParsedCandidate: false,
      });
      assert.equal(
        classifySolveFailure({ error: { code }, candidate }).category,
        "response_generation_failure",
        `${code} remains a provider-result failure even if stale endpoint state exists`,
      );
    }

    assert.equal(classifySolveFailure({
      error: { code: "AI_SOLUTION_QUALITY_INVALID", solutionIssues: ["strict_generated_latex"] },
      candidate,
    }).category, "parsed_candidate_failure");
    assert.equal(classifySolveFailure({
      error: { code: "AI_SOLUTION_QUALITY_INVALID", solutionIssues: ["numerical_final_answer_mismatch"] },
      candidate,
    }).category, "parsed_candidate_failure");
    assert.equal(
      classifySolveFailure({ error: { code: "AI_SOLUTION_QUALITY_INVALID" }, candidate: null }).category,
      "response_generation_failure",
      "quality repair requires an actual parsed candidate",
    );
  });

  it("classifies malformed and equation-field symbol candidates below the fallback floor", () => {
    const result = {
      finalAnswerLatex: "I=1",
      steps: [{ math: "I=G", summary: "Use an undefined equation symbol." }],
    };
    const equationSymbolError = {
      solutionIssues: ["unexplained_generated_symbol:G"],
      solutionRuleEvaluations: [{
        result: "fail",
        name: "unexplained_generated_symbol",
        issue: "unexplained_generated_symbol:G",
        inputFields: ["steps[0].math"],
        failureEvidence: JSON.stringify({
          symbol: "G",
          fieldPath: "steps[0].math",
          sourceType: "math",
          classification: "undefined_free_symbol",
        }),
      }],
    };

    const equationCandidate = classifySolveCandidate({
      source: "repair-compact",
      result,
      error: equationSymbolError,
      parseSchemaSuccess: true,
      accepted: false,
    });
    const malformedCandidate = classifySolveCandidate({
      source: "repair",
      result: null,
      error: { code: "AI_RESPONSE_INVALID" },
      parseSchemaSuccess: false,
      accepted: false,
    });

    assert.equal(equationCandidate.fallbackEligible, false);
    assert.equal(equationCandidate.rejectionReason, "quality_rejected_not_fallback_safe");
    assert.equal(malformedCandidate.fallbackEligible, false);
    assert.equal(malformedCandidate.rejectionReason, "parse_or_schema_failed");
    assert.equal(selectBestSafeSolveCandidate([equationCandidate, malformedCandidate]), null);
  });

  it("does not capture sensitive headers or environment values", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const originalSecret = process.env.UNRELATED_SECRET_ENV_VALUE;
      process.env.UNRELATED_SECRET_ENV_VALUE = "secret-env-value";
      const outputs = [invalidSolveOutput("sensitive-check"), validSolveOutput()];
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      try {
        await invokeSolve(handleSolveExtractedProblemRequest, { requestId: "diag-sensitive" });
      } finally {
        if (originalSecret === undefined) delete process.env.UNRELATED_SECRET_ENV_VALUE;
        else process.env.UNRELATED_SECRET_ENV_VALUE = originalSecret;
      }

      const artifacts = await readArtifacts(cwd);
      const serialized = JSON.stringify(artifacts.map((artifact) => artifact.body));

      assert.equal(artifacts.length, 1);
      assert.doesNotMatch(serialized, /should-not-be-captured/);
      assert.doesNotMatch(serialized, /secret-env-value/);
    });
  });
});

describe("structural solve acceptance diagnostics", () => {
  it("routes every initial canonical solve to Sol without calling a provider", async () => {
    await withRuntime({ capture: false }, async () => {
      process.env.OMNIMATH_SOLVER_MODEL = "test-luna-model";
      process.env.OMNIMATH_REPAIR_MODEL = "test-terra-model";
      process.env.OMNIMATH_ESCALATION_MODEL = "test-sol-model";
      let providerCalls = 0;
      globalThis.fetch = async () => {
        providerCalls += 1;
        throw new Error("Routing must not call the provider.");
      };

      for (const canonicalLatex of [
        "x+1=2",
        regressionIntegralLatex,
        "\\oint_C F\\cdot dr",
        "\\sum_{n=1}^{\\infty}n^{-2}",
      ]) {
        assert.equal(resolveInitialSolveRouting({ canonicalLatex }).selectedInitialModelRole, "solver");
        assert.equal(resolveInitialSolveRouting({ canonicalLatex }).selectedInitialModel, "gpt-5.6-sol");
      }
      assert.equal(providerCalls, 0);
    });
  });

  it("returns a structurally valid Sol candidate without Terra repair", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      process.env.OMNIMATH_SOLVER_MODEL = "test-luna-model";
      process.env.OMNIMATH_REPAIR_MODEL = "test-terra-model";
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(openAiBody(invalidSolveOutput("accepted-directly")));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "structural-direct-acceptance",
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().finalAnswerLatex, "x=-35");
      assert.deepEqual(requests.map((request) => request.model), ["gpt-5.6-sol"]);
      assert.equal((await readArtifacts(cwd)).length, 0);
    });
  });

  it("replays the improper integral as a single Sol generation", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      process.env.OMNIMATH_SOLVER_MODEL = "test-luna-model";
      process.env.OMNIMATH_REPAIR_MODEL = "test-terra-model";
      const requests = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(openAiBody(concisePassingIntegralOutput()));
      };

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "improper-integral-direct-replay",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralPlainOcrProblem,
        canonicalTextValue: regressionIntegralPlainOcrProblem,
        canonicalLatexValue: regressionIntegralLatex,
      });

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, "gpt-5.6-sol");
      assert.equal(response.json().usage.settlement.providerCalls, 1);
      assert.equal((await readArtifacts(cwd)).length, 0);
    });
  });

  it("classifies all rejected responses as response-generation failures", () => {
    const candidate = {
      finalAnswerLatex: "x=2",
      steps: [{ math: "x=2", summary: "Solve the equation." }],
    };
    assert.equal(classifySolveFailure({
      error: { code: "AI_SOLUTION_QUALITY_INVALID" },
      candidate,
    }).category, "response_generation_failure");
    assert.equal(decideSolveFailureAction({
      result: candidate,
      error: { code: "AI_SOLUTION_QUALITY_INVALID" },
      parseSchemaSuccess: true,
      accepted: false,
    }).action, "accept");
  });
});
