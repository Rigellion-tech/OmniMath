import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildResponsesModelParameters,
  estimateModelCostUsd,
  getModelCapability,
  getOpenAiModels,
  selectOpenAiModel,
} from "../server/openaiModels.js";
import { estimateOpenAiCost } from "../server/openai.js";

const ENV_KEYS = [
  "OPENAI_MODEL",
  "OPENAI_SOLVER_MODEL",
  "OPENAI_REPAIR_MODEL",
  "OPENAI_ESCALATION_MODEL",
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
    process.env.OMNIMATH_REPAIR_MODEL = "o4-mini";
    process.env.OMNIMATH_REPAIR_REASONING_EFFORT = "high";
    process.env.OMNIMATH_ESCALATION_MODEL = "o3";

    const models = getOpenAiModels();
    const initial = selectOpenAiModel({ modelPath: "solver", debugContext: { attemptType: "initial" } });
    const repair = selectOpenAiModel({ modelPath: "solver", debugContext: { attemptType: "repair" } });
    const escalation = selectOpenAiModel({ modelPath: "escalation", debugContext: { attemptType: "escalation" } });

    assert.equal(models.solver, "gpt-4.1-mini");
    assert.equal(models.repair, "o4-mini");
    assert.equal(initial.modelId, "gpt-4.1-mini");
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
