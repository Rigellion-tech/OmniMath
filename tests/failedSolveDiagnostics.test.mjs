import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const appUrl = pathToFileURL(join(repoRoot, "server", "app.js")).href;
const problem = "x + 35^2 = 0";
const reviewedOcrText = "Evaluate x + 35^2 = 0.";
const regressionIntegralProblem = "Evaluate the integral from 0 to infinity of (ln(1 + x^2) times arctan x) divided by (x times (1 + x^2)) with respect to x.";

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
        latex: "u=\\theta,\\quad dv=\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta",
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

async function invokeSolve(handler, {
  requestId = "diag-test-request",
  problemValue = problem,
  reviewedTextValue = reviewedOcrText,
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
      canonicalProblem: {
        canonicalText: problemValue,
        canonicalLatex: "",
        source: "ocr-reviewed",
        extractionWarnings: [],
        extractionConfidence: 91,
        hash: "test-hash",
      },
      extraction: {
        normalizedText: problemValue,
        validationText: problemValue,
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

describe("failed solve diagnostics", () => {
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
      assert.match(artifacts[0].name, /_initial\.json$/);
      assert.equal(artifacts[0].body.metadata.requestId, "diag-initial-success");
      assert.deepEqual(artifacts[0].body.metadata.usageSettlement, {
        providerCalls: 1,
        actualInputTokens: 10,
        actualOutputTokens: 20,
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
      assert.doesNotMatch(JSON.stringify(requests), /math_compact_solve/);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].body.validation.exactFailedRule, "unsupported_integration_by_parts_setup");
      assert.match(repairPrompt, /unsupported_integration_by_parts_setup/);
      assert.match(repairPrompt, /explicitly provide u, dv, du, a correct explicit v/);
      assert.match(repairPrompt, /Verify v by differentiating/);
      assert.match(repairPrompt, /Do not leave v as an unevaluated integral/);
      assert.match(repairPrompt, /abandon that integration-by-parts choice/);
      assert.match(repairPrompt, /u=\\theta/);
      assert.match(repairPrompt, /dv=\\cot\\theta\\ln\(\\cos\\theta\)/);
      assert.equal(body.finalAnswerLatex, "\\frac{\\pi}{2}\\ln^2 2");
      assert.equal(body.runtime.source, "live AI repair call");
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
      assert.equal(artifacts[0].body.validation.numericalCrossCheckResult.issue, null);
      assert.equal(artifacts[0].body.validation.numericalCrossCheckResult.proposedValue, 0.7546938294602481);
      assert.equal(artifacts[0].body.validation.repairFeedback.repairCategory, "structural");

      assert.match(repairPrompt, /Structural repair task:/);
      assert.match(repairPrompt, /Preserve derivation/);
      assert.match(repairPrompt, /Preserve mathematics/);
      assert.match(repairPrompt, /Preserve final answer/);
      assert.match(repairPrompt, /Only repair symbol introduction/);
      assert.match(repairPrompt, /Do not recompute/);
      assert.match(repairPrompt, /\\frac\{\\pi\}\{2\}\\ln\^2 2/);
      assert.doesNotMatch(repairPrompt, /Quality repair context/);
      assert.doesNotMatch(repairPrompt, /Reconstruct the solution from scratch/);
      assert.doesNotMatch(repairPrompt, /Assume the previous derivation is mathematically unreliable/);
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

  it("persists repair feedback and repeated-method diagnostics", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
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

      assert.equal(response.statusCode, 502);
      assert.ok(initial);
      assert.ok(repair);
      assert.equal(initial.body.metadata.requestId, "diag-repeated-method");
      assert.equal(repair.body.metadata.requestId, "diag-repeated-method");
      assert.equal(initial.body.validation.exactFailedRule, "unsupported_integration_by_parts_setup");
      assert.equal(repair.body.validation.exactFailedRule, "unsupported_integration_by_parts_setup");
      assert.equal(repair.body.metadata.usageSettlement.providerCalls, 2);
      assert.equal(repair.body.metadata.usageSettlement.actualTotalTokens, 60);
      assert.ok(initial.body.validation.repairFeedback);
      assert.ok(initial.body.validation.issueCodes.includes("unsupported_integration_by_parts_setup"));
      assert.match(initial.body.validation.requestedCorrectionStrategy, /explicitly provide u, dv, du/);
      assert.ok(repair.body.validation.previousMethodFingerprint);
      assert.ok(repair.body.validation.currentMethodFingerprint);
      assert.equal(repair.body.validation.repeatedMethodDetected, true);
      assert.doesNotMatch(JSON.stringify(repair.body), /should-not-be-captured|test-key/);
    });
  });

  it("captures generated-response contract failures for full, compact, repair-full, and repair-compact attempts", async () => {
    await withRuntime({ capture: true }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        invalidFinalAnswerStructureFullOutput("initial-full"),
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
      assert.deepEqual(stages, ["initial-compact", "initial-full", "repair-compact", "repair-full"]);
      assert.equal(requests.length, 4);
      assert.equal(requests[1].text.format.name, "math_compact_solve");
      assert.equal(requests[3].text.format.name, "math_compact_solve");

      for (const artifact of artifacts) {
        assert.equal(artifact.body.metadata.requestId, "diag-generated-contract");
        assert.equal(artifact.body.metadata.responseFailureType, "field_structure");
        assert.equal(artifact.body.metadata.errorCode, "AI_RESPONSE_INVALID");
        assert.equal(artifact.body.metadata.compactRetryable, true);
        assert.equal(artifact.body.validation.responseFailureType, "field_structure");
        assert.ok(artifact.body.validation.solutionIssues.includes("invalid_latex:finalAnswerLatex:final_answer_contains_derivation_arrow"));
        assert.equal(artifact.body.validation.latexValidationIssues[0].fieldPath, "finalAnswerLatex");
        assert.match(artifact.body.modelResult.rawResponsesOutputText, /Rightarrow/);
        assert.equal(artifact.body.modelResult.parsedJsonBeforeSchemaNormalization.problemLatex, "\\int_0^1 x\\,dx");
        assert.equal(artifact.body.modelResult.schemaSanitizedJson, null);
        assert.equal(artifact.body.modelResult.sanitizedNormalizedSolutionJson, null);
      }
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

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "usage-compact-success",
        problemValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
        reviewedTextValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
      });
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
    });
  });

  it("settles exact usage for mathematical failure followed by successful repair", async () => {
    await withRuntime({ capture: false }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [wrongPiCubedIntegralOutput(), concisePassingIntegralOutput()];
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "usage-repair-success",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });
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
    });
  });

  it("settles actual provider usage when repair also fails quality validation", async () => {
    await withRuntime({ capture: false }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [wrongPiCubedIntegralOutput(), wrongPiCubedIntegralOutput()];
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "usage-repair-fails",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });
      const body = response.json();
      const counts = await readSolveUsageCounts(cwd);

      assert.equal(response.statusCode, 502);
      assert.equal(body.code, "AI_SOLUTION_QUALITY_INVALID");
      assert.deepEqual(counts, {
        requests: 2,
        tokens: 60,
        globalTokens: 60,
        globalCostMicros: 1301,
      });
      assertUsageSettlement(body, { providerCalls: 2, totalTokens: 60, reason: "failure" });
    });
  });

  it("settles exact usage for a four-provider-call generated-response failure", async () => {
    await withRuntime({ capture: false }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      const outputs = [
        invalidFinalAnswerStructureFullOutput("usage-initial-full"),
        invalidFinalAnswerStructureCompactOutput("usage-initial-compact"),
        invalidFinalAnswerStructureFullOutput("usage-repair-full"),
        invalidFinalAnswerStructureCompactOutput("usage-repair-compact"),
      ];
      globalThis.fetch = async () => jsonResponse(openAiBody(outputs.shift()));

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "usage-four-call-failure",
        problemValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
        reviewedTextValue: "Evaluate the integral from 0 to 1 of x with respect to x.",
      });
      const body = response.json();
      const counts = await readSolveUsageCounts(cwd);

      assert.equal(response.statusCode, 502);
      assert.equal(body.code, "AI_RESPONSE_INVALID");
      assert.deepEqual(counts, {
        requests: 4,
        tokens: 120,
        globalTokens: 120,
        globalCostMicros: 2601,
      });
      assertUsageSettlement(body, { providerCalls: 4, totalTokens: 120, reason: "failure" });
    });
  });

  it("counts a provider transport failure as a request without inventing token usage", async () => {
    await withRuntime({ capture: false }, async ({ cwd, handleSolveExtractedProblemRequest }) => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        async text() {
          return JSON.stringify({ error: { type: "invalid_request_error", code: "bad_request", message: "bad request" } });
        },
      });

      const response = await invokeSolve(handleSolveExtractedProblemRequest, {
        requestId: "usage-provider-transport",
        problemValue: regressionIntegralProblem,
        reviewedTextValue: regressionIntegralProblem,
      });
      const body = response.json();
      const counts = await readSolveUsageCounts(cwd);

      assert.equal(response.statusCode, 502);
      assert.equal(body.code, "AI_SERVICE_ERROR");
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
        invalidFinalAnswerStructureFullOutput("write-failure-repair-full"),
        invalidFinalAnswerStructureCompactOutput("write-failure-repair-compact"),
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
        requests: 4,
        tokens: 120,
        globalTokens: 120,
        globalCostMicros: 2601,
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
      assert.equal(artifacts.length, 0);
    });
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
