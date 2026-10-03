import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  areModelExecutionConfigsExactlyEqual,
  areModelExecutionConfigsMateriallyEqual,
  buildModelExecutionConfig,
  getModelExecutionConfigIdentity,
  isMateriallyDifferentModelExecutionConfig,
  isMeaningfullyDifferentEscalationConfig,
} from "../server/modelExecutionConfig.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(ORIGINAL_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

function build(overrides = {}) {
  return buildModelExecutionConfig({
    modelPath: "solver",
    model: "gpt-5.6-sol",
    responseMode: "json_schema",
    structuredOutputPolicy: "strict",
    recoveryPurpose: "initial",
    maxOutputTokens: 6500,
    promptStrategy: "canonical",
    ...overrides,
  });
}

describe("model execution configuration identity", () => {
  it("snapshots the selected execution configuration", () => {
    const config = build();

    assert.deepEqual(
      {
        requestedModel: config.requestedModel,
        effectiveModel: config.effectiveModel,
        role: config.role,
        reasoningEffort: config.reasoningEffort,
        timeoutMs: config.timeoutMs,
        responseMode: config.responseMode,
        structuredOutputPolicy: config.structuredOutputPolicy,
        modelPath: config.modelPath,
        recoveryPurpose: config.recoveryPurpose,
        promptStrategy: config.promptStrategy,
        maxOutputTokens: config.maxOutputTokens,
      },
      {
        requestedModel: "gpt-5.6-sol",
        effectiveModel: "gpt-5.6-sol",
        role: "solver",
        reasoningEffort: "medium",
        timeoutMs: 90000,
        responseMode: "json_schema",
        structuredOutputPolicy: "strict",
        modelPath: "solver",
        recoveryPurpose: "initial",
        promptStrategy: "canonical",
        maxOutputTokens: 6500,
      },
    );
    assert.equal(config.identity, getModelExecutionConfigIdentity(config));
  });

  it("treats the same model at medium and high reasoning as materially different", () => {
    process.env.OMNIMATH_SOLVER_REASONING_EFFORT = "medium";
    const medium = build();
    process.env.OMNIMATH_SOLVER_REASONING_EFFORT = "high";
    const high = build();

    assert.equal(medium.effectiveModel, high.effectiveModel);
    assert.equal(medium.reasoningEffort, "medium");
    assert.equal(high.reasoningEffort, "high");
    assert.equal(isMateriallyDifferentModelExecutionConfig(medium, high), true);
    assert.equal(isMeaningfullyDifferentEscalationConfig(medium, high), true);
  });

  it("allows Sol-medium to Sol-high as a meaningful escalation", () => {
    process.env.OMNIMATH_SOLVER_REASONING_EFFORT = "medium";
    process.env.OMNIMATH_ESCALATION_REASONING_EFFORT = "high";
    const initial = build({ modelPath: "solver", recoveryPurpose: "initial" });
    const escalation = build({ modelPath: "escalation", recoveryPurpose: "quality_escalation" });

    assert.equal(initial.effectiveModel, escalation.effectiveModel);
    assert.equal(initial.reasoningEffort, "medium");
    assert.equal(escalation.reasoningEffort, "high");
    assert.equal(isMeaningfullyDifferentEscalationConfig(initial, escalation), true);
  });

  it("suppresses escalation to an identical Sol-high configuration", () => {
    process.env.OMNIMATH_ESCALATION_REASONING_EFFORT = "high";
    const initial = build({ modelPath: "escalation", recoveryPurpose: "first_attempt" });
    const duplicate = build({ modelPath: "escalation", recoveryPurpose: "second_attempt" });

    assert.equal(initial.effectiveModel, duplicate.effectiveModel);
    assert.equal(initial.reasoningEffort, "high");
    assert.equal(duplicate.reasoningEffort, "high");
    assert.equal(isMeaningfullyDifferentEscalationConfig(initial, duplicate), false);
  });

  it("recognizes independently built identical configurations", () => {
    const first = build();
    const second = build();

    assert.equal(areModelExecutionConfigsExactlyEqual(first, second), true);
    assert.equal(areModelExecutionConfigsMateriallyEqual(first, second), true);
    assert.equal(first.identity, second.identity);
    assert.equal(first.materialIdentity, second.materialIdentity);
  });

  for (const fixture of [
    ["response mode", "responseMode", "plain_text"],
    ["timeout", "timeoutMs", 120000],
    ["structured-output policy", "structuredOutputPolicy", "best_effort"],
    ["prompt strategy", "promptStrategy", "compact_repair"],
    ["output token budget", "maxOutputTokens", 7000],
  ]) {
    it(`includes ${fixture[0]} in material identity`, () => {
      const initial = build();
      const changed = { ...initial, [fixture[1]]: fixture[2] };

      assert.equal(areModelExecutionConfigsMateriallyEqual(initial, changed), false);
    });
  }

  for (const fixture of [
    ["role", "role", "repair"],
    ["recovery purpose", "recoveryPurpose", "malformed_json"],
  ]) {
    it(`keeps ${fixture[0]} in exact identity but out of material identity`, () => {
      const initial = build();
      const relabeled = { ...initial, [fixture[1]]: fixture[2] };

      assert.equal(areModelExecutionConfigsExactlyEqual(initial, relabeled), false);
      assert.equal(areModelExecutionConfigsMateriallyEqual(initial, relabeled), true);
      assert.equal(isMeaningfullyDifferentEscalationConfig(initial, relabeled), false);
    });
  }

  it("canonicalizes structured policy objects for stable identity", () => {
    const first = build({
      structuredOutputPolicy: { schema: "solution", strict: true },
    });
    const second = build({
      structuredOutputPolicy: { strict: true, schema: "solution" },
    });

    assert.equal(areModelExecutionConfigsExactlyEqual(first, second), true);
  });

  it("distinguishes exact route identity from equivalent effective execution", () => {
    const solverPath = build({ modelPath: "solver" });
    const canonicalPath = build({ modelPath: "canonicalSolve" });

    assert.equal(areModelExecutionConfigsExactlyEqual(solverPath, canonicalPath), false);
    assert.equal(areModelExecutionConfigsMateriallyEqual(solverPath, canonicalPath), true);
  });
});
