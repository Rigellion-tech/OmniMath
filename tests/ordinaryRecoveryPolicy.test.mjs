import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildModelExecutionConfig } from "../server/modelExecutionConfig.js";
import {
  classifyOrdinarySolveFailure,
  decideOrdinaryRecovery,
  ORDINARY_MAX_ROUTE_ATTEMPTS,
} from "../server/ordinaryRecoveryPolicy.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(ORIGINAL_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

function configs({ duplicate = false } = {}) {
  process.env.OMNIMATH_SOLVER_REASONING_EFFORT = "medium";
  process.env.OMNIMATH_ESCALATION_REASONING_EFFORT = duplicate ? "medium" : "high";
  const initialConfig = buildModelExecutionConfig({
    modelPath: "solver",
    model: "gpt-5.6-sol",
    responseMode: "json_schema",
    structuredOutputPolicy: "strict",
    recoveryPurpose: "initial",
    promptStrategy: "canonical",
    maxOutputTokens: 6500,
  });
  let escalationConfig = buildModelExecutionConfig({
    modelPath: "escalation",
    model: "gpt-5.6-sol",
    responseMode: "json_schema",
    structuredOutputPolicy: "strict",
    recoveryPurpose: "structured_output_recovery",
    promptStrategy: "canonical",
    maxOutputTokens: 6500,
  });
  if (duplicate) {
    escalationConfig = {
      ...initialConfig,
      role: "escalation",
      modelPath: "escalation",
      recoveryPurpose: "structured_output_recovery",
    };
  }
  return { initialConfig, escalationConfig };
}

function decide(error, overrides = {}) {
  return decideOrdinaryRecovery({
    error,
    routeAttemptCount: 1,
    escalationAttempted: false,
    deadlineRemaining: true,
    ...configs(),
    ...overrides,
  });
}

describe("ordinary structured-output recovery", () => {
  for (const responseFailureType of [
    "json_parse",
    "empty_response",
    "truncated",
    "schema_contract",
    "field_structure",
    "generated_validation",
  ]) {
    it(`${responseFailureType} has one bounded meaningful escalation`, () => {
      const result = decide({ responseFailureType });

      assert.equal(result.classification, "structured_output_failure");
      assert.equal(result.action, "escalate");
      assert.equal(result.reason, "structured_output_recovery");
      assert.equal(ORDINARY_MAX_ROUTE_ATTEMPTS, 2);
    });
  }

  it("treats provider refusal as an explicit terminal outcome", () => {
    const error = { code: "AI_REQUEST_REFUSED", responseFailureType: "refusal" };
    assert.equal(classifyOrdinarySolveFailure(error), "refusal");
    assert.deepEqual(decide(error), {
      action: "fail",
      reason: "refusal",
      classification: "refusal",
    });
  });

  it("does not use semantic recovery for timeout or transport failures", () => {
    for (const [error, classification] of [
      [{ responseFailureType: "request_timeout" }, "request_timeout"],
      [{ code: "AI_SERVICE_UNAVAILABLE" }, "transport_or_provider_failure"],
    ]) {
      const result = decide(error);
      assert.equal(result.classification, classification);
      assert.equal(result.action, "fail");
      assert.equal(result.reason, classification);
    }
  });

  it("suppresses escalation when the effective escalation config is identical", () => {
    const result = decide(
      { responseFailureType: "json_parse" },
      configs({ duplicate: true }),
    );

    assert.equal(result.action, "fail");
    assert.equal(result.reason, "duplicate_execution_configuration");
  });

  it("stops after the maximum route attempt count", () => {
    const result = decide(
      { responseFailureType: "json_parse" },
      { routeAttemptCount: ORDINARY_MAX_ROUTE_ATTEMPTS },
    );

    assert.equal(result.action, "fail");
    assert.equal(result.reason, "recovery_attempt_limit");
  });

  it("stops recovery when the logical solve deadline is exhausted", () => {
    const result = decide(
      { responseFailureType: "json_parse" },
      { deadlineRemaining: false },
    );

    assert.equal(result.action, "fail");
    assert.equal(result.reason, "total_solve_deadline");
  });
});
