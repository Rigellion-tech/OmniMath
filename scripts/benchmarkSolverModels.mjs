#!/usr/bin/env node
import dns from "node:dns/promises";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvFiles } from "../server/env.js";
import { normalizeOpenAiUsage } from "../server/openai.js";
import { analyzeNumericExpression } from "../server/mathValidationAnalysis.js";
import { estimateModelCostUsd } from "../server/openaiModels.js";
import { getSolverBenchmarkSuite } from "../server/solverBenchmarkSuite.js";
import { aggregateBenchmarkResults, classifyBenchmarkRecord, summarizeBenchmarkByCandidate } from "../server/solverBenchmarkMetrics.js";

loadEnvFiles();

const OPENAI_API_HOSTNAME = "api.openai.com";

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    models: [],
    efforts: [],
    policies: [],
    fixtures: [],
    repeats: 1,
    suite: "advanced-math",
    maxCostUsd: 1,
    maxCalls: 20,
    live: false,
    json: false,
    verbose: false,
    concurrency: 1,
    limit: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const inline = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "";
      if (inline) return inline;
      index += 1;
      return argv[index] || "";
    };
    if (arg === "--live") args.live = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--verbose") args.verbose = true;
    else if (arg.startsWith("--models")) args.models = readValue().split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg.startsWith("--efforts")) args.efforts = readValue().split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg.startsWith("--policies")) args.policies = readValue().split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg.startsWith("--fixtures")) args.fixtures = readValue().split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg.startsWith("--repeats")) args.repeats = Math.max(1, Number(readValue()) || 1);
    else if (arg.startsWith("--concurrency")) args.concurrency = Math.max(1, Number(readValue()) || 1);
    else if (arg.startsWith("--suite")) args.suite = readValue() || args.suite;
    else if (arg.startsWith("--max-cost-usd")) args.maxCostUsd = Math.max(0, Number(readValue()) || 0);
    else if (arg.startsWith("--max-calls")) args.maxCalls = Math.max(1, Number(readValue()) || 1);
    else if (arg.startsWith("--limit")) args.limit = Math.max(0, Number(readValue()) || 0);
  }
  if (args.models.length === 0) args.models = [process.env.OPENAI_MODEL || "gpt-4.1-mini"];
  if (args.efforts.length === 0) args.efforts = ["none"];
  return args;
}

function readEnvPresence(keys = []) {
  return Object.fromEntries(keys.map((key) => [key, Boolean(process.env[key])]));
}

async function collectBenchmarkNetworkDiagnostics({ resolveDns = true } = {}) {
  const diagnostics = {
    apiBaseUrlHost: OPENAI_API_HOSTNAME,
    nodeVersion: process.version,
    undiciVersion: process.versions?.undici || null,
    fetchImplementation: globalThis.fetch?.name || typeof globalThis.fetch,
    envPresence: readEnvPresence([
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_ORG_ID",
      "OPENAI_ORGANIZATION",
      "OPENAI_PROJECT",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "ALL_PROXY",
      "OMNIMATH_SOLVER_MODEL",
      "OMNIMATH_SOLVER_REASONING_EFFORT",
      "OMNIMATH_REPAIR_MODEL",
      "OMNIMATH_REPAIR_REASONING_EFFORT",
      "OMNIMATH_ESCALATION_MODEL",
      "OMNIMATH_ESCALATION_REASONING_EFFORT",
    ]),
    dns: {
      attempted: Boolean(resolveDns),
      ok: false,
      code: null,
      addresses: [],
    },
  };
  if (!resolveDns) return diagnostics;
  try {
    const resolved = await dns.lookup(OPENAI_API_HOSTNAME, { all: true });
    diagnostics.dns.ok = true;
    diagnostics.dns.addresses = resolved.map((item) => ({
      family: item.family,
      addressPrefix: String(item.address || "").includes(":") ? "ipv6" : String(item.address || "").split(".").slice(0, 2).join("."),
    }));
  } catch (error) {
    diagnostics.dns.code = error?.code || error?.cause?.code || "DNS_LOOKUP_FAILED";
  }
  return diagnostics;
}

function normalizeEffort(effort = "") {
  const value = String(effort || "").trim();
  return value && value !== "none" ? value : "";
}

