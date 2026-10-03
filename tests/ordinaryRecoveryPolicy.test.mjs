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

  it("retries one owned provider-attempt timeout when recovery is eligible", () => {
    const result = decide({
      code: "AI_SOLVE_TIMEOUT",
      responseFailureType: "request_timeout",
      timeoutSource: "provider_attempt_timeout",
      timeoutScope: "model_request",
    }, { recoveryEligible: true });

    assert.deepEqual(result, {
      action: "retry",
      reason: "provider_attempt_timeout_recovery",
      classification: "request_timeout",
    });
  });

  it("keeps unowned timeout and transport failures terminal", () => {
    const timeout = decide({ responseFailureType: "request_timeout" }, { recoveryEligible: true });
    assert.equal(timeout.action, "fail");
    assert.equal(timeout.reason, "unowned_request_timeout");

    const transport = decide({ code: "AI_SERVICE_UNAVAILABLE" });
    assert.equal(transport.classification, "transport_or_provider_failure");
    assert.equal(transport.action, "fail");
    assert.equal(transport.reason, "transport_or_provider_failure");
  });

  it("does not recover a provider timeout after cancellation or canonical expiry", () => {
    const cancelled = decide({
      name: "AbortError",
      timeoutSource: "upstream_abort",
      timeoutScope: "upstream",
    }, { recoveryEligible: true });
    assert.equal(cancelled.classification, "client_cancellation");
    assert.equal(cancelled.reason, "client_cancellation");

    const expired = decide({
      code: "AI_SOLVE_TIMEOUT",
      responseFailureType: "interactive_deadline_exceeded",
      timeoutSource: "total_solve_deadline",
      timeoutScope: "total_solve",
    }, { recoveryEligible: true, canonicalDeadlineRemaining: false });
    assert.equal(expired.classification, "total_solve_deadline");
    assert.equal(expired.reason, "total_solve_deadline");
  });

  it("does not recursively retry a final recovery timeout", () => {
    const result = decide({
      code: "AI_SOLVE_TIMEOUT",
      responseFailureType: "request_timeout",
      timeoutSource: "provider_attempt_timeout",
      timeoutScope: "model_request",
    }, { recoveryEligible: true, routeAttemptCount: ORDINARY_MAX_ROUTE_ATTEMPTS });
    assert.equal(result.action, "fail");
    assert.equal(result.reason, "recovery_attempt_limit");
  });

  it("requires timeout recovery eligibility, available recovery budget, and no usable candidate", () => {
    const error = {
      code: "AI_SOLVE_TIMEOUT",
      responseFailureType: "request_timeout",
      timeoutSource: "provider_attempt_timeout",
      timeoutScope: "model_request",
    };
    assert.equal(decide(error).reason, "recovery_not_eligible");
    assert.equal(decide(error, {
      recoveryEligible: true,
      recoveryBudgetRemaining: false,
    }).reason, "insufficient_recovery_budget");
    assert.equal(decide(error, {
      recoveryEligible: true,
      usableCandidateExists: true,
    }).reason, "usable_candidate_exists");
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
