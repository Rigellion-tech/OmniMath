import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildResponsesModelParameters,
  estimateModelCostUsd,
  getModelCapability,
  getOpenAiModelResolutions,
  getOpenAiModels,
  getOpenAiTimeoutPolicy,
  resolveOpenAiRequestTimeout,
  selectOpenAiModel,
} from "../server/openaiModels.js";
import { estimateOpenAiCost } from "../server/openai.js";

const ENV_KEYS = [
  "OPENAI_MODEL",
  "OPENAI_IMAGE_EXTRACTION_MODEL",
  "OPENAI_SOLVER_MODEL",
  "OPENAI_REPAIR_MODEL",
  "OPENAI_ESCALATION_MODEL",
  "OPENAI_PREMIUM_ESCALATION_MODEL",
  "OPENAI_LAZY_MODEL",
  "OMNIMATH_IMAGE_EXTRACTION_MODEL",
  "OMNIMATH_SOLVER_MODEL",
  "OMNIMATH_SOLVER_REASONING_EFFORT",
  "OMNIMATH_REPAIR_MODEL",
  "OMNIMATH_REPAIR_REASONING_EFFORT",
  "OMNIMATH_ESCALATION_MODEL",
  "OMNIMATH_ESCALATION_REASONING_EFFORT",
  "OMNIMATH_PREMIUM_ESCALATION_MODEL",
  "OMNIMATH_PREMIUM_ESCALATION_REASONING_EFFORT",
  "OMNIMATH_MODEL_O4_MINI_INPUT_COST_PER_1M",
  "OMNIMATH_MODEL_O4_MINI_OUTPUT_COST_PER_1M",
  "OMNIMATH_MODEL_GPT_4_1_MINI_INPUT_COST_PER_1M",
  "OMNIMATH_MODEL_GPT_4_1_MINI_OUTPUT_COST_PER_1M",
  "OMNIMATH_DEFAULT_INPUT_COST_PER_1M_TOKENS",
  "OMNIMATH_DEFAULT_OUTPUT_COST_PER_1M_TOKENS",
  "OPENAI_REQUEST_TIMEOUT_MS",
  "OMNIMATH_OPENAI_SOLVER_TIMEOUT_MS",
  "OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS",
  "OMNIMATH_OPENAI_ESCALATION_TIMEOUT_MS",
  "OMNIMATH_OPENAI_PREMIUM_ESCALATION_TIMEOUT_MS",
  "OMNIMATH_OPENAI_IMAGE_EXTRACTION_TIMEOUT_MS",
  "OMNIMATH_OPENAI_EXTRACTION_REVIEW_TIMEOUT_MS",
  "OMNIMATH_OPENAI_LAZY_TIMEOUT_MS",
];

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

afterEach(() => restoreEnv());

