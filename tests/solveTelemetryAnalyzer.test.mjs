import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  analyzeTelemetryEvents,
  analyzeTelemetryFiles,
  deduplicateTelemetryEvents,
  parseCliArguments,
  parseTelemetryText,
  renderConsoleReport,
} from "../scripts/analyze-solve-telemetry.mjs";

const fixtureUrl = new URL("./fixtures/telemetry/solve-orchestration-synthetic.txt", import.meta.url);
const cohortFixtureUrl = new URL("./fixtures/telemetry/solve-orchestration-cohorts.txt", import.meta.url);

test("fixture report covers every reviewed orchestration path and explicit policy rate", async () => {
  const report = await analyzeTelemetryFiles([fixtureUrl.pathname]);

  assert.deepEqual(report.overall.solveVolume, {
    totalSolves: 10,
    successfulSolves: 6,
    presentationDegradedAccepts: 1,
    fallbackReturns: 1,
    hardFailures: 2,
    otherOutcomes: 0,
  });
  assert.equal(report.overall.providerBehavior.generations.average, 2.6);
  assert.equal(report.overall.providerBehavior.generations.p50, 2);
  assert.equal(report.overall.providerBehavior.generations.p95, 4);
  assert.equal(report.overall.providerBehavior.generations.max, 4);
  assert.equal(report.overall.providerBehavior.httpAttempts.average, 2.6);
  assert.equal(report.overall.latencyMs.knownCount, 9);
  assert.equal(report.overall.latencyMs.unknownCount, 1);
  assert.equal(report.overall.latencyMs.average, 2760 / 9);
  assert.equal(report.overall.tokens.total.total, 253);
  assert.equal(report.overall.tokens.total.unknownCount, 1);
  assert.ok(Math.abs(report.overall.estimatedCostUsd.total - 0.0253) < 1e-12);
  assert.equal(report.overall.estimatedCostUsd.unknownCount, 1);

  assert.deepEqual(
    Object.fromEntries(Object.entries(report.stages).map(([name, stage]) => [name, [stage.attemptCount, stage.rescueCount]])),
    {
      initial: [10, 2],
      initial_compact: [2, 1],
      quality_repair: [6, 1],
      quality_repair_compact: [3, 2],
      fresh_escalation: [4, 1],
      fresh_escalation_compact: [1, 1],
    },
  );

  assert.deepEqual(report.policyRates.initialCompactRetry, { count: 2, denominator: 10, rate: 0.2 });
  assert.deepEqual(report.policyRates.initialCompactRescue, { count: 1, denominator: 2, rate: 0.5 });
  assert.deepEqual(report.policyRates.qualityRepair, { count: 6, denominator: 10, rate: 0.6 });
  assert.deepEqual(report.policyRates.qualityRepairRescue, { count: 1, denominator: 6, rate: 1 / 6 });
  assert.deepEqual(report.policyRates.repairCompactRetry, { count: 3, denominator: 10, rate: 0.3 });
  assert.deepEqual(report.policyRates.repairCompactRescue, { count: 2, denominator: 3, rate: 2 / 3 });
  assert.deepEqual(report.policyRates.freshEscalation, { count: 4, denominator: 10, rate: 0.4 });
  assert.deepEqual(report.policyRates.freshEscalationRescue, { count: 1, denominator: 4, rate: 0.25 });
  assert.deepEqual(report.policyRates.escalationCompactRetry, { count: 1, denominator: 10, rate: 0.1 });
  assert.deepEqual(report.policyRates.escalationCompactRescue, { count: 1, denominator: 1, rate: 1 });
  assert.deepEqual(report.policyRates.policyDLateCompactSuppression, { count: 2, denominator: 10, rate: 0.2 });
  assert.deepEqual(report.policyRates.fallback, { count: 1, denominator: 10, rate: 0.1 });
  assert.deepEqual(report.policyRates.hardFailure, { count: 2, denominator: 10, rate: 0.2 });
  assert.deepEqual(report.breakdowns.failureClassification.response_generation_failure, {
    stageAttempts: 9,
    stageSolves: 6,
    finalFailures: 2,
  });
});

