import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { classifyProblemComplexity, chooseSolverRoleForProblem } from "../server/solverRouting.js";
import { getSolvePolicySelection } from "../server/openaiModels.js";
import {
  estimateSolvePolicyReservation,
  policyTelemetry,
  selectSolvePolicy,
} from "../server/solvePolicy.js";

const ENV_KEYS = [
  "NODE_ENV", "VERCEL",
  "OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS", "OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS", "OMNIMATH_SOLVE_INFRA_HEADROOM_MS",
  "OMNIMATH_SOLVE_TIMEOUT_RECOVERY_STRATEGY",
  "OMNIMATH_CANONICAL_SOLVE_MODEL", "OMNIMATH_ESCALATION_MODEL", "OPENAI_ESCALATION_MODEL",
  "OMNIMATH_HARD_SOLVE_MODEL", "OPENAI_HARD_SOLVE_MODEL", "OMNIMATH_REPAIR_MODEL", "OPENAI_REPAIR_MODEL",
  "OMNIMATH_HARD_SOLVE_MAX_OUTPUT_TOKENS", "OMNIMATH_HARD_SOLVE_COMPACT_MAX_OUTPUT_TOKENS",
  "OMNIMATH_REPAIR_MAX_OUTPUT_TOKENS", "OMNIMATH_REPAIR_COMPACT_MAX_OUTPUT_TOKENS",
  "OMNIMATH_MODEL_GPT_5_6_SOL_INPUT_COST_PER_1M", "OMNIMATH_MODEL_GPT_5_6_SOL_OUTPUT_COST_PER_1M",
  "OMNIMATH_DEFAULT_INPUT_COST_PER_1M_TOKENS", "OMNIMATH_DEFAULT_OUTPUT_COST_PER_1M_TOKENS",
  "OPENAI_INPUT_COST_PER_1M_TOKENS", "OPENAI_OUTPUT_COST_PER_1M_TOKENS",
  ...["SIMPLE", "STANDARD", "ADVANCED", "ELITE"].flatMap((tier) => [
    `OMNIMATH_SOLVE_${tier}_TOTAL_TIMEOUT_MS`,
    `OMNIMATH_SOLVE_${tier}_RECOVERY_RESERVE_MS`,
    `OMNIMATH_SOLVE_${tier}_RESPONSE_RESERVE_MS`,
    `OMNIMATH_SOLVE_${tier}_MAX_OUTPUT_TOKENS`,
    `OMNIMATH_SOLVE_${tier}_COMPACT_MAX_OUTPUT_TOKENS`,
  ]),
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

function clearPolicyEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV = "test";
}

beforeEach(clearPolicyEnv);
afterEach(restoreEnv);

function assertBudgetInvariant(policy) {
  assert.ok(policy.primaryBudgetMs > 0);
  assert.ok(policy.responseReserveMs > 0);
  assert.ok(policy.recoveryBudgetMs >= 0);
  assert.ok(policy.primaryBudgetMs + policy.recoveryBudgetMs + policy.responseReserveMs <= policy.canonicalBudgetMs);
}

