import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProgressiveCanaryFiles, analyzeProgressiveCanaryEvents, parseProgressiveCanaryText } from "../scripts/analyze-progressive-canary.mjs";

const fixture = new URL("./fixtures/telemetry/progressive-canary.txt", import.meta.url);

test("progressive canary analyzer aggregates recoveries while preserving unknown telemetry", async () => {
  const report = await analyzeProgressiveCanaryFiles([fixture.pathname]);
  assert.equal(report.solveCount, 2);
  assert.equal(report.records[0].firstAttemptSuccess, false);
  assert.equal(report.records[0].initialModel, "model-start");
  assert.equal(report.records[0].finalModel, "model-final");
  assert.equal(report.records[0].providerCalls, 3);
  assert.equal(report.records[0].recoveryDurationMs, 1100);
  assert.equal(report.records[0].firstValidatedStepMs, 2400);
  assert.equal(report.records[0].totalLatencyMs, 5200);
  assert.equal(report.records[0].usageTokens, 310);
  assert.equal(report.records[0].costUsd, 0.031);
  assert.equal(report.records[1].partialFailure, true);
  assert.equal(report.records[1].firstValidatedStepMs, null);
  assert.equal(report.records[1].costUsd, null);
  assert.deepEqual(report.totals.providerCalls, { knownCount: 2, unknownCount: 0, total: 4, average: 2 });
  assert.equal(report.totals.firstAttemptSuccess.rate, 0.5);
  assert.equal(report.totals.escalations, 1);
  assert.equal(report.totals.unknownPartialFailure, 0);
});

test("parser handles Node inspected records and reports malformed records", () => {
  const parsed = parseProgressiveCanaryText(`[omnimath:progressive-recovery] { "requestId": "x", "providerAttemptIndex": 1, "decision": "repair" }\n[omnimath:progressive-terminal] no structured payload`);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].payload.decision, "repair");
  assert.equal(parsed.malformedEvents, 1);
});

test("missing and unidentified measurements remain unknown", () => {
  const report = analyzeProgressiveCanaryEvents([
    { type: "terminal", payload: { requestId: "unknown", terminalReason: "completed" } },
    { type: "terminal", payload: { terminalReason: "completed" } },
  ]);
  assert.equal(report.records[0].providerCalls, null);
  assert.equal(report.records[0].totalLatencyMs, null);
  assert.equal(report.records[0].firstAttemptSuccess, null);
  assert.equal(report.totals.providerCalls.unknownCount, 1);
  assert.equal(report.unidentifiedEvents, 1);
});