test("parser ignores unrelated lines, skips malformed records, and deduplicates only stable event identities", async () => {
  const text = await readFile(fixtureUrl, "utf8");
  const parsed = parseTelemetryText(text, { source: "synthetic" });
  const deduplicated = deduplicateTelemetryEvents(parsed.events);

  assert.equal(parsed.malformedEvents, 2);
  assert.equal(parsed.unrelatedLines, 1);
  assert.equal(deduplicated.duplicateStageEvents, 1);
  assert.equal(deduplicated.duplicateSummaryEvents, 1);
  assert.equal(deduplicated.stages.length, 26);
  assert.equal(deduplicated.summaries.length, 10);

  const anonymous = deduplicateTelemetryEvents([
    { type: "stage", payload: { generationStage: "initial", attemptIndex: 1 } },
    { type: "stage", payload: { generationStage: "initial", attemptIndex: 1 } },
  ]);
  assert.equal(anonymous.stages.length, 2, "events without a stable solve identity must not be collapsed");
});

test("parser accepts Node multi-line inspected objects and reports orphan stages from truncated logs", () => {
  const parsed = parseTelemetryText(`
unrelated prefix
[omnimath:solve-orchestration-stage] {
  requestId: 'node-format',
  solveId: 'node-format',
  endpoint: '/api/solve-extracted-problem',
  generationStage: 'initial',
  attemptIndex: 1,
  selectedForFinal: true,
  totalTokens: 12,
  estimatedCostUsd: null,
  failureClassification: { category: null, issueCodes: [] }
}
[omnimath:solve-orchestration-summary] {
  requestId: 'node-format',
  solveId: 'node-format',
  endpoint: '/api/solve-extracted-problem',
  generationCount: 1,
  HTTPAttemptCount: 1,
  finalOutcome: 'success',
  totalTokens: 12,
  totalEstimatedCostUsd: null
}
[omnimath:solve-orchestration-stage] {
  requestId: 'orphan',
  solveId: 'orphan',
  generationStage: 'initial',
  attemptIndex: 1
}
`);
  const report = analyzeTelemetryEvents(parsed.events, { parserDiagnostics: parsed });

  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.malformedEvents, 0);
  assert.equal(parsed.unrelatedLines, 1);
  assert.equal(report.overall.solveVolume.totalSolves, 1);
  assert.equal(report.metadata.orphanStageEvents, 1);
  assert.equal(report.overall.tokens.total.total, 12);
  assert.equal(report.overall.estimatedCostUsd.knownCount, 0);
  assert.equal(report.overall.estimatedCostUsd.unknownCount, 1);
});

test("endpoint and model filters retain only matching solve populations and breakdowns", async () => {
  const endpointReport = await analyzeTelemetryFiles([fixtureUrl.pathname], {
    endpoint: "/api/not-present",
  });
  assert.equal(endpointReport.overall.solveVolume.totalSolves, 0);

  const modelReport = await analyzeTelemetryFiles([fixtureUrl.pathname], { model: "escalation-a" });
  assert.equal(modelReport.overall.solveVolume.totalSolves, 4);
  assert.equal(modelReport.stages.fresh_escalation.attemptCount, 4);
  assert.equal(modelReport.stages.fresh_escalation_compact.attemptCount, 1);
  assert.deepEqual(Object.keys(modelReport.breakdowns.model), ["escalation-a"]);
});