describe("mathematical difficulty classifier", () => {
  const fixtures = [
    ["linear equation", { problem: "Solve 5x + 6 = 11." }, "simple", "solver"],
    ["quadratic equation", { problem: "Solve the quadratic x^2 - 5x + 6 = 0 by factoring." }, "simple", "solver"],
    ["undergraduate integral", { canonicalLatex: String.raw`\int_0^1 x^2\,dx` }, "standard", "solver"],
    ["basic probability", { problem: "What is the probability of rolling a total of 7 with two fair dice?" }, "simple", "solver"],
    ["ordinary ODE", { problem: "Solve the initial value problem y' + 2y = 0, y(0)=3." }, "standard", "solver"],
    ["nonlinear PDE", { problem: "Prove existence and regularity of weak solutions for this nonlinear PDE in a Sobolev space." }, "elite", "hardSolve"],
    ["hard variational calculus", { problem: "Derive the second variation of this nonlinear functional and prove coercivity in a Sobolev space." }, "elite", "hardSolve"],
    ["notation-heavy simple", { problem: String.raw`Evaluate \left(1+1\right)^{20}/2^{20}.` }, "simple", "solver"],
    ["long prose easy", { problem: `${"Read the following elementary instruction carefully. ".repeat(80)} Solve 5x + 6 = 11.` }, "simple", "solver"],
    ["short conceptual problem", { problem: "Prove the spectral theorem for compact self-adjoint operators." }, "advanced", "hardSolve"],
  ];

  for (const [name, input, expectedTier, expectedRole] of fixtures) {
    it(`classifies ${name} by task characteristics`, () => {
      const classification = classifyProblemComplexity(input);
      const route = chooseSolverRoleForProblem(input);
      assert.equal(classification.tier, expectedTier);
      assert.equal(route.role, expectedRole);
    });
  }

  it("keeps small numeric matrix arithmetic on the cheap route", () => {
    const route = chooseSolverRoleForProblem({
      problem: "For the following 3x3 matrices, calculate AB, A^2, A - 2B, det(A), and the inverse of A.",
      canonicalLatex: String.raw`A=\begin{bmatrix}1&2&0\\0&1&3\\2&0&1\end{bmatrix}, B=\begin{bmatrix}0&1&2\\1&0&1\\2&1&0\end{bmatrix}`,
    });
    assert.deepEqual(route, { role: "solver", tier: "simple", reason: "small_numeric_matrix_computation" });
  });

  it("distinguishes an advanced operator proof from matrix arithmetic", () => {
    const route = chooseSolverRoleForProblem({ problem: "Prove that a compact self-adjoint linear operator on a Hilbert space admits the claimed spectral decomposition." });
    assert.equal(route.tier, "advanced");
    assert.equal(route.role, "hardSolve");
    assert.equal(route.reason, "advanced_matrix_or_operator_proof");
  });

  it("does not use OCR confidence as evidence of mathematical difficulty", () => {
    const route = chooseSolverRoleForProblem({ problem: "Solve 5x + 6 = 11.", ocrConfidence: 12 });
    assert.equal(route.tier, "simple");
    assert.equal(route.role, "solver");
  });

  it("reserves the repair role for an actual prior symbol repair", () => {
    const route = chooseSolverRoleForProblem({ problem: "Solve x + 1 = 2.", priorIssues: ["unexplained_generated_symbol_q"] });
    assert.equal(route.tier, "advanced");
    assert.equal(route.role, "repair");
  });

  it("does not make a difficult analysis task simple because it says compute", () => {
    const route = chooseSolverRoleForProblem({ problem: "Compute the limit using the dominated convergence theorem." });
    assert.notEqual(route.tier, "simple");
  });

  it("does not escalate an isolated glossary keyword", () => {
    const route = chooseSolverRoleForProblem({ problem: "Define variational calculus." });
    assert.equal(route.tier, "standard");
    assert.equal(route.role, "solver");
  });

  it("does not escalate a standalone advanced concept without a mathematical task", () => {
    for (const problem of ["Hilbert space", "Hamiltonian"]) {
      const route = chooseSolverRoleForProblem({ problem });
      assert.equal(route.tier, "standard");
      assert.equal(route.role, "solver");
    }
  });

  it("keeps an operator glossary question standard", () => {
    const route = chooseSolverRoleForProblem({ problem: "What is a compact linear operator on a Hilbert space?" });
    assert.equal(route.tier, "standard");
    assert.equal(route.role, "solver");
    assert.equal(route.reason, "concept_definition");
  });

  it("does not call a mixed symbolic matrix task a small numeric computation", () => {
    const route = chooseSolverRoleForProblem({
      problem: "Compute the matrix product and discuss the symbolic result.",
      canonicalLatex: String.raw`A=\begin{bmatrix}1&0\\0&1\end{bmatrix}, C=\begin{bmatrix}a&b\\c&d\end{bmatrix}`,
    });
    assert.equal(route.tier, "standard");
  });

  it("recognizes a bounded finite sum as a simple computation", () => {
    const route = chooseSolverRoleForProblem({ problem: String.raw`Evaluate \sum_{k=1}^{5} k^2.` });
    assert.equal(route.tier, "simple");
  });
});