function namedPolicyCandidate(policy = "") {
  const id = String(policy || "").trim();
  const currentStandard = process.env.OPENAI_MODEL || process.env.OPENAI_SOLVER_MODEL || "gpt-4.1-mini";
  const currentRepair = process.env.OPENAI_REPAIR_MODEL || currentStandard;
  const currentEscalation = process.env.OPENAI_ESCALATION_MODEL || "gpt-4.1";
  const efficientReasoning = process.env.OMNIMATH_BENCHMARK_EFFICIENT_REASONING_MODEL || "o4-mini";
  const strongReasoning = process.env.OMNIMATH_BENCHMARK_STRONG_REASONING_MODEL || "o3";
  if (id === "current") {
    return {
      id,
      solverModel: currentStandard,
      solverEffort: "",
      repairModel: currentRepair,
      repairEffort: "",
      escalationModel: currentEscalation,
      escalationEffort: "",
      escalationMode: "fresh",
    };
  }
  if (id === "policy-a") {
    return {
      id,
      solverModel: efficientReasoning,
      solverEffort: "medium",
      repairModel: efficientReasoning,
      repairEffort: "high",
      escalationModel: strongReasoning,
      escalationEffort: "high",
      escalationMode: "fresh",
    };
  }
  if (id === "policy-b") {
    return {
      id,
      solverModel: currentStandard,
      solverEffort: "",
      repairModel: efficientReasoning,
      repairEffort: "high",
      escalationModel: strongReasoning,
      escalationEffort: "high",
      escalationMode: "fresh",
    };
  }
  if (id === "policy-c") {
    return {
      id,
      solverModel: efficientReasoning,
      solverEffort: "high",
      repairModel: efficientReasoning,
      repairEffort: "high",
      escalationModel: strongReasoning,
      escalationEffort: "high",
      escalationMode: "fresh",
      notes: "Benchmark candidate for reasoning-first routing; production repair-skip policy is not enabled by this script.",
    };
  }
  throw new Error(`Unknown benchmark policy: ${id}`);
}

function comboCandidate(model = "", effort = "") {
  const normalizedEffort = normalizeEffort(effort);
  const labelEffort = normalizedEffort || "none";
  return {
    id: `${model}:${labelEffort}`,
    solverModel: model,
    solverEffort: normalizedEffort,
    repairModel: model,
    repairEffort: normalizedEffort,
    escalationModel: model,
    escalationEffort: normalizedEffort,
    escalationMode: "fresh",
  };
}

function buildBenchmarkCandidates(args = {}) {
  if (Array.isArray(args.policies) && args.policies.length > 0) {
    return args.policies.map((policy) => namedPolicyCandidate(policy));
  }
  const models = args.models?.length ? args.models : [process.env.OPENAI_MODEL || "gpt-4.1-mini"];
  const efforts = args.efforts?.length ? args.efforts : ["none"];
  return models.flatMap((model) => efforts.map((effort) => comboCandidate(model, effort)));
}

