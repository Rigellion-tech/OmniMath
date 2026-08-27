import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateBenchmarkResults, summarizeBenchmarkByCandidate } from "../server/solverBenchmarkMetrics.js";
import { getSolverBenchmarkSuite } from "../server/solverBenchmarkSuite.js";
import { classifyProblemComplexity, chooseSolverRoleForProblem } from "../server/solverRouting.js";
import {
  buildBenchmarkCandidates,
  collectBenchmarkNetworkDiagnostics,
  estimateBenchmarkAttemptCostUsd,
  parseArgs,
  runLiveBenchmark,
} from "../scripts/benchmarkSolverModels.mjs";

const originalFetch = globalThis.fetch;
const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_RETRY_BASE_DELAY_MS: process.env.OPENAI_RETRY_BASE_DELAY_MS,
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  NO_PROXY: process.env.NO_PROXY,
  ALL_PROXY: process.env.ALL_PROXY,
};

function restoreRuntime() {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function eaiAgainError() {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.openai.com"), {
      code: "EAI_AGAIN",
    }),
  });
}

describe("solver benchmark suite", () => {
  it("contains a representative advanced-math suite with trustworthy metadata", () => {
    const fixtures = getSolverBenchmarkSuite("advanced-math");
    const categories = new Set(fixtures.map((fixture) => fixture.category));

    assert.equal(fixtures.length >= 20, true);
    for (const category of [
      "simple algebra",
      "polynomial equations",
      "substitution integrals",
      "improper integrals",
      "trigonometric integrals",
      "infinite series",
      "multivariable integrals",
      "Stokes/Green problems",
      "symbolic parameter problems",
      "no elementary closed form",
      "OCR-normalized canonical inputs",
      "known validator regression cases",
    ]) {
      assert.equal(categories.has(category), true, category);
    }
    assert.ok(fixtures.every((fixture) => fixture.canonicalText && fixture.canonicalLatex));
    assert.ok(fixtures.some((fixture) => fixture.correctRejectionAcceptable));
    assert.ok(fixtures.some((fixture) => Number.isFinite(fixture.expectedNumeric)));
  });

  it("aggregates cost, token, latency, and outcome metrics", () => {
    const records = [
      {
        candidateId: "a",
        acceptable: true,
        correct: true,
        latencyMs: 100,
        inputTokens: 1000,
        outputTokens: 200,
        reasoningTokens: 50,
        costUsd: 0.01,
        providerCalls: 1,
      },
      {
        candidateId: "a",
        rejected: true,
        correctRejection: true,
        latencyMs: 300,
        inputTokens: 2000,
        outputTokens: 300,
        reasoningTokens: 100,
        costUsd: 0.02,
        providerCalls: 3,
        escalated: true,
      },
      {
        candidateId: "b",
        rejected: true,
        expectedCorrect: true,
        latencyMs: 200,
        inputTokens: 500,
        outputTokens: 100,
        reasoningTokens: 0,
        costUsd: 0.005,
        providerCalls: 1,
      },
    ];

    const summary = aggregateBenchmarkResults(records);
    const byCandidate = summarizeBenchmarkByCandidate(records);

    assert.equal(summary.totalAttempts, 3);
    assert.equal(summary.validCorrectAnswers, 1);
    assert.equal(summary.correctRejections, 1);
    assert.equal(summary.falsePositiveValidatorRejections, 1);
    assert.equal(summary.repairFrequency, 1);
    assert.equal(summary.escalationFrequency, 1);
    assert.ok(Math.abs(summary.totalCostUsd - 0.035) < 1e-12);
    assert.ok(Math.abs(summary.costPerValidatedAcceptableOutcome - 0.0175) < 1e-12);
    assert.equal(summary.averageReasoningTokens, 50);
    assert.equal(summary.totalBilledProviderCalls, 5);
    assert.equal(byCandidate.find((item) => item.candidateId === "a").acceptableOutcomeRate, 1);
  });

  it("separates production-accepted wrong answers from acceptable outcomes", () => {
    const summary = aggregateBenchmarkResults([
      {
        candidateId: "wrong",
        acceptedByProduction: true,
        acceptable: false,
        correct: false,
        rejected: false,
        expectedCorrect: true,
        latencyMs: 10,
        costUsd: 0.01,
      },
    ]);

    assert.equal(summary.validCorrectAnswers, 0);
    assert.equal(summary.returnedWrongAnswers, 1);
    assert.equal(summary.acceptableOutcomeRate, 0);
  });

  it("separates provider infrastructure failures from validator outcomes", () => {
    const summary = aggregateBenchmarkResults([
      {
        candidateId: "infra",
        infrastructureFailure: true,
        transportAttempts: 3,
        successfulProviderResponses: 0,
        billedProviderCalls: 0,
        rejected: true,
        expectedCorrect: true,
        statusCode: 503,
        latencyMs: 20,
        costUsd: 0,
      },
    ]);

    assert.equal(summary.providerInfrastructureFailures, 1);
    assert.equal(summary.totalTransportAttempts, 3);
    assert.equal(summary.totalSuccessfulProviderResponses, 0);
    assert.equal(summary.totalBilledProviderCalls, 0);
    assert.equal(summary.falsePositiveValidatorRejections, 0);
    assert.equal(summary.acceptableOutcomeRate, 0);
  });

  it("excludes benchmark cost-cap skips from solve-attempt metrics", () => {
    const summary = aggregateBenchmarkResults([
      {
        candidateId: "skip",
        skipped: true,
        outcome: "benchmark_cost_cap_skipped",
        costUsd: 0,
        providerCalls: 0,
      },
      {
        candidateId: "ok",
        acceptable: true,
        correct: true,
        costUsd: 0.01,
        providerCalls: 1,
        latencyMs: 10,
      },
    ]);

    assert.equal(summary.totalAttempts, 1);
    assert.equal(summary.benchmarkSkipped, 1);
    assert.equal(summary.validCorrectAnswers, 1);
    assert.equal(summary.totalCostUsd, 0.01);
    assert.equal(summary.acceptableOutcomeRate, 1);
  });

  it("parses benchmark CLI args without enabling live mode by default", () => {
    const args = parseArgs([
      "--models", "gpt-4.1-mini,o4-mini",
      "--efforts=medium,high",
      "--repeats", "2",
      "--suite", "advanced-math",
      "--max-cost-usd", "5",
      "--max-calls", "12",
    ]);

    assert.deepEqual(args.models, ["gpt-4.1-mini", "o4-mini"]);
    assert.deepEqual(args.efforts, ["medium", "high"]);
    assert.equal(args.repeats, 2);
    assert.equal(args.maxCostUsd, 5);
    assert.equal(args.maxCalls, 12);
    assert.equal(args.concurrency, 1);
    assert.equal(args.live, false);
  });

  it("parses explicit sequential benchmark concurrency", () => {
    const args = parseArgs(["--concurrency", "1"]);

    assert.equal(args.concurrency, 1);
    assert.equal(args.live, false);
  });

  it("parses selected benchmark fixture ids", () => {
    const args = parseArgs(["--fixtures", "linear-equation,log-arctan-improper"]);

    assert.deepEqual(args.fixtures, ["linear-equation", "log-arctan-improper"]);
    assert.equal(args.live, false);
  });

  it("builds named policy candidates without enabling live mode", () => {
    const args = parseArgs(["--policies", "current,policy-b", "--repeats", "2"]);
    const candidates = buildBenchmarkCandidates(args);

    assert.equal(args.live, false);
    assert.deepEqual(candidates.map((candidate) => candidate.id), ["current", "policy-b"]);
    assert.equal(candidates.find((candidate) => candidate.id === "policy-b").repairModel, "gpt-5.6-luna");
    assert.equal(candidates.find((candidate) => candidate.id === "policy-b").escalationModel, "gpt-5.6-sol");
  });

  it("records production-route DNS failures as transport attempts without billed provider calls", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    process.env.OPENAI_RETRY_BASE_DELAY_MS = "1";
    globalThis.fetch = async () => {
      throw eaiAgainError();
    };

    try {
      const fixture = getSolverBenchmarkSuite("advanced-math").find((item) => item.id === "linear-equation");
      const records = await runLiveBenchmark({
        policies: ["current"],
        models: ["gpt-4.1-mini"],
        efforts: ["none"],
        repeats: 1,
        maxCalls: 1,
        maxCostUsd: 1,
        live: true,
        concurrency: 1,
      }, [fixture]);

      assert.equal(records.length, 1);
      assert.equal(records[0].outcome, "provider_infrastructure_failure");
      assert.equal(records[0].infrastructureFailureType, "dns_failure");
      assert.equal(records[0].finalInfrastructureErrorCode, "EAI_AGAIN");
      assert.equal(records[0].transportAttempts, 3);
      assert.equal(records[0].successfulProviderResponses, 0);
      assert.equal(records[0].billedProviderCalls, 0);
      assert.equal(records[0].costUsd, 0);
      assert.equal(records[0].networkDiagnostics.apiBaseUrlHost, "api.openai.com");
      assert.equal(records[0].networkDiagnostics.envPresence.OPENAI_API_KEY, true);
    } finally {
      restoreRuntime();
    }
  });

  it("collects sanitized benchmark network diagnostics without secret values", async () => {
    process.env.OPENAI_API_KEY = "secret-key";
    process.env.HTTPS_PROXY = "https://proxy-user:proxy-pass@example.test";

    try {
      const diagnostics = await collectBenchmarkNetworkDiagnostics({ resolveDns: false });
      const serialized = JSON.stringify(diagnostics);

      assert.equal(diagnostics.apiBaseUrlHost, "api.openai.com");
      assert.equal(diagnostics.envPresence.OPENAI_API_KEY, true);
      assert.equal(diagnostics.envPresence.HTTPS_PROXY, true);
      assert.equal(diagnostics.dns.attempted, false);
      assert.equal(serialized.includes("secret-key"), false);
      assert.equal(serialized.includes("proxy-pass"), false);
      assert.equal(serialized.includes("example.test"), false);
    } finally {
      restoreRuntime();
    }
  });

  it("skips live attempts before fetch when the remaining cost cap is too small", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("fetch should not be called");
    };

    try {
      const fixture = getSolverBenchmarkSuite("advanced-math").find((item) => item.id === "linear-equation");
      const records = await runLiveBenchmark({
        policies: ["current"],
        models: ["gpt-4.1-mini"],
        efforts: ["none"],
        repeats: 1,
        maxCalls: 5,
        maxCostUsd: 0.001,
        live: true,
        concurrency: 1,
      }, [fixture]);

      assert.equal(fetchCalls, 0);
      assert.equal(records.length, 1);
      assert.equal(records[0].outcome, "benchmark_cost_cap_skipped");
      assert.equal(records[0].billedProviderCalls, 0);
      assert.equal(records[0].costUsd, 0);
      assert.equal(records[0].estimatedAttemptCostUsd > 0.001, true);
      assert.equal(estimateBenchmarkAttemptCostUsd({ solverModel: "gpt-4.1-mini" }, fixture) > 0, true);
    } finally {
      restoreRuntime();
    }
  });
});