describe("OpenAI model capabilities", () => {
  it("uses current role defaults without resolving solver from OPENAI_MODEL", () => {
    clearEnv();
    process.env.OPENAI_MODEL = "gpt-4.1-mini";

    const models = getOpenAiModels();
    const selection = selectOpenAiModel({ modelPath: "solver", debugContext: { attemptType: "initial" } });

    assert.equal(models.solver, "gpt-5.6-luna");
    assert.equal(selection.modelId, "gpt-5.6-luna");
    assert.equal(selection.modelSource, "role_default");
  });

  it("lets the explicit solver role variable win", () => {
    clearEnv();
    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    process.env.OPENAI_SOLVER_MODEL = "gpt-5.5";
    process.env.OMNIMATH_SOLVER_MODEL = "gpt-5.6-terra";

    const selection = selectOpenAiModel({ modelPath: "solver", debugContext: { attemptType: "initial" } });

    assert.equal(selection.modelId, "gpt-5.6-terra");
    assert.equal(selection.modelSource, "OMNIMATH_SOLVER_MODEL");
  });

  it("lets the explicit repair role variable win", () => {
    clearEnv();
    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    process.env.OMNIMATH_SOLVER_MODEL = "gpt-5.6-luna";
    process.env.OPENAI_REPAIR_MODEL = "gpt-5.5";
    process.env.OMNIMATH_REPAIR_MODEL = "gpt-5.6-terra";

    const selection = selectOpenAiModel({ modelPath: "solver", debugContext: { attemptType: "repair" } });

    assert.equal(selection.modelId, "gpt-5.6-terra");
    assert.equal(selection.modelSource, "OMNIMATH_REPAIR_MODEL");
  });

  it("does not let repair inherit obsolete OPENAI_MODEL", () => {
    clearEnv();
    process.env.OPENAI_MODEL = "gpt-4.1-mini";

    const models = getOpenAiModels();
    const selection = selectOpenAiModel({ modelPath: "solver", debugContext: { attemptType: "repair" } });

    assert.equal(models.repair, "gpt-5.6-terra");
    assert.equal(selection.modelId, "gpt-5.6-terra");
    assert.equal(selection.modelSource, "role_default");
  });

  it("lets repair inherit only an explicitly configured solver role model", () => {
    clearEnv();
    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    process.env.OPENAI_SOLVER_MODEL = "gpt-5.6-luna";

    const selection = selectOpenAiModel({ modelPath: "solver", debugContext: { attemptType: "repair" } });

    assert.equal(selection.modelId, "gpt-5.6-luna");
    assert.equal(selection.modelSource, "OPENAI_SOLVER_MODEL:role_fallback");
  });

  it("resolves escalation independently from solver and legacy OPENAI_MODEL", () => {
    clearEnv();
    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    process.env.OMNIMATH_SOLVER_MODEL = "gpt-5.6-luna";
    process.env.OPENAI_ESCALATION_MODEL = "gpt-5.5-pro";
    process.env.OMNIMATH_ESCALATION_MODEL = "gpt-5.6-sol";

    const selection = selectOpenAiModel({ modelPath: "escalation", debugContext: { attemptType: "escalation" } });

    assert.equal(selection.modelId, "gpt-5.6-sol");
    assert.equal(selection.modelSource, "OMNIMATH_ESCALATION_MODEL");
  });

  it("uses premium escalation variables before escalation variables and premium default", () => {
    clearEnv();
    process.env.OMNIMATH_ESCALATION_MODEL = "gpt-5.6-terra";
    process.env.OPENAI_PREMIUM_ESCALATION_MODEL = "gpt-5.5-pro";
    process.env.OMNIMATH_PREMIUM_ESCALATION_MODEL = "gpt-5.6-sol";

    const selection = selectOpenAiModel({ modelPath: "premiumEscalation" });

    assert.equal(selection.modelId, "gpt-5.6-sol");
    assert.equal(selection.modelSource, "OMNIMATH_PREMIUM_ESCALATION_MODEL");
  });

  it("falls back from premium escalation role variables to escalation role variables", () => {
    clearEnv();
    process.env.OPENAI_ESCALATION_MODEL = "gpt-5.5-pro";
    process.env.OMNIMATH_ESCALATION_MODEL = "gpt-5.6-sol";

    const selection = selectOpenAiModel({ modelPath: "premiumEscalation" });

    assert.equal(selection.modelId, "gpt-5.6-sol");
    assert.equal(selection.modelSource, "OMNIMATH_ESCALATION_MODEL");
  });

  it("matches image extraction resolution and diagnostics", () => {
    clearEnv();
    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    process.env.OPENAI_IMAGE_EXTRACTION_MODEL = "gpt-4.1";

    const models = getOpenAiModels();
    const resolutions = getOpenAiModelResolutions();
    const selection = selectOpenAiModel({ modelPath: "imageExtraction" });

    assert.equal(models.imageExtraction, "gpt-4.1");
    assert.equal(selection.modelId, "gpt-4.1");
    assert.equal(selection.modelSource, "OPENAI_IMAGE_EXTRACTION_MODEL");
    assert.deepEqual(resolutions.imageExtraction, {
      modelId: "gpt-4.1",
      modelSource: "OPENAI_IMAGE_EXTRACTION_MODEL",
    });
  });

  it("classifies legacy GPT solver models as structured-output models with sampling", () => {
    const capability = getModelCapability("gpt-4.1-mini");

    assert.equal(capability.reasoning, false);
    assert.deepEqual(capability.reasoningEfforts, []);
    assert.equal(capability.allowSampling, true);
    assert.equal(capability.structuredOutput, true);
  });

  it("classifies current o-series reasoning models without sampling", () => {
    const selection = selectOpenAiModel({
      modelPath: "solver",
      model: "o4-mini",
      debugContext: { attemptType: "initial" },
    });
    const params = buildResponsesModelParameters(selection);

    assert.equal(selection.supportsReasoning, true);
    assert.deepEqual(selection.supportedReasoningEfforts, ["low", "medium", "high"]);
    assert.equal(selection.reasoningEffort, "medium");
    assert.equal(selection.samplingOmitted, true);
    assert.deepEqual(params, { reasoning: { effort: "medium" } });
  });

  it("omits unsupported reasoning efforts instead of sending invalid parameters", () => {
    clearEnv();
    process.env.OMNIMATH_SOLVER_REASONING_EFFORT = "xhigh";

    const selection = selectOpenAiModel({
      modelPath: "solver",
      model: "o4-mini",
      debugContext: { attemptType: "initial" },
    });
    const params = buildResponsesModelParameters(selection);

    assert.equal(selection.reasoningEffort, null);
    assert.equal(selection.requestedReasoningEffort, "xhigh");
    assert.equal(selection.reasoningOmittedReason, "unsupported_reasoning_effort");
    assert.equal(params.reasoning, undefined);
    assert.equal(params.temperature, undefined);
    assert.equal(params.top_p, undefined);
  });

  it("omits reasoning for non-reasoning models even when effort is configured", () => {
    clearEnv();
    process.env.OMNIMATH_SOLVER_REASONING_EFFORT = "high";

    const selection = selectOpenAiModel({
      modelPath: "solver",
      model: "gpt-4.1-mini",
      debugContext: { attemptType: "initial" },
    });
    const params = buildResponsesModelParameters(selection);

    assert.equal(selection.supportsReasoning, false);
    assert.equal(selection.reasoningEffort, null);
    assert.equal(selection.reasoningOmittedReason, "model_does_not_support_reasoning");
    assert.equal(params.reasoning, undefined);
    assert.equal(params.temperature, 0);
    assert.equal(params.top_p, 1);
  });

  it("uses role-specific env configuration for initial, repair, and escalation", () => {
    clearEnv();
    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    process.env.OMNIMATH_SOLVER_MODEL = "gpt-5.6-luna";
    process.env.OMNIMATH_REPAIR_MODEL = "o4-mini";
    process.env.OMNIMATH_REPAIR_REASONING_EFFORT = "high";
    process.env.OMNIMATH_ESCALATION_MODEL = "o3";

    const models = getOpenAiModels();
    const initial = selectOpenAiModel({ modelPath: "solver", debugContext: { attemptType: "initial" } });
    const repair = selectOpenAiModel({ modelPath: "solver", debugContext: { attemptType: "repair" } });
    const escalation = selectOpenAiModel({ modelPath: "escalation", debugContext: { attemptType: "escalation" } });

    assert.equal(models.solver, "gpt-5.6-luna");
    assert.equal(models.repair, "o4-mini");
    assert.equal(initial.modelId, "gpt-5.6-luna");
    assert.equal(repair.modelId, "o4-mini");
    assert.equal(repair.reasoningEffort, "high");
    assert.equal(escalation.modelId, "o3");
    assert.equal(escalation.freshSolve, true);
  });

  it("falls back predictably for unknown models", () => {
    const selection = selectOpenAiModel({
      modelPath: "solver",
      model: "custom-test-model",
      debugContext: { attemptType: "initial" },
    });

    assert.equal(selection.knownModel, false);
    assert.equal(selection.supportsReasoning, false);
    assert.equal(selection.allowSampling, true);
    assert.deepEqual(buildResponsesModelParameters(selection), { temperature: 0, top_p: 1 });
  });

  it("calculates configurable model-specific prices", () => {
    clearEnv();
    process.env.OMNIMATH_MODEL_O4_MINI_INPUT_COST_PER_1M = "1";
    process.env.OMNIMATH_MODEL_O4_MINI_OUTPUT_COST_PER_1M = "4";

    const cost = estimateModelCostUsd("o4-mini", {
      input_tokens: 1000,
      output_tokens: 2000,
      output_tokens_details: { reasoning_tokens: 500 },
    });

    assert.ok(Math.abs(cost - 0.009) < 1e-12);
  });

  it("calculates mixed-model usage prices from per-call provenance", () => {
    clearEnv();
    process.env.OMNIMATH_MODEL_GPT_4_1_MINI_INPUT_COST_PER_1M = "1";
    process.env.OMNIMATH_MODEL_GPT_4_1_MINI_OUTPUT_COST_PER_1M = "2";
    process.env.OMNIMATH_MODEL_O4_MINI_INPUT_COST_PER_1M = "3";
    process.env.OMNIMATH_MODEL_O4_MINI_OUTPUT_COST_PER_1M = "4";

    const cost = estimateOpenAiCost({
      _omni_model_usage: [
        { model: "gpt-4.1-mini", input_tokens: 1000, output_tokens: 2000 },
        { model: "o4-mini", input_tokens: 1000, output_tokens: 2000 },
      ],
    });

    assert.ok(Math.abs(cost - 0.016) < 1e-12);
  });
});