describe("coherent solve policy", () => {
  it("selects increasing default compute and output envelopes", () => {
    const simple = selectSolvePolicy({ problem: "Solve 5x + 6 = 11." });
    const standard = selectSolvePolicy({ canonicalLatex: String.raw`\int_0^1 x^2\,dx` });
    const advanced = selectSolvePolicy({ problem: "Prove this matrix identity for every normal linear operator." });
    const elite = selectSolvePolicy({ problem: "Derive the second variation of a nonlinear functional and prove regularity in Sobolev space." });

    assert.deepEqual([simple.canonicalBudgetMs, standard.canonicalBudgetMs, advanced.canonicalBudgetMs, elite.canonicalBudgetMs], [45_000, 90_000, 150_000, 240_000]);
    assert.deepEqual([simple.maxOutputTokens, standard.maxOutputTokens, advanced.maxOutputTokens, elite.maxOutputTokens], [3_200, 6_500, 12_000, 24_000]);
    for (const policy of [simple, standard, advanced, elite]) {
      assertBudgetInvariant(policy);
      assert.ok(policy.recoveryBudgetMs > 0);
      assert.equal(policy.maxRouteAttempts, 2);
    }
  });

  it("exposes separate timeout, structured, and repair recovery choices", () => {
    const policy = selectSolvePolicy({ problem: "Solve 5x + 6 = 11." });
    assert.equal(policy.recoverySelections.timeout.modelPath, policy.initialSelection.modelPath);
    assert.equal(policy.recoverySelections.structured.modelPath, "escalation");
    assert.equal(policy.recoverySelections.repair.modelPath, "repair");
    for (const selection of Object.values(policy.recoverySelections)) {
      assert.ok(selection.maxOutputTokens <= policy.maxOutputTokens);
      assert.ok(selection.compactMaxOutputTokens <= policy.compactMaxOutputTokens);
    }
    assert.deepEqual(policy.recoveryPolicy.allowedSelections, ["timeout", "structured"]);
  });

  it("allows bounded repair recovery only for progressive solves", () => {
    const input = { problem: "Solve 5x + 6 = 11." };
    const ordinary = selectSolvePolicy(input);
    const progressive = selectSolvePolicy(input, { recoveryMode: "progressive" });
    assert.deepEqual(ordinary.recoveryPolicy.allowedSelections, ["timeout", "structured"]);
    assert.deepEqual(progressive.recoveryPolicy.allowedSelections, ["timeout", "structured", "repair"]);

    const ordinaryReservation = estimateSolvePolicyReservation({ policy: ordinary, prompt: "Solve." });
    const progressiveReservation = estimateSolvePolicyReservation({ policy: progressive, prompt: "Solve." });
    assert.deepEqual(ordinaryReservation.recoveryCandidates.map((candidate) => candidate.variant), ["timeout", "structured"]);
    assert.deepEqual(progressiveReservation.recoveryCandidates.map((candidate) => candidate.variant), ["timeout", "structured", "repair"]);
    assert.equal(progressiveReservation.recoveryCandidates.find((candidate) => candidate.variant === "repair").inputOverheadTokens, 4_096);
    assert.ok(progressiveReservation.estimatedInputTokens > ordinaryReservation.estimatedInputTokens);
  });

  it("resolves an explicitly named recovery selection from the immutable snapshot", () => {
    const policy = selectSolvePolicy({ problem: "Solve 5x + 6 = 11." }, { recoveryMode: "progressive" });
    for (const name of policy.recoveryPolicy.allowedSelections) {
      const selection = getSolvePolicySelection("escalation", {
        solvePolicy: policy,
        solveBudgetStage: "recovery",
        recoverySelection: name,
      });
      assert.equal(selection, policy.recoverySelections[name]);
    }
  });

  it("can escalate timeout recovery without changing the one-recovery limit", () => {
    process.env.OMNIMATH_SOLVE_TIMEOUT_RECOVERY_STRATEGY = "escalation";
    const policy = selectSolvePolicy({ problem: "Solve 5x + 6 = 11." });
    assert.equal(policy.recoverySelections.timeout.modelPath, "escalation");
    assert.equal(policy.maxRouteAttempts, 2);
  });

  it("can disable recovery as an explicit policy", () => {
    process.env.OMNIMATH_SOLVE_TIMEOUT_RECOVERY_STRATEGY = "disabled";
    const policy = selectSolvePolicy({ problem: "Solve 5x + 6 = 11." });
    assert.equal(policy.recoveryEligible, false);
    assert.equal(policy.recoveryBudgetMs, 0);
    assert.equal(policy.maxRouteAttempts, 1);
    assert.deepEqual(policy.recoveryPolicy.allowedSelections, []);
    assertBudgetInvariant(policy);
  });

  it("honors a tier profile override and keeps allocations within total", () => {
    process.env.OMNIMATH_SOLVE_ADVANCED_TOTAL_TIMEOUT_MS = "120000";
    process.env.OMNIMATH_SOLVE_ADVANCED_RECOVERY_RESERVE_MS = "30000";
    process.env.OMNIMATH_SOLVE_ADVANCED_RESPONSE_RESERVE_MS = "5000";
    process.env.OMNIMATH_SOLVE_ADVANCED_MAX_OUTPUT_TOKENS = "14000";
    const policy = selectSolvePolicy({ problem: "Prove this matrix identity for every normal linear operator." });
    assert.equal(policy.canonicalBudgetMs, 120_000);
    assert.equal(policy.primaryBudgetMs, 85_000);
    assert.equal(policy.recoveryBudgetMs, 30_000);
    assert.equal(policy.responseReserveMs, 5_000);
    assert.equal(policy.maxOutputTokens, 14_000);
    assertBudgetInvariant(policy);
  });

  it("treats an invalid tier output override as a default subject to the role ceiling", () => {
    process.env.OMNIMATH_HARD_SOLVE_MAX_OUTPUT_TOKENS = "14000";
    process.env.OMNIMATH_REPAIR_MAX_OUTPUT_TOKENS = "16000";
    process.env.OMNIMATH_SOLVE_ELITE_MAX_OUTPUT_TOKENS = "invalid";
    const policy = selectSolvePolicy({
      problem: "Derive the second variation of this constrained nonlinear functional and prove regularity in a Sobolev space.",
    });
    assert.equal(policy.difficultyTier, "elite");
    assert.equal(policy.maxOutputTokens, 14_000);
    assert.equal(policy.recoverySelections.repair.maxOutputTokens, 16_000);
  });

  it("deep-freezes the selected policy snapshot and its nested routing data", () => {
    const policy = selectSolvePolicy({ problem: "Solve 5x + 6 = 11." }, { recoveryMode: "progressive" });
    for (const value of [
      policy,
      policy.features,
      policy.initialSelection,
      policy.initialSelection.supportedReasoningEfforts,
      policy.recoverySelections,
      policy.recoverySelections.repair,
      policy.budgetSources,
      policy.recoveryPolicy,
      policy.recoveryPolicy.allowedSelections,
    ]) assert.equal(Object.isFrozen(value), true);
    assert.throws(() => { policy.primaryBudgetMs = 1; }, TypeError);
    assert.throws(() => { policy.recoverySelections.timeout.modelId = "changed"; }, TypeError);
  });

  it("preserves the legacy global timeout shape when no tier timing override exists", () => {
    process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS = "80000";
    const policy = selectSolvePolicy({ canonicalLatex: String.raw`\int x^2\,dx` });
    assert.equal(policy.canonicalBudgetMs, 80_000);
    assert.equal(policy.recoveryBudgetMs, 20_000);
    assert.equal(policy.responseReserveMs, 2_000);
    assert.equal(policy.primaryBudgetMs, 58_000);
  });

  it("caps an elite policy to the deployed endpoint lifetime with infrastructure headroom", () => {
    process.env.NODE_ENV = "production";
    process.env.VERCEL = "1";
    process.env.OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS = "100000";
    const policy = selectSolvePolicy(
      { problem: "Derive the second variation of a nonlinear functional and prove regularity in Sobolev space." },
      { endpoint: "/api/explain", runtimeStartedAt: 1_000, now: 2_000 },
    );
    assert.equal(policy.requestedCanonicalBudgetMs, 240_000);
    assert.equal(policy.canonicalBudgetMs, 94_000);
    assert.equal(policy.runtimeLimitMs, 100_000);
    assert.equal(policy.runtimeCapApplied, true);
    assertBudgetInvariant(policy);
  });

  it("does not treat an omitted runtime start as Unix epoch elapsed", () => {
    process.env.NODE_ENV = "production";
    process.env.VERCEL = "1";
    process.env.OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS = "100000";
    const policy = selectSolvePolicy(
      { problem: "Derive the second variation of a nonlinear functional and prove regularity in Sobolev space." },
      { endpoint: "/api/explain" },
    );
    assert.equal(policy.canonicalBudgetMs, 95_000);
    assert.equal(policy.runtimeCapApplied, true);
  });

  it("fails with a typed timeout if no safe runtime budget remains", () => {
    process.env.NODE_ENV = "production";
    process.env.VERCEL = "1";
    process.env.OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS = "100000";
    assert.throws(
      () => selectSolvePolicy({ problem: "Solve 5x + 6 = 11." }, { endpoint: "/api/explain", runtimeStartedAt: 0, now: 99_500 }),
      (error) => error.code === "AI_SOLVE_TIMEOUT" && error.statusCode === 504,
    );
  });

  it("reserves cost from the selected route rather than a universal worst case", () => {
    const prompt = "Solve the problem and explain the steps.";
    const simplePolicy = selectSolvePolicy({ problem: "Solve 5x + 6 = 11." });
    const elitePolicy = selectSolvePolicy({ problem: "Derive the second variation of a nonlinear functional and prove regularity in Sobolev space." });
    const simple = estimateSolvePolicyReservation({ policy: simplePolicy, prompt });
    const elite = estimateSolvePolicyReservation({ policy: elitePolicy, prompt });
    assert.ok(simple.estimatedCostMicros > 0);
    assert.ok(elite.estimatedCostMicros > simple.estimatedCostMicros);
    assert.equal(simple.semanticGenerationLimit, 2);
    assert.equal(simple.estimatedTokens, simple.estimatedInputTokens + simple.estimatedMaxOutputTokens);
    const telemetry = policyTelemetry(simplePolicy, simple);
    assert.equal(telemetry.difficultyTier, "simple");
    assert.equal(telemetry.estimatedCostMicros, simple.estimatedCostMicros);
  });

  it("estimates reservation cost from the immutable policy pricing snapshot", () => {
    process.env.OMNIMATH_MODEL_GPT_5_6_SOL_INPUT_COST_PER_1M = "1";
    process.env.OMNIMATH_MODEL_GPT_5_6_SOL_OUTPUT_COST_PER_1M = "2";
    const policy = selectSolvePolicy({ problem: "Solve 5x + 6 = 11." });
    const before = estimateSolvePolicyReservation({ policy, prompt: "12345678" });
    process.env.OMNIMATH_MODEL_GPT_5_6_SOL_INPUT_COST_PER_1M = "100";
    process.env.OMNIMATH_MODEL_GPT_5_6_SOL_OUTPUT_COST_PER_1M = "200";
    const after = estimateSolvePolicyReservation({ policy, prompt: "12345678" });
    assert.equal(after.estimatedCostMicros, before.estimatedCostMicros);
    assert.equal(before.estimatedInputTokens, 2 + 2 + 512);
  });

  it("ignores blank optional prices and falls through to configured global pricing", () => {
    process.env.OMNIMATH_MODEL_GPT_5_6_SOL_INPUT_COST_PER_1M = "";
    process.env.OMNIMATH_MODEL_GPT_5_6_SOL_OUTPUT_COST_PER_1M = "";
    process.env.OMNIMATH_DEFAULT_INPUT_COST_PER_1M_TOKENS = "";
    process.env.OMNIMATH_DEFAULT_OUTPUT_COST_PER_1M_TOKENS = "";
    process.env.OPENAI_INPUT_COST_PER_1M_TOKENS = "7";
    process.env.OPENAI_OUTPUT_COST_PER_1M_TOKENS = "31";
    const policy = selectSolvePolicy({ problem: "Solve 5x + 6 = 11." });
    assert.equal(policy.initialSelection.inputCostPer1M, 7);
    assert.equal(policy.initialSelection.outputCostPer1M, 31);
    assert.ok(estimateSolvePolicyReservation({ policy, prompt: "Solve." }).estimatedCostMicros > 0);
  });

  it("preserves an explicit zero model price for intentionally free models", () => {
    process.env.OMNIMATH_CANONICAL_SOLVE_MODEL = "gpt-5.6-sol";
    process.env.OMNIMATH_ESCALATION_MODEL = "gpt-5.6-sol";
    process.env.OMNIMATH_MODEL_GPT_5_6_SOL_INPUT_COST_PER_1M = "0";
    process.env.OMNIMATH_MODEL_GPT_5_6_SOL_OUTPUT_COST_PER_1M = "0";
    process.env.OPENAI_INPUT_COST_PER_1M_TOKENS = "7";
    process.env.OPENAI_OUTPUT_COST_PER_1M_TOKENS = "31";
    const policy = selectSolvePolicy({ problem: "Solve 5x + 6 = 11." });
    assert.equal(policy.initialSelection.inputCostPer1M, 0);
    assert.equal(policy.initialSelection.outputCostPer1M, 0);
    const reservation = estimateSolvePolicyReservation({ policy, prompt: "Solve." });
    assert.equal(reservation.primary.estimatedCostMicros, 0);
    assert.equal(reservation.estimatedCostMicros, 0);
  });

  it("uses a labeled conservative price for unknown selected model ids", () => {
    process.env.OMNIMATH_CANONICAL_SOLVE_MODEL = "custom-primary-model";
    process.env.OMNIMATH_ESCALATION_MODEL = "custom-recovery-model";
    const policy = selectSolvePolicy({ problem: "Solve 5x + 6 = 11." });
    const reservation = estimateSolvePolicyReservation({ policy, prompt: "Solve." });
    assert.equal(policy.initialSelection.pricingSource, "unknown_model_policy_default_estimate");
    assert.equal(policy.recoverySelections.structured.pricingSource, "unknown_model_policy_default_estimate");
    assert.ok(reservation.primary.estimatedCostMicros > 0);
    assert.ok(reservation.recovery.estimatedCostMicros > 0);
    assert.ok(reservation.estimatedCostMicros > 0);
    assert.equal(reservation.pricingFallbackUsed, true);
    assert.deepEqual(reservation.pricingSources, ["unknown_model_policy_default_estimate"]);
  });

  it("fails closed if a manually constructed policy has no valid price", () => {
    const selected = selectSolvePolicy({ problem: "Solve 5x + 6 = 11." });
    const invalid = {
      ...selected,
      recoveryEligible: false,
      initialSelection: {
        ...selected.initialSelection,
        inputCostPer1M: null,
        outputCostPer1M: null,
      },
    };
    assert.throws(
      () => estimateSolvePolicyReservation({ policy: invalid, prompt: "Solve." }),
      (error) => error.code === "SERVER_CONFIG_ERROR" && error.statusCode === 500,
    );
  });
});