describe("solver routing", () => {
  it("routes simple algebra to the standard tier", () => {
    const route = chooseSolverRoleForProblem({ canonicalLatex: "x+1=2" });

    assert.equal(route.tier, "standard");
    assert.equal(route.role, "solver");
    assert.equal(route.reason, "default_standard");
  });

  it("keeps ordinary one-dimensional calculus on the standard tier", () => {
    const route = chooseSolverRoleForProblem({ canonicalLatex: "\\int_0^1 x^2\\,dx" });

    assert.deepEqual(route, {
      role: "solver",
      tier: "standard",
      reason: "one_dimensional_integral",
    });
  });

  it("lets the standard solver attempt improper integrals before repair", () => {
    assert.deepEqual(
      classifyProblemComplexity({ canonicalLatex: "\\int_0^\\infty e^{-x}\\,dx" }),
      { tier: "standard", reason: "improper_integral_standard_first" }
    );
    assert.deepEqual(
      chooseSolverRoleForProblem({ canonicalLatex: "\\int_0^\\infty e^{-x}\\,dx" }),
      { role: "solver", tier: "standard", reason: "improper_integral_standard_first" }
    );
  });

  it("preserves direct repair routing for infinite series", () => {
    assert.deepEqual(
      classifyProblemComplexity({ canonicalLatex: "\\sum_{n=1}^\\infty\\frac{1}{n^2}" }),
      { tier: "repair", reason: "infinite_series" }
    );
  });

  it("does not route prior mathematical validator findings away from Luna", () => {
    const route = chooseSolverRoleForProblem({
      canonicalLatex: "\\int_0^1 x\\,dx",
      priorIssues: ["numerical_final_answer_mismatch"],
    });

    assert.equal(route.role, "solver");
    assert.equal(route.reason, "solver_first:prior_mathematical_validation_failure");
  });

  it("routes the known improper-integral regression fixture to the standard solver first", () => {
    const route = chooseSolverRoleForProblem({
      canonicalLatex: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    });

    assert.deepEqual(route, {
      role: "solver",
      tier: "standard",
      reason: "improper_integral_standard_first",
    });
  });

  it("keeps higher-complexity classifications on the solver-first model role", () => {
    const route = chooseSolverRoleForProblem({ canonicalLatex: "\\oint_C F\\cdot dr" });

    assert.equal(route.role, "solver");
    assert.equal(route.tier, "escalation");
    assert.equal(route.reason, "solver_first:vector_or_multivariable_calculus");
  });
});
