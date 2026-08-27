import assert from "node:assert/strict";
import test from "node:test";
import {
  ORCHESTRATION_POLICY_VERSION,
  createSolveOrchestrationTelemetry,
  resolveSolveTelemetryBuildVersion,
} from "../server/solveOrchestrationTelemetry.js";

test("stage and summary emissions carry UTC timestamps and one stable solve cohort", () => {
  const originalInfo = console.info;
  const emissions = [];
  console.info = (label, payload) => emissions.push({ label, payload });

  try {
    const telemetry = createSolveOrchestrationTelemetry({
      requestId: "cohort-telemetry",
      endpoint: "/api/solve-extracted-problem",
      cohort: {
        orchestrationPolicyVersion: ORCHESTRATION_POLICY_VERSION,
        buildVersion: "build-test-123",
        buildVersionSource: "OMNIMATH_BUILD_ID",
      },
      timestampNow: () => new Date("2026-08-11T23:04:12.345Z"),
    });
    telemetry.recordGenerationAttempt({
      generationStage: "initial",
      candidateProduced: true,
      totalTokens: 1,
    });
    telemetry.recordCandidateSelection();
    const summary = telemetry.finalize({ finalOutcome: "success", finalGenerationStage: "initial" });

    assert.equal(emissions.length, 2);
    assert.equal(emissions[0].payload.eventTimestamp, "2026-08-11T23:04:12.345Z");
    assert.equal(emissions[1].payload.eventTimestamp, "2026-08-11T23:04:12.345Z");
    for (const { payload } of emissions) {
      assert.equal(payload.orchestrationPolicyVersion, "structural-accept-v1");
      assert.equal(payload.buildVersion, "build-test-123");
      assert.equal(payload.buildVersionSource, "OMNIMATH_BUILD_ID");
    }
    assert.equal(summary.orchestrationPolicyVersion, emissions[0].payload.orchestrationPolicyVersion);
    assert.equal(summary.buildVersion, emissions[0].payload.buildVersion);
    assert.equal(emissions[0].payload.providerResponseOutcome, "success");
    assert.equal(emissions[0].payload.parsedCandidateProduced, true);
    assert.equal(emissions[0].payload.structuralParseOutcome, "passed");
    assert.equal(emissions[0].payload.selectedForFinal, true);
    assert.equal(Object.hasOwn(emissions[0].payload, "validationOutcome"), false);
  } finally {
    console.info = originalInfo;
  }
});

test("build cohort resolution prefers explicit immutable deployment metadata", () => {
  assert.deepEqual(resolveSolveTelemetryBuildVersion({
    OMNIMATH_BUILD_ID: "release-2026-08-11",
    VERCEL_GIT_COMMIT_SHA: "lower-priority-sha",
  }), {
    buildVersion: "release-2026-08-11",
    buildVersionSource: "OMNIMATH_BUILD_ID",
  });
  assert.deepEqual(resolveSolveTelemetryBuildVersion({}), {
    buildVersion: "0.0.0",
    buildVersionSource: "package.json",
  });
});

test("solve orchestration telemetry is redacted and cannot throw into the solve path", () => {
  const originalInfo = console.info;
  console.info = (label) => {
    if (String(label).includes("solve-orchestration")) {
      throw new Error("simulated telemetry sink failure");
    }
  };

  try {
    const telemetry = createSolveOrchestrationTelemetry({
      requestId: "safe-telemetry",
      endpoint: "/api/solve-extracted-problem",
      startedAt: Date.now(),
    });
    assert.doesNotThrow(() => telemetry.recordGenerationAttempt({
      generationStage: "initial",
      modelRole: "solver",
      model: "test-model",
      solveMode: "initial",
      candidateProduced: true,
      inputTokens: 10,
      visibleOutputTokens: 8,
      reasoningTokens: 2,
      totalTokens: 20,
      httpAttemptCount: 1,
      estimatedCostUsd: 0.001,
      prompt: "must not be recorded",
      generatedSolution: "must not be recorded",
      authorization: "Bearer must-not-be-recorded",
    }));
    assert.doesNotThrow(() => telemetry.recordCandidateSelection());
    let summary;
    assert.doesNotThrow(() => {
      summary = telemetry.finalize({
        finalOutcome: "success",
        finalGenerationStage: "initial",
      });
    });
    assert.equal(summary.generationCount, 1);
    assert.equal(summary.totalTokens, 20);
    assert.equal(summary.finalOutcome, "success");
    assert.equal(JSON.stringify(summary).includes("must-not-be-recorded"), false);
  } finally {
    console.info = originalInfo;
  }
});