test("console and JSON representations stay readable and machine-safe", async () => {
  const report = await analyzeTelemetryFiles([fixtureUrl.pathname]);
  const consoleOutput = renderConsoleReport(report, { details: true });
  const jsonOutput = JSON.stringify(report);

  assert.match(consoleOutput, /Solve volume/u);
  assert.match(consoleOutput, /Per-stage statistics/u);
  assert.match(consoleOutput, /initial_compact/u);
  assert.match(consoleOutput, /Failure-classification breakdown/u);
  assert.doesNotMatch(consoleOutput, /\u001b\[/u);
  assert.doesNotMatch(jsonOutput, /\u001b\[/u);
  assert.equal(JSON.parse(jsonOutput).overall.solveVolume.totalSolves, 10);
});

test("since is inclusive and until is exclusive for explicit event timestamps", async () => {
  const sinceReport = await analyzeTelemetryFiles([cohortFixtureUrl.pathname], {
    since: "2026-08-11T11:00:00.000Z",
  });
  assert.equal(sinceReport.overall.solveVolume.totalSolves, 2);
  assert.equal(sinceReport.stages.initial.attemptCount, 2);

  const untilReport = await analyzeTelemetryFiles([cohortFixtureUrl.pathname], {
    until: "2026-08-11T12:00:00.000Z",
  });
  assert.equal(untilReport.overall.solveVolume.totalSolves, 2);
  assert.equal(untilReport.stages.initial.attemptCount, 2);

  const rangeReport = await analyzeTelemetryFiles([cohortFixtureUrl.pathname], {
    since: "2026-08-11T11:00:00.000Z",
    until: "2026-08-11T12:00:00.000Z",
  });
  assert.equal(rangeReport.overall.solveVolume.totalSolves, 1);
  assert.equal(rangeReport.overall.solveVolume.hardFailures, 1);
  assert.deepEqual(rangeReport.metadata.timestampRange, {
    since: "2026-08-11T11:00:00.000Z",
    until: "2026-08-11T12:00:00.000Z",
    sinceInclusive: true,
    untilExclusive: true,
    active: true,
  });
});

test("policy and build filters are exact cohort matches with detailed breakdowns", async () => {
  const policyReport = await analyzeTelemetryFiles([cohortFixtureUrl.pathname], {
    policy: "phase3-policy-d",
  });
  assert.equal(policyReport.overall.solveVolume.totalSolves, 2);
  assert.deepEqual(Object.keys(policyReport.breakdowns.policyVersion), ["phase3-policy-d"]);

  const buildReport = await analyzeTelemetryFiles([cohortFixtureUrl.pathname], { build: "build-b" });
  assert.equal(buildReport.overall.solveVolume.totalSolves, 1);
  assert.deepEqual(Object.keys(buildReport.breakdowns.buildVersion), ["build-b"]);
  assert.equal(buildReport.metadata.excludedByFilters.solves.buildMismatch, 2);
});

test("CLI timestamp validation rejects malformed or ambiguous ranges clearly", () => {
  assert.throws(
    () => parseCliArguments(["--since=not-a-date", "telemetry.log"]),
    /--since must be a valid ISO 8601 timestamp with a timezone/u,
  );
  assert.throws(
    () => parseCliArguments([
      "--since=2026-08-11T12:00:00Z",
      "--until=2026-08-11T11:00:00Z",
      "telemetry.log",
    ]),
    /--since must be earlier than --until/u,
  );
});

test("old telemetry remains compatible and missing timestamps are explicit under time filters", async () => {
  const unfiltered = await analyzeTelemetryFiles([fixtureUrl.pathname]);
  assert.equal(unfiltered.overall.solveVolume.totalSolves, 10);
  assert.equal(unfiltered.metadata.cohortCoverage.solves.timestampUnknown, 10);
  assert.deepEqual(Object.keys(unfiltered.breakdowns.policyVersion), ["unknown"]);

  const filtered = await analyzeTelemetryFiles([fixtureUrl.pathname], {
    since: "2026-08-11T00:00:00.000Z",
  });
  assert.equal(filtered.overall.solveVolume.totalSolves, 0);
  assert.equal(filtered.metadata.excludedByFilters.solves.unknownTimestamp, 10);
  assert.equal(filtered.metadata.excludedByFilters.stageEvents.unknownTimestamp, 26);

  const cohortFiltered = await analyzeTelemetryFiles([fixtureUrl.pathname], {
    policy: "phase3-policy-d",
    build: "build-a",
  });
  assert.equal(cohortFiltered.overall.solveVolume.totalSolves, 0);
  assert.equal(cohortFiltered.metadata.excludedByFilters.solves.unknownPolicy, 10);
  assert.equal(cohortFiltered.metadata.excludedByFilters.solves.unknownBuild, 10);
});

test("JSON output exposes normalized time range and cohort coverage metadata", async () => {
  const report = await analyzeTelemetryFiles([cohortFixtureUrl.pathname], {
    since: "2026-08-11T05:00:00-05:00",
    policy: "phase3-policy-d",
    build: "build-a",
  });
  const json = JSON.parse(JSON.stringify(report));
  assert.equal(json.metadata.filters.since, "2026-08-11T10:00:00.000Z");
  assert.equal(json.metadata.filters.policy, "phase3-policy-d");
  assert.equal(json.metadata.filters.build, "build-a");
  assert.equal(json.metadata.cohortCoverage.solves.timestampKnown, 3);
  assert.equal(json.metadata.cohortCoverage.solves.policyKnown, 3);
  assert.equal(json.metadata.cohortCoverage.solves.buildKnown, 3);
});