describe("OpenAI role-specific request deadlines", () => {
  it("uses the solver deadline for initial and compact solver attempts", () => {
    clearEnv();

    const initial = selectOpenAiModel({
      modelPath: "solver",
      debugContext: { attemptType: "initial" },
    });
    const compact = selectOpenAiModel({
      modelPath: "solver",
      debugContext: { attemptType: "initial-compact", retryPurpose: "compact" },
    });

    assert.equal(initial.role, "solver");
    assert.equal(initial.timeoutMs, 60000);
    assert.equal(compact.role, "solver");
    assert.equal(compact.timeoutMs, 60000);
    assert.equal(compact.timeoutSource, "role_default");
  });

  it("uses the repair deadline when modelPath remains solver", () => {
    clearEnv();

    const selection = selectOpenAiModel({
      modelPath: "solver",
      debugContext: { retryPurpose: "quality-repair" },
    });

    assert.equal(selection.role, "repair");
    assert.equal(selection.timeoutMs, 120000);
  });

  it("uses the escalation deadline for structural and mathematical recovery", () => {
    clearEnv();

    const selection = selectOpenAiModel({
      modelPath: "escalation",
      debugContext: { attemptType: "escalation" },
    });

    assert.equal(selection.role, "escalation");
    assert.equal(selection.timeoutMs, 180000);
  });

  it("uses the premium-escalation deadline independently", () => {
    clearEnv();

    const selection = selectOpenAiModel({ modelPath: "premiumEscalation" });

    assert.equal(selection.role, "premiumEscalation");
    assert.equal(selection.timeoutMs, 180000);
  });

  it("uses image deadlines for extraction and extraction review", () => {
    clearEnv();

    const extraction = selectOpenAiModel({ modelPath: "imageExtraction" });
    const review = selectOpenAiModel({ modelPath: "extractionReview" });

    assert.equal(extraction.role, "imageExtraction");
    assert.equal(extraction.timeoutMs, 60000);
    assert.equal(review.role, "extractionReview");
    assert.equal(review.timeoutMs, 60000);
  });

  it("uses the shared lazy deadline for hover and pinned explanations", () => {
    clearEnv();

    const hover = selectOpenAiModel({ modelPath: "hover" });
    const pinned = selectOpenAiModel({ modelPath: "pinned" });

    assert.equal(hover.timeoutMs, 30000);
    assert.equal(pinned.timeoutMs, 30000);
    assert.equal(hover.timeoutEnv, "OMNIMATH_OPENAI_LAZY_TIMEOUT_MS");
    assert.equal(pinned.timeoutEnv, "OMNIMATH_OPENAI_LAZY_TIMEOUT_MS");
  });

  it("uses role configuration and reports it in the timeout policy", () => {
    clearEnv();
    process.env.OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS = "90000";

    const resolution = resolveOpenAiRequestTimeout("repair");
    const policy = getOpenAiTimeoutPolicy();

    assert.equal(resolution.timeoutMs, 90000);
    assert.equal(resolution.timeoutSource, "OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS");
    assert.equal(resolution.timeoutConfigStatus, "configured");
    assert.equal(policy.roles.repair.timeoutMs, 90000);
    assert.equal(policy.compactRetryPolicy, "inherits_resolved_role");
  });

  it("falls back for invalid, negative, zero, and nonnumeric values", () => {
    clearEnv();

    for (const value of ["Infinity", "-1", "0", "not-a-number"]) {
      process.env.OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS = value;
      const resolution = resolveOpenAiRequestTimeout("repair");
      assert.equal(resolution.timeoutMs, 120000, value);
      assert.equal(resolution.timeoutSource, "role_default", value);
      assert.equal(resolution.timeoutConfigStatus, "invalid_fallback", value);
    }
  });

  it("clamps positive configured values to the documented range", () => {
    clearEnv();
    process.env.OMNIMATH_OPENAI_SOLVER_TIMEOUT_MS = "1";
    assert.deepEqual(
      {
        timeoutMs: resolveOpenAiRequestTimeout("solver").timeoutMs,
        status: resolveOpenAiRequestTimeout("solver").timeoutConfigStatus,
      },
      { timeoutMs: 5000, status: "clamped_min" },
    );

    process.env.OMNIMATH_OPENAI_SOLVER_TIMEOUT_MS = "999999";
    assert.deepEqual(
      {
        timeoutMs: resolveOpenAiRequestTimeout("solver").timeoutMs,
        status: resolveOpenAiRequestTimeout("solver").timeoutConfigStatus,
      },
      { timeoutMs: 300000, status: "clamped_max" },
    );
  });

  it("does not apply the legacy blanket timeout to role deadlines", () => {
    clearEnv();
    process.env.OPENAI_REQUEST_TIMEOUT_MS = "15000";

    const policy = getOpenAiTimeoutPolicy();

    assert.equal(resolveOpenAiRequestTimeout("repair").timeoutMs, 120000);
    assert.equal(policy.legacyRequestTimeoutConfigured, true);
  });
});
