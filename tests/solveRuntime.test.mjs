import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSolveBudget } from "../server/solveBudget.js";
import { policyTelemetry, selectSolvePolicy } from "../server/solvePolicy.js";
import {
  SOLVE_RUNTIME_DEFAULTS,
  VERCEL_SOLVE_MAX_DURATION_MS,
  resolveSolveRuntime,
} from "../server/solveRuntime.js";

const ENV_KEYS = [
  "NODE_ENV",
  "VERCEL",
  "OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS",
  "OMNIMATH_SOLVE_INFRA_HEADROOM_MS",
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV = "test";
});
afterEach(restoreEnv);

const PROFILE_CASES = [
  ["simple", { problem: "Solve 5x + 6 = 11." }, 45_000],
  ["standard", { canonicalLatex: String.raw`\int_0^1 x^2\,dx` }, 90_000],
  ["advanced", { problem: "Prove this matrix identity for every normal linear operator." }, 150_000],
  ["elite", { problem: "Derive the second variation of a nonlinear functional and prove regularity in Sobolev space." }, 240_000],
];

describe("hosted solve runtime", () => {
  it("keeps the bundled runtime map synchronized with canonical solve routes", async () => {
    const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
    for (const [endpoint, durationMs] of Object.entries(VERCEL_SOLVE_MAX_DURATION_MS)) {
      const route = `api${endpoint.slice(4)}.js`;
      assert.equal(config.functions[route].maxDuration * 1_000, durationMs);
      assert.equal(config.functions[route].supportsCancellation, true);
    }
    assert.equal(config.functions["api/extract-image-problem.js"].maxDuration, 70);
  });

  for (const [tier, input, expectedBudgetMs] of PROFILE_CASES) {
    it(`gives the full ${tier} profile when the Vercel runtime permits it`, () => {
      process.env.NODE_ENV = "production";
      process.env.VERCEL = "1";
      const policy = selectSolvePolicy(input, {
        endpoint: "/api/explain",
        runtimeStartedAt: 1_000,
        now: 2_000,
      });
      assert.equal(policy.difficultyTier, tier);
      assert.equal(policy.selectedPolicyBudgetMs, expectedBudgetMs);
      assert.equal(policy.effectiveCanonicalBudgetMs, expectedBudgetMs);
      assert.equal(policy.budgetCappedByRuntime, false);
      assert.equal(policy.runtimeCapReason, null);
      assert.equal(policy.deploymentMaxDurationMs, 300_000);
      assert.equal(policy.deploymentHeadroomMs, 5_000);
      assert.equal(policy.elapsedPreSolveWorkMs, 1_000);
      assert.equal(policy.runtimeAvailableBudgetMs, 294_000);
      assert.equal(policy.canonicalDeadlineAt, 2_000 + expectedBudgetMs);
    });
  }

  it("caps below the selected budget and reports deployment ownership", () => {
    process.env.NODE_ENV = "production";
    process.env.VERCEL = "1";
    process.env.OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS = "100000";
    const policy = selectSolvePolicy(PROFILE_CASES[3][1], {
      endpoint: "/api/explain",
      runtimeStartedAt: 1_000,
      now: 2_000,
    });
    assert.equal(policy.selectedPolicyBudgetMs, 240_000);
    assert.equal(policy.effectiveCanonicalBudgetMs, 94_000);
    assert.equal(policy.budgetCappedByRuntime, true);
    assert.equal(policy.runtimeCapReason, "configured_runtime_ceiling");
    assert.equal(policy.runtimeAvailableBudgetMs, 94_000);
    assert.equal(policy.canonicalDeadlineAt, 96_000);
    const telemetry = policyTelemetry(policy);
    assert.equal(telemetry.difficultyTier, "elite");
    assert.equal(telemetry.selectedPolicyBudgetMs, 240_000);
    assert.equal(telemetry.effectiveCanonicalBudgetMs, 94_000);
    assert.equal(telemetry.deploymentMaxDurationMs, 300_000);
    assert.equal(telemetry.deploymentHeadroomMs, 5_000);
    assert.equal(telemetry.elapsedPreSolveWorkMs, 1_000);
    assert.equal(telemetry.runtimeAvailableBudgetMs, 94_000);
    assert.equal(telemetry.budgetCappedByRuntime, true);
    assert.equal(telemetry.runtimeCapReason, "configured_runtime_ceiling");
  });

  for (const endpoint of ["/api/explain", "/api/explain-image", "/api/solve-extracted-problem"]) {
    it(`reports the real deployment cap after long pre-solve work on ${endpoint}`, () => {
      process.env.NODE_ENV = "production";
      process.env.VERCEL = "1";
      const policy = selectSolvePolicy(PROFILE_CASES[3][1], {
        endpoint,
        runtimeStartedAt: 1_000,
        now: 61_000,
      });
      assert.equal(policy.selectedPolicyBudgetMs, 240_000);
      assert.equal(policy.effectiveCanonicalBudgetMs, 235_000);
      assert.equal(policy.runtimeAvailableBudgetMs, 235_000);
      assert.equal(policy.budgetCappedByRuntime, true);
      assert.equal(policy.runtimeCapReason, "deployment_max_duration");
      assert.equal(policy.canonicalDeadlineAt, 296_000);
    });
  }

  it("anchors the canonical timer to policy selection so later pre-provider work consumes it", () => {
    process.env.NODE_ENV = "production";
    process.env.VERCEL = "1";
    process.env.OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS = "100000";
    const policy = selectSolvePolicy(PROFILE_CASES[3][1], {
      endpoint: "/api/explain",
      runtimeStartedAt: 1_000,
      now: 2_000,
    });
    const budget = createSolveBudget({
      deadlineAt: policy.canonicalDeadlineAt,
      recoveryReserveMs: policy.recoveryBudgetMs,
      completionReserveMs: policy.responseReserveMs,
      now: () => 3_000,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    assert.equal(budget.totalTimeoutMs, 93_000);
    assert.equal(budget.deadlineAt, 96_000);
    budget.cleanup();
  });

  it("preserves at least five seconds of deployment headroom", () => {
    process.env.OMNIMATH_SOLVE_INFRA_HEADROOM_MS = "1000";
    process.env.OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS = "50000";
    const runtime = resolveSolveRuntime({ runtimeStartedAt: 0, now: 1_000 });
    assert.equal(runtime.deploymentHeadroomMs, SOLVE_RUNTIME_DEFAULTS.minimumDeploymentHeadroomMs);
    assert.equal(runtime.runtimeAvailableBudgetMs, 44_000);
  });

  it("does not apply Vercel deployment values during local development", () => {
    const runtime = resolveSolveRuntime({ endpoint: "/api/explain", runtimeStartedAt: 0, now: 1_000 });
    assert.equal(runtime.runtimeEnvironment, "local");
    assert.equal(runtime.deploymentMaxDurationMs, null);
    assert.equal(runtime.runtimeAvailableBudgetMs, null);
  });

  it("keeps the full elite policy locally after a long simulated pre-solve period", () => {
    const policy = selectSolvePolicy(PROFILE_CASES[3][1], {
      endpoint: "/api/explain",
      runtimeStartedAt: 1_000,
      now: 201_000,
    });
    assert.equal(policy.selectedPolicyBudgetMs, 240_000);
    assert.equal(policy.effectiveCanonicalBudgetMs, 240_000);
    assert.equal(policy.runtimeAvailableBudgetMs, null);
    assert.equal(policy.budgetCappedByRuntime, false);
    assert.equal(policy.canonicalDeadlineAt, 441_000);
  });

  it("does not let an environment ceiling raise Vercel's configured duration", () => {
    process.env.NODE_ENV = "production";
    process.env.VERCEL = "1";
    process.env.OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS = "900000";
    const runtime = resolveSolveRuntime({ endpoint: "/api/explain", runtimeStartedAt: 0, now: 1_000 });
    assert.equal(runtime.deploymentMaxDurationMs, 300_000);
    assert.equal(runtime.effectiveRuntimeCeilingMs, 300_000);
  });

  it("requires an explicit runtime ceiling in non-Vercel production", () => {
    process.env.NODE_ENV = "production";
    assert.throws(
      () => resolveSolveRuntime({ endpoint: "/api/explain" }),
      (error) => error.code === "SERVER_CONFIG_ERROR",
    );
    process.env.OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS = "250000";
    const configured = resolveSolveRuntime({ endpoint: "/api/explain", runtimeStartedAt: 0, now: 1_000 });
    assert.equal(configured.effectiveRuntimeCeilingMs, 250_000);
    assert.equal(configured.runtimeLimitSource, "environment");
  });

  it("fails closed for invalid runtime ceilings and unknown Vercel solve routes", () => {
    for (const value of ["NaN", "Infinity", "0"]) {
      process.env.OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS = value;
      assert.throws(
        () => resolveSolveRuntime({ endpoint: "/api/explain" }),
        (error) => error.code === "SERVER_CONFIG_ERROR",
        value,
      );
    }
    delete process.env.OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS;
    process.env.NODE_ENV = "production";
    process.env.VERCEL = "1";
    assert.throws(
      () => resolveSolveRuntime({ endpoint: "/api/not-a-solve-route" }),
      (error) => error.code === "SERVER_CONFIG_ERROR",
    );
  });
});