function selectBenchmarkFixtures(fixtures = [], args = {}) {
  if (!Array.isArray(args.fixtures) || args.fixtures.length === 0) return fixtures;
  const wanted = new Set(args.fixtures);
  const selected = fixtures.filter((fixture) => wanted.has(fixture.id));
  const missing = args.fixtures.filter((id) => !selected.some((fixture) => fixture.id === id));
  if (missing.length > 0) {
    throw new Error(`Unknown benchmark fixture id(s): ${missing.join(", ")}`);
  }
  return selected;
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

function acceptableOfflineRecord({ candidateId, fixture, repeatIndex, model, effort }) {
  const accepted = !fixture.correctRejectionAcceptable;
  const rejected = Boolean(fixture.correctRejectionAcceptable);
  return {
    candidateId,
    fixtureId: fixture.id,
    category: fixture.category,
    repeatIndex,
    model,
    effort,
    live: false,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    providerCalls: 0,
    acceptable: accepted,
    correct: accepted,
    rejected,
    correctRejection: rejected,
    expectedCorrect: !fixture.correctRejectionAcceptable,
  };
}

function isHighComplexityFixture(fixture = {}) {
  const category = String(fixture.category || "").toLowerCase();
  const latex = String(fixture.canonicalLatex || "");
  return fixture.correctRejectionAcceptable
    || /improper|stokes|green|series|multivariable|no elementary/u.test(category)
    || /\\infty|\\sum|\\iiint|\\iint/u.test(latex);
}

function estimateBenchmarkAttemptCostUsd(candidate = {}, fixture = {}) {
  const sourceText = `${fixture.canonicalText || ""}\n${fixture.canonicalLatex || ""}`;
  const inputTokens = Math.max(1700, Math.ceil(sourceText.length / 3) + 1600);
  const outputTokens = isHighComplexityFixture(fixture) ? 6500 : 2500;
  const calls = [
    candidate.solverModel,
    ...(isHighComplexityFixture(fixture) ? [candidate.repairModel, candidate.escalationModel] : []),
  ].filter(Boolean);
  const cost = calls.reduce((total, model) => {
    const estimated = estimateModelCostUsd(model, {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
    return total + (Number.isFinite(estimated) ? estimated : 0);
  }, 0);
  return Math.max(0.02, cost * 1.15);
}

function skippedCostCapRecord({ candidate, fixture, repeatIndex, costUsd, estimatedAttemptCostUsd, networkDiagnostics = null }) {
  const remainingCostUsd = Math.max(0, Number(candidate.maxCostUsd || 0) - Number(costUsd || 0));
  const record = {
    candidateId: candidate.id,
    fixtureId: fixture.id,
    category: fixture.category,
    repeatIndex,
    model: candidate.solverModel,
    effort: candidate.solverEffort || "none",
    repairModel: candidate.repairModel,
    repairEffort: candidate.repairEffort || "none",
    escalationModel: candidate.escalationModel,
    escalationEffort: candidate.escalationEffort || "none",
    escalationMode: candidate.escalationMode || "fresh",
    live: true,
    skipped: true,
    skipReason: "cost_cap_remaining_below_estimated_attempt",
    estimatedAttemptCostUsd,
    remainingCostUsd,
    statusCode: 0,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    providerCalls: 0,
    billedProviderCalls: 0,
    transportAttempts: 0,
    successfulProviderResponses: 0,
    retryCount: 0,
    acceptedByProduction: false,
    acceptable: false,
    correct: false,
    rejected: false,
    correctRejection: false,
    expectedCorrect: !fixture.correctRejectionAcceptable,
    evaluationStatus: "not_run_cost_cap",
    finalAnswerLatex: "",
    networkDiagnostics,
  };
  record.outcome = classifyBenchmarkRecord(record);
  return record;
}

async function invokeSolve(handler, fixture, requestId) {
  const req = {
    method: "POST",
    url: "/api/solve-extracted-problem",
    headers: {
      "content-type": "application/json",
      host: "localhost:8787",
    },
    socket: { remoteAddress: "127.0.0.1" },
    body: {
      problem: fixture.canonicalLatex,
      problemText: fixture.canonicalText,
      canonicalProblem: {
        canonicalText: fixture.canonicalText,
        canonicalLatex: fixture.canonicalLatex,
        source: "benchmark-fixture",
        extractionWarnings: [],
        extractionConfidence: 99,
        hash: fixture.id,
      },
      extraction: {
        normalizedText: fixture.canonicalText,
        validationText: fixture.canonicalText,
        extractedProblemLatex: fixture.canonicalLatex,
        rawExtractedLatex: fixture.canonicalLatex,
        confidence: 99,
        ocrConfidence: 99,
        mathIntegrityScore: 99,
        confidenceTier: "high",
        issues: [],
      },
      solveDecision: "direct",
      debugRequestId: requestId,
    },
  };
  const res = createJsonResponseRecorder();
  await handler(req, res);
  return res;
}

async function withBenchmarkRuntime(callback) {
  const originalCwd = process.cwd();
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL,
    DATABASE_URL: process.env.DATABASE_URL,
    POSTGRES_URL: process.env.POSTGRES_URL,
    USAGE_LOCAL_STORE_PATH: process.env.USAGE_LOCAL_STORE_PATH,
    USAGE_KV_REST_API_URL: process.env.USAGE_KV_REST_API_URL,
    USAGE_KV_REST_API_TOKEN: process.env.USAGE_KV_REST_API_TOKEN,
    OMNIMATH_SOLVER_MODEL: process.env.OMNIMATH_SOLVER_MODEL,
    OMNIMATH_SOLVER_REASONING_EFFORT: process.env.OMNIMATH_SOLVER_REASONING_EFFORT,
    OMNIMATH_REPAIR_MODEL: process.env.OMNIMATH_REPAIR_MODEL,
    OMNIMATH_REPAIR_REASONING_EFFORT: process.env.OMNIMATH_REPAIR_REASONING_EFFORT,
    OMNIMATH_ESCALATION_MODEL: process.env.OMNIMATH_ESCALATION_MODEL,
    OMNIMATH_ESCALATION_REASONING_EFFORT: process.env.OMNIMATH_ESCALATION_REASONING_EFFORT,
    DAILY_AI_LIMIT: process.env.DAILY_AI_LIMIT,
    MONTHLY_AI_LIMIT: process.env.MONTHLY_AI_LIMIT,
    DAILY_TOKEN_LIMIT: process.env.DAILY_TOKEN_LIMIT,
    MONTHLY_TOKEN_LIMIT: process.env.MONTHLY_TOKEN_LIMIT,
    AI_RATE_LIMIT_PER_MINUTE: process.env.AI_RATE_LIMIT_PER_MINUTE,
    AI_RATE_LIMIT_PER_HOUR: process.env.AI_RATE_LIMIT_PER_HOUR,
  };
  const cwd = join(tmpdir(), `omnimath-solver-benchmark-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(cwd, { recursive: true });
  process.chdir(cwd);
  process.env.NODE_ENV = "test";
  delete process.env.VERCEL;
  process.env.DATABASE_URL = "";
  process.env.POSTGRES_URL = "";
  process.env.USAGE_KV_REST_API_URL = "";
  process.env.USAGE_KV_REST_API_TOKEN = "";
  process.env.USAGE_LOCAL_STORE_PATH = join(cwd, ".data", "usage.json");
  process.env.DAILY_AI_LIMIT = "100000";
  process.env.MONTHLY_AI_LIMIT = "100000";
  process.env.DAILY_TOKEN_LIMIT = "100000000";
  process.env.MONTHLY_TOKEN_LIMIT = "100000000";
  process.env.AI_RATE_LIMIT_PER_MINUTE = "100000";
  process.env.AI_RATE_LIMIT_PER_HOUR = "100000";
  try {
    const appUrl = pathToFileURL(join(originalCwd, "server", "app.js")).href;
    const imported = await import(`${appUrl}?solver-benchmark-${Date.now()}-${Math.random()}`);
    return await callback({ cwd, handleSolveExtractedProblemRequest: imported.handleSolveExtractedProblemRequest });
  } finally {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  }
}

function usageFromBody(body = {}) {
  const usage = body.usage?.settlement
    ? {
        input_tokens: body.usage.settlement.actualInputTokens,
        output_tokens: body.usage.settlement.actualOutputTokens,
        total_tokens: body.usage.settlement.actualTotalTokens,
        output_tokens_details: {
          reasoning_tokens: body.usage.settlement.actualReasoningTokens || 0,
        },
      }
    : null;
  return normalizeOpenAiUsage(usage, 0);
}

function normalizeLatexForCompare(value = "") {
  return String(value || "")
    .replace(/\s+/gu, "")
    .replace(/\\left|\\right/gu, "")
    .trim();
}

function evaluateFixtureAnswer(fixture = {}, body = {}, statusCode = 0) {
  const acceptedByProduction = statusCode === 200;
  const rejected = statusCode >= 400;
  if (rejected) {
    return {
      acceptedByProduction,
      rejected,
      correct: false,
      correctRejection: Boolean(fixture.correctRejectionAcceptable),
      evaluationStatus: fixture.correctRejectionAcceptable ? "expected_rejection" : "rejected_expected_answer",
      proposedValue: null,
      absoluteDifference: null,
    };
  }

  const finalAnswerLatex = body.finalAnswerLatex || body.finalAnswer || body.answer || "";
  const exactExpected = normalizeLatexForCompare(fixture.expectedLatex);
  const exactProposed = normalizeLatexForCompare(finalAnswerLatex);
  if (exactExpected && exactProposed === exactExpected) {
    return {
      acceptedByProduction,
      rejected,
      correct: true,
      correctRejection: false,
      evaluationStatus: "exact_match",
      proposedValue: null,
      absoluteDifference: null,
    };
  }

  if (Number.isFinite(fixture.expectedNumeric)) {
    const analysis = analyzeNumericExpression(finalAnswerLatex);
    if (analysis.status === "evaluable" && Number.isFinite(analysis.value)) {
      const absoluteDifference = Math.abs(Number(analysis.value) - Number(fixture.expectedNumeric));
      const tolerance = Number.isFinite(fixture.tolerance) ? fixture.tolerance : 1e-6;
      return {
        acceptedByProduction,
        rejected,
        correct: absoluteDifference <= tolerance,
        correctRejection: false,
        evaluationStatus: absoluteDifference <= tolerance ? "numeric_match" : "numeric_mismatch",
        proposedValue: analysis.value,
        absoluteDifference,
        tolerance,
      };
    }
    return {
      acceptedByProduction,
      rejected,
      correct: false,
      correctRejection: false,
      evaluationStatus: `numeric_unparseable:${analysis.status}`,
      proposedValue: null,
      absoluteDifference: null,
    };
  }

  return {
    acceptedByProduction,
    rejected,
    correct: Boolean(fixture.symbolicOnlyAcceptable && exactExpected && exactProposed.includes(exactExpected)),
    correctRejection: false,
    evaluationStatus: "symbolic_comparison",
    proposedValue: null,
    absoluteDifference: null,
  };
}

async function runLiveBenchmark(args, fixtures) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for --live benchmark mode.");
  }
  const networkDiagnostics = await collectBenchmarkNetworkDiagnostics();
  const records = [];
  let calls = 0;
  let costUsd = 0;
  await withBenchmarkRuntime(async ({ handleSolveExtractedProblemRequest }) => {
    const candidates = buildBenchmarkCandidates(args);
    for (const candidate of candidates) {
        for (const fixture of fixtures) {
          for (let repeatIndex = 0; repeatIndex < args.repeats; repeatIndex += 1) {
            if (calls >= args.maxCalls || costUsd >= args.maxCostUsd) return;
            const estimatedAttemptCostUsd = estimateBenchmarkAttemptCostUsd(candidate, fixture);
            if (costUsd + estimatedAttemptCostUsd > args.maxCostUsd) {
              records.push(skippedCostCapRecord({
                candidate: { ...candidate, maxCostUsd: args.maxCostUsd },
                fixture,
                repeatIndex,
                costUsd,
                estimatedAttemptCostUsd,
                networkDiagnostics,
              }));
              continue;
            }
            process.env.OMNIMATH_SOLVER_MODEL = candidate.solverModel;
            process.env.OMNIMATH_REPAIR_MODEL = candidate.repairModel;
            process.env.OMNIMATH_ESCALATION_MODEL = candidate.escalationModel;
            if (candidate.solverEffort) process.env.OMNIMATH_SOLVER_REASONING_EFFORT = candidate.solverEffort;
            else delete process.env.OMNIMATH_SOLVER_REASONING_EFFORT;
            if (candidate.repairEffort) process.env.OMNIMATH_REPAIR_REASONING_EFFORT = candidate.repairEffort;
            else delete process.env.OMNIMATH_REPAIR_REASONING_EFFORT;
            if (candidate.escalationEffort) process.env.OMNIMATH_ESCALATION_REASONING_EFFORT = candidate.escalationEffort;
            else delete process.env.OMNIMATH_ESCALATION_REASONING_EFFORT;
            const started = Date.now();
            const response = await invokeSolve(
              handleSolveExtractedProblemRequest,
              fixture,
              `bench-${fixture.id}-${candidate.id}-${repeatIndex}`
            );
            const latencyMs = Date.now() - started;
            const body = response.json();
            const usage = usageFromBody(body);
            const actualCostUsd = Number(body.usage?.settlement?.actualCostMicros || 0) / 1000000;
            const providerCalls = Number(body.usage?.settlement?.providerCalls || 0);
            const transportDiagnostics = body.openAiTransportDiagnostics || null;
            const transportAttempts = Number(transportDiagnostics?.transportAttempts || providerCalls || 0);
            const successfulProviderResponses = Number(transportDiagnostics?.successfulProviderResponses || providerCalls || 0);
            const retryCount = Number(transportDiagnostics?.retryCount || Math.max(0, transportAttempts - successfulProviderResponses));
            const finalInfrastructureErrorCode = transportDiagnostics?.finalInfrastructureErrorCode || body.networkCauseCode || null;
            const infrastructureFailureType = transportDiagnostics?.finalInfrastructureFailureType || (
              response.statusCode === 429
                ? "provider_rate_limit"
                : response.statusCode === 503
                  ? "connect_failure"
                  : null
            );
            calls += providerCalls;
            costUsd += actualCostUsd;
            const rejected = response.statusCode >= 400;
            const infrastructureFailure = response.statusCode === 429
              || response.statusCode === 503
              || body.code === "AI_SERVICE_UNAVAILABLE"
              || body.code === "AI_PROVIDER_RATE_LIMITED";
            const evaluation = evaluateFixtureAnswer(fixture, body, response.statusCode);
            const acceptable = response.statusCode === 200 && evaluation.correct;
            const correctRejection = infrastructureFailure ? false : evaluation.correctRejection;
            const record = {
              candidateId: candidate.id,
              fixtureId: fixture.id,
              category: fixture.category,
              repeatIndex,
              model: candidate.solverModel,
              effort: candidate.solverEffort || "none",
              repairModel: candidate.repairModel,
              repairEffort: candidate.repairEffort || "none",
              escalationModel: candidate.escalationModel,
              escalationEffort: candidate.escalationEffort || "none",
              escalationMode: candidate.escalationMode || "fresh",
              live: true,
              statusCode: response.statusCode,
              latencyMs,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              reasoningTokens: usage.reasoningTokens,
              costUsd: actualCostUsd,
              providerCalls,
              billedProviderCalls: providerCalls,
              transportAttempts,
              successfulProviderResponses,
              retryCount,
              finalInfrastructureErrorCode,
              infrastructureFailureType,
              escalated: providerCalls >= 3,
              infrastructureFailure,
              acceptedByProduction: evaluation.acceptedByProduction,
              acceptable,
              correct: evaluation.correct,
              rejected,
              correctRejection,
              expectedCorrect: !fixture.correctRejectionAcceptable,
              evaluationStatus: evaluation.evaluationStatus,
              proposedValue: evaluation.proposedValue,
              absoluteDifference: evaluation.absoluteDifference,
              tolerance: evaluation.tolerance ?? fixture.tolerance ?? null,
              solutionIssues: body.solutionIssues || [],
              finalAnswerLatex: body.finalAnswerLatex || "",
              networkDiagnostics,
            };
            record.outcome = classifyBenchmarkRecord(record);
            records.push(record);
          }
        }
    }
  });
  return records;
}

async function main() {
  const args = parseArgs();
  const allFixtures = getSolverBenchmarkSuite(args.suite, { limit: args.fixtures.length ? 0 : args.limit });
  const selectedFixtures = selectBenchmarkFixtures(allFixtures, args);
  const fixtures = args.fixtures.length || !args.limit ? selectedFixtures : selectedFixtures.slice(0, args.limit);
  const candidates = buildBenchmarkCandidates(args);
  const originalConsole = {
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  if (args.json && !args.verbose) {
    console.info = () => {};
    console.warn = () => {};
    console.error = () => {};
  }
  let records;
  try {
    records = args.live
      ? await runLiveBenchmark(args, fixtures)
      : candidates.flatMap((candidate) => fixtures.flatMap((fixture) => (
          Array.from({ length: args.repeats }, (_, repeatIndex) => {
            const record = acceptableOfflineRecord({
              candidateId: candidate.id,
              fixture,
              repeatIndex,
              model: candidate.solverModel,
              effort: candidate.solverEffort || "none",
            });
            record.outcome = classifyBenchmarkRecord(record);
            return record;
          })
        )));
  } finally {
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
  const result = {
    live: args.live,
    suite: args.suite,
    fixtureCount: fixtures.length,
    networkDiagnostics: args.live ? records[0]?.networkDiagnostics || await collectBenchmarkNetworkDiagnostics() : null,
    records,
    summary: aggregateBenchmarkResults(records),
    candidates: summarizeBenchmarkByCandidate(records),
  };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Solver benchmark (${args.live ? "live" : "replay"}) suite=${args.suite} fixtures=${fixtures.length}`);
  for (const candidate of result.candidates) {
    console.log([
      candidate.candidateId,
      `acceptable=${candidate.acceptableOutcomeRate.toFixed(3)}`,
      `valid=${candidate.validCorrectAnswers}`,
      `correctReject=${candidate.correctRejections}`,
      `infra=${candidate.providerInfrastructureFailures}`,
      `wrongReturned=${candidate.returnedWrongAnswers}`,
      `cost=$${candidate.totalCostUsd.toFixed(6)}`,
      `cost/acceptable=${candidate.costPerValidatedAcceptableOutcome == null ? "n/a" : `$${candidate.costPerValidatedAcceptableOutcome.toFixed(6)}`}`,
      `p95=${candidate.p95LatencyMs ?? 0}ms`,
    ].join(" | "));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

export {
  buildBenchmarkCandidates,
  collectBenchmarkNetworkDiagnostics,
  estimateBenchmarkAttemptCostUsd,
  parseArgs,
  runLiveBenchmark,
};
