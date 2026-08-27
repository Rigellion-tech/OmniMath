#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STAGE_MARKER = "[omnimath:solve-orchestration-stage]";
const SUMMARY_MARKER = "[omnimath:solve-orchestration-summary]";
const STAGES = [
  "initial",
  "initial_compact",
  "quality_repair",
  "quality_repair_compact",
  "fresh_escalation",
  "fresh_escalation_compact",
];

/*
Metric definitions:
- A solve is one unique terminal summary event. Stage-only/orphaned records are
  reported but excluded from solve-based rates because their outcome is unknown.
- A stage rescue is an attempted stage with selectedForFinal=true whose matched
  solve did not hard-fail. This includes a stage selected as a safe fallback.
- A stage failure is an attempted stage that was not a rescue. Rescue/failure
  are mutually exclusive outcome-attribution metrics, not validator verdicts.
- Retry rates use all terminal solves as the denominator.
- Rescue rates use attempts of that exact generation stage as the denominator.
- presentation_degraded is an accepted result category separate from ordinary
  success. fallback is also separate, even though both return a result.
- Token/cost/duration averages include only records with an explicit finite value.
  Missing values remain unknown; they are never replaced with zero.
- Time filters apply to each event's explicit eventTimestamp: --since is inclusive
  and --until is exclusive. Events without a valid timestamp are excluded and
  counted when either time filter is active; dates are never inferred from logs.
- Policy/build filters are exact matches on orchestrationPolicyVersion and
  buildVersion. Missing cohort values are likewise excluded and counted.
*/

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanTrue(value) {
  return value === true;
}

function exactString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function eventTimestampMs(event = {}) {
  const timestamp = exactString(event.eventTimestamp);
  if (!timestamp || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp)) return null;
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function normalizeTimestampFilter(value, optionName) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = String(value);
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp);
  const milliseconds = Date.parse(timestamp);
  if (!hasExplicitTimezone || !Number.isFinite(milliseconds)) {
    throw new Error(`${optionName} must be a valid ISO 8601 timestamp with a timezone`);
  }
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function normalizeFilters({ endpoint = "", model = "", since = "", until = "", policy = "", build = "" } = {}) {
  const normalizedSince = normalizeTimestampFilter(since, "--since");
  const normalizedUntil = normalizeTimestampFilter(until, "--until");
  if (normalizedSince && normalizedUntil && normalizedSince.milliseconds >= normalizedUntil.milliseconds) {
    throw new Error("--since must be earlier than --until");
  }
  return {
    endpoint,
    model,
    since: normalizedSince,
    until: normalizedUntil,
    policy: exactString(policy),
    build: exactString(build),
  };
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return null;
  const index = Math.max(0, Math.ceil(percentileValue * sortedValues.length) - 1);
  return sortedValues[index];
}

function numericStats(values, expectedCount = values.length) {
  const known = values.map(finiteNumber).filter((value) => value !== null);
  const sorted = [...known].sort((left, right) => left - right);
  const total = known.reduce((sum, value) => sum + value, 0);
  return {
    knownCount: known.length,
    unknownCount: Math.max(0, expectedCount - known.length),
    total,
    average: known.length ? total / known.length : null,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length ? sorted.at(-1) : null,
  };
}

function rateMetric(count, denominator) {
  return {
    count,
    denominator,
    rate: denominator > 0 ? count / denominator : null,
  };
}

function solveKey(event = {}) {
  const id = event.solveId || event.requestId;
  if (!id) return null;
  return `${event.endpoint || "unknown-endpoint"}\u0000${id}`;
}

function stableStageKey(event = {}) {
  const id = solveKey(event);
  const attemptIndex = finiteNumber(event.attemptIndex);
  if (!id || attemptIndex === null || !event.generationStage) return null;
  return `${id}\u0000${attemptIndex}\u0000${event.generationStage}`;
}

function stableSummaryKey(event = {}) {
  return solveKey(event);
}

function findBalancedObjectEnd(text, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function parseInspectedObject(source) {
  const text = source
    .split("\n")
    .map((line) => line.replace(/^\s*#\s?/u, ""))
    .join("\n");
  let index = 0;

  function skipWhitespace() {
    while (/\s/u.test(text[index] || "")) index += 1;
  }

  function readString() {
    const quote = text[index];
    index += 1;
    let value = "";
    while (index < text.length) {
      const char = text[index];
      index += 1;
      if (char === quote) return value;
      if (char !== "\\") {
        value += char;
        continue;
      }
      const escaped = text[index] || "";
      index += 1;
      const simpleEscapes = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
        "0": "\0",
      };
      if (Object.hasOwn(simpleEscapes, escaped)) {
        value += simpleEscapes[escaped];
      } else if (escaped === "u") {
        const code = text.slice(index, index + 4);
        if (!/^[0-9a-f]{4}$/iu.test(code)) throw new Error("Invalid unicode escape");
        value += String.fromCharCode(Number.parseInt(code, 16));
        index += 4;
      } else if (escaped === "x") {
        const code = text.slice(index, index + 2);
        if (!/^[0-9a-f]{2}$/iu.test(code)) throw new Error("Invalid hex escape");
        value += String.fromCharCode(Number.parseInt(code, 16));
        index += 2;
      } else {
        value += escaped;
      }
    }
    throw new Error("Unterminated string");
  }

  function readBareToken() {
    const start = index;
    while (index < text.length && !/[\s,:{}\[\]]/u.test(text[index])) index += 1;
    if (start === index) throw new Error(`Unexpected token at ${index}`);
    return text.slice(start, index);
  }

  function parseValue() {
    skipWhitespace();
    const char = text[index];
    if (char === "{") return parseObject();
    if (char === "[") return parseArray();
    if (char === "\"" || char === "'") return readString();
    const token = readBareToken();
    if (token === "true") return true;
    if (token === "false") return false;
    if (["null", "undefined", "NaN", "Infinity", "-Infinity"].includes(token)) return null;
    const number = Number(token);
    if (Number.isFinite(number)) return number;
    return token;
  }

  function parseArray() {
    const output = [];
    index += 1;
    while (index < text.length) {
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return output;
      }
      output.push(parseValue());
      skipWhitespace();
      if (text[index] === ",") index += 1;
      else if (text[index] !== "]") throw new Error(`Expected array separator at ${index}`);
    }
    throw new Error("Unterminated array");
  }

  function parseObject() {
    const output = {};
    index += 1;
    while (index < text.length) {
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return output;
      }
      const key = text[index] === "\"" || text[index] === "'"
        ? readString()
        : readBareToken();
      skipWhitespace();
      if (text[index] !== ":") throw new Error(`Expected object colon at ${index}`);
      index += 1;
      output[key] = parseValue();
      skipWhitespace();
      if (text[index] === ",") index += 1;
      else if (text[index] !== "}") throw new Error(`Expected object separator at ${index}`);
    }
    throw new Error("Unterminated object");
  }

  const result = parseValue();
  skipWhitespace();
  if (index !== text.length || !isObject(result)) throw new Error("Unexpected trailing telemetry content");
  return result;
}

function parsePayload(source) {
  try {
    const value = JSON.parse(source);
    return isObject(value) ? value : null;
  } catch {
    try {
      return parseInspectedObject(source);
    } catch {
      return null;
    }
  }
}

export function parseTelemetryText(textValue, { source = "<memory>" } = {}) {
  const text = String(textValue || "");
  const events = [];
  const coveredRanges = [];
  let malformedEvents = 0;
  let cursor = 0;

  while (cursor < text.length) {
    const stageIndex = text.indexOf(STAGE_MARKER, cursor);
    const summaryIndex = text.indexOf(SUMMARY_MARKER, cursor);
    const candidates = [
      stageIndex >= 0 ? { index: stageIndex, type: "stage", marker: STAGE_MARKER } : null,
      summaryIndex >= 0 ? { index: summaryIndex, type: "summary", marker: SUMMARY_MARKER } : null,
    ].filter(Boolean).sort((left, right) => left.index - right.index);
    const next = candidates[0];
    if (!next) break;
    const nextMarkerIndex = [
      text.indexOf(STAGE_MARKER, next.index + next.marker.length),
      text.indexOf(SUMMARY_MARKER, next.index + next.marker.length),
    ].filter((value) => value >= 0).sort((left, right) => left - right)[0] ?? text.length;
    const objectStart = text.indexOf("{", next.index + next.marker.length);
    if (objectStart < 0 || objectStart >= nextMarkerIndex) {
      malformedEvents += 1;
      const lineEnd = text.indexOf("\n", next.index);
      coveredRanges.push([next.index, lineEnd < 0 ? text.length : lineEnd + 1]);
      cursor = next.index + next.marker.length;
      continue;
    }
    const objectEnd = findBalancedObjectEnd(text, objectStart);
    if (objectEnd < 0 || objectEnd > nextMarkerIndex) {
      malformedEvents += 1;
      coveredRanges.push([next.index, nextMarkerIndex]);
      cursor = nextMarkerIndex;
      continue;
    }
    const payload = parsePayload(text.slice(objectStart, objectEnd));
    coveredRanges.push([next.index, objectEnd]);
    if (payload) events.push({ type: next.type, payload, source });
    else malformedEvents += 1;
    cursor = objectEnd;
  }

  let unrelatedLines = 0;
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length + 1;
    const covered = coveredRanges.some(([start, end]) => offset < end && lineEnd > start);
    if (!covered && line.trim()) unrelatedLines += 1;
    offset = lineEnd;
  }

  return { events, malformedEvents, unrelatedLines };
}

export function deduplicateTelemetryEvents(events = []) {
  const stages = [];
  const summaries = [];
  const stageKeys = new Set();
  const summaryKeys = new Set();
  let duplicateStageEvents = 0;
  let duplicateSummaryEvents = 0;

  for (const event of events) {
    if (!isObject(event?.payload)) continue;
    if (event.type === "stage") {
      const key = stableStageKey(event.payload);
      if (key && stageKeys.has(key)) {
        duplicateStageEvents += 1;
        continue;
      }
      if (key) stageKeys.add(key);
      stages.push(event.payload);
    } else if (event.type === "summary") {
      const key = stableSummaryKey(event.payload);
      if (key && summaryKeys.has(key)) {
        duplicateSummaryEvents += 1;
        continue;
      }
      if (key) summaryKeys.add(key);
      summaries.push(event.payload);
    }
  }
  return { stages, summaries, duplicateStageEvents, duplicateSummaryEvents };
}

function finalOutcome(summary = {}) {
  return summary.finalOutcome || "unknown";
}

function isHardFailure(summary = {}) {
  return finalOutcome(summary) === "hard_failure";
}

function isPresentationDegraded(summary = {}) {
  return finalOutcome(summary) === "presentation_degraded";
}

function isFallback(summary = {}) {
  return finalOutcome(summary) === "fallback" || booleanTrue(summary.fallbackUsed);
}

function isOrdinarySuccess(summary = {}) {
  return ["success", "local_success"].includes(finalOutcome(summary));
}

function stageRescued(stage, summary) {
  return Boolean(summary && !isHardFailure(summary) && booleanTrue(stage.selectedForFinal));
}

function stageStatistics(stageName, stages, summaryByKey, solveCount) {
  const attempted = stages.filter((stage) => stage.generationStage === stageName);
  const reachedSolveKeys = new Set(attempted.map(solveKey).filter((key) => summaryByKey.has(key)));
  const rescueCount = attempted.filter((stage) => stageRescued(stage, summaryByKey.get(solveKey(stage)))).length;
  const duration = numericStats(attempted.map((stage) => stage.durationMs), attempted.length);
  const tokens = numericStats(attempted.map((stage) => stage.totalTokens), attempted.length);
  const cost = numericStats(attempted.map((stage) => stage.estimatedCostUsd), attempted.length);
  const httpAttempts = numericStats(attempted.map((stage) => stage.httpAttemptCount), attempted.length);
  return {
    attemptCount: attempted.length,
    reachedSolveCount: reachedSolveKeys.size,
    reachedSolvePercentage: solveCount ? reachedSolveKeys.size / solveCount : null,
    rescueCount,
    rescueRate: attempted.length ? rescueCount / attempted.length : null,
    failureCount: attempted.length - rescueCount,
    duration,
    tokens,
    cost,
    httpAttempts,
  };
}

function groupBy(items, keyFunction) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFunction(item);
    if (key === null || key === undefined || key === "") continue;
    if (!groups.has(String(key))) groups.set(String(key), []);
    groups.get(String(key)).push(item);
  }
  return groups;
}

function summaryBreakdown(summaries, keyFunction) {
  return Object.fromEntries([...groupBy(summaries, keyFunction)].map(([key, items]) => {
    const generations = numericStats(items.map((item) => item.generationCount), items.length);
    const duration = numericStats(items.map((item) => item.totalDurationMs), items.length);
    const tokens = numericStats(items.map((item) => item.totalTokens), items.length);
    const cost = numericStats(items.map((item) => item.totalEstimatedCostUsd), items.length);
    return [key, {
      solves: items.length,
      successful: items.filter(isOrdinarySuccess).length,
      presentationDegraded: items.filter(isPresentationDegraded).length,
      fallback: items.filter(isFallback).length,
      hardFailure: items.filter(isHardFailure).length,
      averageGenerations: generations.average,
      averageDurationMs: duration.average,
      totalTokens: tokens.total,
      unknownTokenSolves: tokens.unknownCount,
      totalEstimatedCostUsd: cost.total,
      unknownCostSolves: cost.unknownCount,
    }];
  }));
}

function stageBreakdown(stages, keyFunction, summaryByKey) {
  return Object.fromEntries([...groupBy(stages, keyFunction)].map(([key, items]) => {
    const solveKeys = new Set(items.map(solveKey).filter(Boolean));
    const tokens = numericStats(items.map((item) => item.totalTokens), items.length);
    const cost = numericStats(items.map((item) => item.estimatedCostUsd), items.length);
    const duration = numericStats(items.map((item) => item.durationMs), items.length);
    return [key, {
      attempts: items.length,
      solves: solveKeys.size,
      rescues: items.filter((item) => stageRescued(item, summaryByKey.get(solveKey(item)))).length,
      averageDurationMs: duration.average,
      totalTokens: tokens.total,
      unknownTokenAttempts: tokens.unknownCount,
      totalEstimatedCostUsd: cost.total,
      unknownCostAttempts: cost.unknownCount,
    }];
  }));
}

function failureCategory(stage = {}) {
  return stage.failureClassification?.category
    || stage.transitionFailureClassification?.category
    || null;
}

function coverageFor(events) {
  return {
    total: events.length,
    timestampKnown: events.filter((event) => eventTimestampMs(event) !== null).length,
    timestampUnknown: events.filter((event) => eventTimestampMs(event) === null).length,
    policyKnown: events.filter((event) => exactString(event.orchestrationPolicyVersion)).length,
    policyUnknown: events.filter((event) => !exactString(event.orchestrationPolicyVersion)).length,
    buildKnown: events.filter((event) => exactString(event.buildVersion)).length,
    buildUnknown: events.filter((event) => !exactString(event.buildVersion)).length,
  };
}

function filterExclusions(events, filters) {
  const timeActive = Boolean(filters.since || filters.until);
  const timestampKnown = (event) => eventTimestampMs(event) !== null;
  const outsideTimestampRange = (event) => {
    const timestamp = eventTimestampMs(event);
    if (timestamp === null) return false;
    return Boolean(
      (filters.since && timestamp < filters.since.milliseconds)
      || (filters.until && timestamp >= filters.until.milliseconds),
    );
  };
  return {
    unknownTimestamp: timeActive ? events.filter((event) => !timestampKnown(event)).length : 0,
    outsideTimestampRange: timeActive ? events.filter(outsideTimestampRange).length : 0,
    unknownPolicy: filters.policy
      ? events.filter((event) => !exactString(event.orchestrationPolicyVersion)).length
      : 0,
    policyMismatch: filters.policy
      ? events.filter((event) => (
        exactString(event.orchestrationPolicyVersion)
        && event.orchestrationPolicyVersion !== filters.policy
      )).length
      : 0,
    unknownBuild: filters.build ? events.filter((event) => !exactString(event.buildVersion)).length : 0,
    buildMismatch: filters.build
      ? events.filter((event) => exactString(event.buildVersion) && event.buildVersion !== filters.build).length
      : 0,
  };
}

function eventMatchesCohortAndTime(event, filters) {
  const timestamp = eventTimestampMs(event);
  if (filters.since && (timestamp === null || timestamp < filters.since.milliseconds)) return false;
  if (filters.until && (timestamp === null || timestamp >= filters.until.milliseconds)) return false;
  if (filters.policy && event.orchestrationPolicyVersion !== filters.policy) return false;
  if (filters.build && event.buildVersion !== filters.build) return false;
  return true;
}

function applyFilters(stages, summaries, rawFilters = {}) {
  const filters = normalizeFilters(rawFilters);
  let filteredSummaries = summaries;
  let filteredStages = stages;
  if (filters.endpoint) {
    filteredSummaries = filteredSummaries.filter((summary) => summary.endpoint === filters.endpoint);
    filteredStages = filteredStages.filter((stage) => stage.endpoint === filters.endpoint);
  }
  if (filters.model) {
    const modelSolveKeys = new Set(
      filteredStages.filter((stage) => stage.model === filters.model).map(solveKey).filter(Boolean),
    );
    filteredSummaries = filteredSummaries.filter((summary) => modelSolveKeys.has(solveKey(summary)));
    filteredStages = filteredStages.filter((stage) => (
      stage.model === filters.model && modelSolveKeys.has(solveKey(stage))
    ));
  }
  const cohortCoverage = {
    stageEvents: coverageFor(filteredStages),
    solves: coverageFor(filteredSummaries),
  };
  const excludedByFilters = {
    stageEvents: filterExclusions(filteredStages, filters),
    solves: filterExclusions(filteredSummaries, filters),
  };
  filteredStages = filteredStages.filter((stage) => eventMatchesCohortAndTime(stage, filters));
  filteredSummaries = filteredSummaries.filter((summary) => eventMatchesCohortAndTime(summary, filters));
  return { stages: filteredStages, summaries: filteredSummaries, filters, cohortCoverage, excludedByFilters };
}

export function analyzeTelemetryEvents(events = [], {
  endpoint = "",
  model = "",
  since = "",
  until = "",
  policy = "",
  build = "",
  parserDiagnostics = {},
  files = [],
} = {}) {
  const deduplicated = deduplicateTelemetryEvents(events);
  const filtered = applyFilters(deduplicated.stages, deduplicated.summaries, {
    endpoint, model, since, until, policy, build,
  });
  const summaryByKey = new Map(filtered.summaries.map((summary) => [solveKey(summary), summary]));
  const matchedStages = filtered.stages.filter((stage) => summaryByKey.has(solveKey(stage)));
  const orphanStageEvents = filtered.stages.length - matchedStages.length;
  const solveCount = filtered.summaries.length;
  const stageStats = Object.fromEntries(STAGES.map((stageName) => [
    stageName,
    stageStatistics(stageName, matchedStages, summaryByKey, solveCount),
  ]));

  const generations = numericStats(filtered.summaries.map((summary) => summary.generationCount), solveCount);
  const httpAttempts = numericStats(filtered.summaries.map((summary) => summary.HTTPAttemptCount), solveCount);
  const duration = numericStats(filtered.summaries.map((summary) => summary.totalDurationMs), solveCount);
  const inputTokens = numericStats(filtered.summaries.map((summary) => summary.totalInputTokens), solveCount);
  const visibleOutputTokens = numericStats(filtered.summaries.map((summary) => summary.totalVisibleOutputTokens), solveCount);
  const reasoningTokens = numericStats(filtered.summaries.map((summary) => summary.totalReasoningTokens), solveCount);
  const totalTokens = numericStats(filtered.summaries.map((summary) => summary.totalTokens), solveCount);
  const cost = numericStats(filtered.summaries.map((summary) => summary.totalEstimatedCostUsd), solveCount);

  const solvesWithStage = (stageName, summaryFlag) => new Set([
    ...matchedStages.filter((stage) => stage.generationStage === stageName).map(solveKey),
    ...filtered.summaries.filter((summary) => booleanTrue(summary[summaryFlag])).map(solveKey),
  ]).size;
  const suppressionCount = new Set([
    ...matchedStages.filter((stage) => booleanTrue(stage.compactRetrySuppressedByPolicy)).map(solveKey),
    ...filtered.summaries.filter((summary) => booleanTrue(summary.lateCompactSuppressed)).map(solveKey),
  ]).size;
  const fallbackCount = filtered.summaries.filter(isFallback).length;
  const hardFailureCount = filtered.summaries.filter(isHardFailure).length;

  const policyRates = {
    initialCompactRetry: rateMetric(solvesWithStage("initial_compact", "initialCompactUsed"), solveCount),
    initialCompactRescue: rateMetric(stageStats.initial_compact.rescueCount, stageStats.initial_compact.attemptCount),
    qualityRepair: rateMetric(solvesWithStage("quality_repair", "repairUsed"), solveCount),
    qualityRepairRescue: rateMetric(stageStats.quality_repair.rescueCount, stageStats.quality_repair.attemptCount),
    repairCompactRetry: rateMetric(solvesWithStage("quality_repair_compact", "repairCompactUsed"), solveCount),
    repairCompactRescue: rateMetric(stageStats.quality_repair_compact.rescueCount, stageStats.quality_repair_compact.attemptCount),
    freshEscalation: rateMetric(solvesWithStage("fresh_escalation", "escalationUsed"), solveCount),
    freshEscalationRescue: rateMetric(stageStats.fresh_escalation.rescueCount, stageStats.fresh_escalation.attemptCount),
    escalationCompactRetry: rateMetric(solvesWithStage("fresh_escalation_compact", "escalationCompactUsed"), solveCount),
    escalationCompactRescue: rateMetric(stageStats.fresh_escalation_compact.rescueCount, stageStats.fresh_escalation_compact.attemptCount),
    policyDLateCompactSuppression: rateMetric(suppressionCount, solveCount),
    fallback: rateMetric(fallbackCount, solveCount),
    hardFailure: rateMetric(hardFailureCount, solveCount),
  };

  const failureGroups = groupBy(matchedStages, failureCategory);
  const finalFailureGroups = groupBy(
    filtered.summaries,
    (summary) => summary.finalFailureClassification?.category || null,
  );
  const failureCategories = new Set([...failureGroups.keys(), ...finalFailureGroups.keys()]);
  const failureClassification = Object.fromEntries([...failureCategories].map((category) => {
    const stageItems = failureGroups.get(category) || [];
    const finalItems = finalFailureGroups.get(category) || [];
    return [category, {
      stageAttempts: stageItems.length,
      stageSolves: new Set(stageItems.map(solveKey).filter(Boolean)).size,
      finalFailures: finalItems.length,
    }];
  }));

  return {
    metadata: {
      files,
      filters: {
        endpoint: endpoint || null,
        model: model || null,
        since: filtered.filters.since?.iso || null,
        until: filtered.filters.until?.iso || null,
        policy: filtered.filters.policy,
        build: filtered.filters.build,
      },
      timestampRange: {
        since: filtered.filters.since?.iso || null,
        until: filtered.filters.until?.iso || null,
        sinceInclusive: true,
        untilExclusive: true,
        active: Boolean(filtered.filters.since || filtered.filters.until),
      },
      cohortCoverage: filtered.cohortCoverage,
      excludedByFilters: filtered.excludedByFilters,
      parsedStageEvents: deduplicated.stages.length + deduplicated.duplicateStageEvents,
      parsedSummaryEvents: deduplicated.summaries.length + deduplicated.duplicateSummaryEvents,
      duplicateStageEvents: deduplicated.duplicateStageEvents,
      duplicateSummaryEvents: deduplicated.duplicateSummaryEvents,
      malformedEvents: parserDiagnostics.malformedEvents || 0,
      unrelatedLines: parserDiagnostics.unrelatedLines || 0,
      orphanStageEvents,
    },
    definitions: {
      solve: "one unique terminal solve-orchestration-summary event",
      stageRescue: "selectedForFinal=true on a matched non-hard-failure solve; safe fallback selections count as rescues",
      stageFailure: "an attempted stage that was not a rescue; mutually exclusive with stageRescue",
      retryRateDenominator: "all terminal solves after filters",
      rescueRateDenominator: "attempts of the exact generation stage",
      presentationDegraded: "finalOutcome=presentation_degraded; separate from ordinary success",
      fallback: "finalOutcome=fallback or fallbackUsed=true; separate from ordinary success",
      missingMetrics: "unknown values are excluded from totals/averages and reported through unknownCount",
      timestampFiltering: "eventTimestamp only; --since is inclusive and --until is exclusive; missing/invalid values are excluded when active",
      cohortFiltering: "exact orchestrationPolicyVersion/buildVersion match; missing values are excluded when active",
    },
    overall: {
      solveVolume: {
        totalSolves: solveCount,
        successfulSolves: filtered.summaries.filter(isOrdinarySuccess).length,
        presentationDegradedAccepts: filtered.summaries.filter(isPresentationDegraded).length,
        fallbackReturns: fallbackCount,
        hardFailures: hardFailureCount,
        otherOutcomes: filtered.summaries.filter((summary) => (
          !isOrdinarySuccess(summary)
          && !isPresentationDegraded(summary)
          && !isFallback(summary)
          && !isHardFailure(summary)
        )).length,
      },
      providerBehavior: { generations, httpAttempts },
      latencyMs: duration,
      tokens: { input: inputTokens, visibleOutput: visibleOutputTokens, reasoning: reasoningTokens, total: totalTokens },
      estimatedCostUsd: cost,
    },
    policyRates,
    stages: stageStats,
    breakdowns: {
      endpoint: summaryBreakdown(filtered.summaries, (summary) => summary.endpoint),
      model: stageBreakdown(matchedStages, (stage) => stage.model, summaryByKey),
      modelRole: stageBreakdown(matchedStages, (stage) => stage.modelRole, summaryByKey),
      policyVersion: summaryBreakdown(
        filtered.summaries,
        (summary) => exactString(summary.orchestrationPolicyVersion) || "unknown",
      ),
      buildVersion: summaryBreakdown(
        filtered.summaries,
        (summary) => exactString(summary.buildVersion) || "unknown",
      ),
      failureClassification,
      finalOutcome: Object.fromEntries([...groupBy(filtered.summaries, finalOutcome)].map(([outcome, items]) => [outcome, {
        solves: items.length,
        percentage: solveCount ? items.length / solveCount : null,
      }])),
    },
  };
}

export async function analyzeTelemetryFiles(filePaths, filters = {}) {
  const reads = await Promise.all(filePaths.map(async (filePath) => ({
    filePath,
    text: await readFile(filePath, "utf8"),
  })));
  const parsed = reads.map(({ filePath, text }) => parseTelemetryText(text, { source: filePath }));
  return analyzeTelemetryEvents(parsed.flatMap((result) => result.events), {
    ...filters,
    files: filePaths,
    parserDiagnostics: {
      malformedEvents: parsed.reduce((sum, result) => sum + result.malformedEvents, 0),
      unrelatedLines: parsed.reduce((sum, result) => sum + result.unrelatedLines, 0),
    },
  });
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "unknown";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function formatPercent(value) {
  return value === null || value === undefined ? "unknown" : `${(value * 100).toFixed(1)}%`;
}

function formatCost(value) {
  return value === null || value === undefined ? "unknown" : `$${Number(value).toFixed(6)}`;
}

function formatKnownTotal(stats, formatter = formatNumber) {
  const suffix = stats.unknownCount ? ` (${stats.unknownCount} unknown)` : "";
  return `${formatter(stats.total)}${suffix}`;
}

function renderTable(headers, rows) {
  const normalized = rows.map((row) => row.map((value) => String(value)));
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...normalized.map((row) => row[index]?.length || 0),
  ));
  const line = (row) => row.map((value, index) => String(value).padEnd(widths[index])).join("  ").trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...normalized.map(line)].join("\n");
}

function breakdownRows(breakdown, fields) {
  return Object.entries(breakdown).map(([key, value]) => [key, ...fields.map((field) => value[field] ?? "unknown")]);
}

export function renderConsoleReport(report, { details = false } = {}) {
  const volume = report.overall.solveVolume;
  const provider = report.overall.providerBehavior;
  const latency = report.overall.latencyMs;
  const tokens = report.overall.tokens;
  const cost = report.overall.estimatedCostUsd;
  const coverage = report.metadata.cohortCoverage;
  const excluded = report.metadata.excludedByFilters;
  const lines = [
    "OmniMath solve-orchestration telemetry",
    "",
    "Input quality",
    renderTable(["Metric", "Count"], [
      ["Parsed stage events", report.metadata.parsedStageEvents],
      ["Parsed summary events", report.metadata.parsedSummaryEvents],
      ["Duplicate stage events", report.metadata.duplicateStageEvents],
      ["Duplicate summary events", report.metadata.duplicateSummaryEvents],
      ["Malformed events", report.metadata.malformedEvents],
      ["Unrelated lines", report.metadata.unrelatedLines],
      ["Orphan stage events", report.metadata.orphanStageEvents],
    ]),
    "",
    "Timestamp and cohort coverage",
    renderTable(["Metric", "Stage events", "Solves"], [
      ["Timestamp known", coverage.stageEvents.timestampKnown, coverage.solves.timestampKnown],
      ["Timestamp unknown", coverage.stageEvents.timestampUnknown, coverage.solves.timestampUnknown],
      ["Policy known", coverage.stageEvents.policyKnown, coverage.solves.policyKnown],
      ["Policy unknown", coverage.stageEvents.policyUnknown, coverage.solves.policyUnknown],
      ["Build known", coverage.stageEvents.buildKnown, coverage.solves.buildKnown],
      ["Build unknown", coverage.stageEvents.buildUnknown, coverage.solves.buildUnknown],
      ["Unknown timestamp excluded", excluded.stageEvents.unknownTimestamp, excluded.solves.unknownTimestamp],
      ["Outside time range", excluded.stageEvents.outsideTimestampRange, excluded.solves.outsideTimestampRange],
      ["Unknown policy excluded", excluded.stageEvents.unknownPolicy, excluded.solves.unknownPolicy],
      ["Policy mismatch", excluded.stageEvents.policyMismatch, excluded.solves.policyMismatch],
      ["Unknown build excluded", excluded.stageEvents.unknownBuild, excluded.solves.unknownBuild],
      ["Build mismatch", excluded.stageEvents.buildMismatch, excluded.solves.buildMismatch],
    ]),
    "",
    "Solve volume",
    renderTable(["Total", "Success", "Presentation", "Fallback", "Hard fail", "Other"], [[
      volume.totalSolves,
      volume.successfulSolves,
      volume.presentationDegradedAccepts,
      volume.fallbackReturns,
      volume.hardFailures,
      volume.otherOutcomes,
    ]]),
    "",
    "Provider and latency",
    renderTable(["Metric", "Average", "P50", "P95", "Max", "Unknown"], [
      ["Generations / solve", formatNumber(provider.generations.average), formatNumber(provider.generations.p50), formatNumber(provider.generations.p95), formatNumber(provider.generations.max), provider.generations.unknownCount],
      ["HTTP attempts / solve", formatNumber(provider.httpAttempts.average), formatNumber(provider.httpAttempts.p50), formatNumber(provider.httpAttempts.p95), formatNumber(provider.httpAttempts.max), provider.httpAttempts.unknownCount],
      ["Solve duration (ms)", formatNumber(latency.average), formatNumber(latency.p50), formatNumber(latency.p95), formatNumber(latency.max), latency.unknownCount],
    ]),
    "",
    "Tokens and estimated cost",
    renderTable(["Metric", "Total", "Average", "P50", "P95", "Max", "Unknown"], [
      ["Input tokens", formatKnownTotal(tokens.input), formatNumber(tokens.input.average), formatNumber(tokens.input.p50), formatNumber(tokens.input.p95), formatNumber(tokens.input.max), tokens.input.unknownCount],
      ["Visible output tokens", formatKnownTotal(tokens.visibleOutput), formatNumber(tokens.visibleOutput.average), formatNumber(tokens.visibleOutput.p50), formatNumber(tokens.visibleOutput.p95), formatNumber(tokens.visibleOutput.max), tokens.visibleOutput.unknownCount],
      ["Reasoning tokens", formatKnownTotal(tokens.reasoning), formatNumber(tokens.reasoning.average), formatNumber(tokens.reasoning.p50), formatNumber(tokens.reasoning.p95), formatNumber(tokens.reasoning.max), tokens.reasoning.unknownCount],
      ["Total tokens", formatKnownTotal(tokens.total), formatNumber(tokens.total.average), formatNumber(tokens.total.p50), formatNumber(tokens.total.p95), formatNumber(tokens.total.max), tokens.total.unknownCount],
      ["Estimated cost", formatKnownTotal(cost, formatCost), formatCost(cost.average), formatCost(cost.p50), formatCost(cost.p95), formatCost(cost.max), cost.unknownCount],
    ]),
    "",
    "Retry and outcome rates",
    renderTable(["Metric", "Count", "Denominator", "Rate"], Object.entries(report.policyRates).map(([name, metric]) => [
      name,
      metric.count,
      metric.denominator,
      formatPercent(metric.rate),
    ])),
    "",
    "Per-stage statistics",
    renderTable(
      ["Stage", "Attempts", "Reach", "Rescues", "Rescue rate", "Failures", "Avg ms", "P50", "P95", "Tokens", "Avg tokens", "Cost", "Avg cost", "Avg HTTP"],
      STAGES.map((stageName) => {
        const stage = report.stages[stageName];
        return [
          stageName,
          stage.attemptCount,
          formatPercent(stage.reachedSolvePercentage),
          stage.rescueCount,
          formatPercent(stage.rescueRate),
          stage.failureCount,
          formatNumber(stage.duration.average),
          formatNumber(stage.duration.p50),
          formatNumber(stage.duration.p95),
          formatKnownTotal(stage.tokens),
          formatNumber(stage.tokens.average),
          formatKnownTotal(stage.cost, formatCost),
          formatCost(stage.cost.average),
          formatNumber(stage.httpAttempts.average),
        ];
      }),
    ),
  ];

  if (details) {
    lines.push(
      "",
      "Endpoint breakdown",
      renderTable(["Endpoint", "Solves", "Success", "Presentation", "Fallback", "Hard fail", "Avg generations"], breakdownRows(
        report.breakdowns.endpoint,
        ["solves", "successful", "presentationDegraded", "fallback", "hardFailure", "averageGenerations"],
      ).map((row) => [...row.slice(0, 6), formatNumber(row[6])])),
      "",
      "Model breakdown",
      renderTable(["Model", "Attempts", "Solves", "Rescues", "Avg ms", "Tokens", "Cost"], Object.entries(report.breakdowns.model).map(([key, value]) => [
        key, value.attempts, value.solves, value.rescues, formatNumber(value.averageDurationMs), formatNumber(value.totalTokens), formatCost(value.totalEstimatedCostUsd),
      ])),
      "",
      "Model-role breakdown",
      renderTable(["Role", "Attempts", "Solves", "Rescues", "Avg ms", "Tokens", "Cost"], Object.entries(report.breakdowns.modelRole).map(([key, value]) => [
        key, value.attempts, value.solves, value.rescues, formatNumber(value.averageDurationMs), formatNumber(value.totalTokens), formatCost(value.totalEstimatedCostUsd),
      ])),
      "",
      "Policy-version breakdown",
      renderTable(["Policy", "Solves", "Success", "Presentation", "Fallback", "Hard fail", "Avg generations"], breakdownRows(
        report.breakdowns.policyVersion,
        ["solves", "successful", "presentationDegraded", "fallback", "hardFailure", "averageGenerations"],
      ).map((row) => [...row.slice(0, 6), formatNumber(row[6])])),
      "",
      "Build-version breakdown",
      renderTable(["Build", "Solves", "Success", "Presentation", "Fallback", "Hard fail", "Avg generations"], breakdownRows(
        report.breakdowns.buildVersion,
        ["solves", "successful", "presentationDegraded", "fallback", "hardFailure", "averageGenerations"],
      ).map((row) => [...row.slice(0, 6), formatNumber(row[6])])),
      "",
      "Failure-classification breakdown",
      renderTable(["Classification", "Stage attempts", "Stage solves", "Final failures"], breakdownRows(
        report.breakdowns.failureClassification,
        ["stageAttempts", "stageSolves", "finalFailures"],
      )),
      "",
      "Final-outcome breakdown",
      renderTable(["Outcome", "Solves", "Percentage"], Object.entries(report.breakdowns.finalOutcome).map(([key, value]) => [key, value.solves, formatPercent(value.percentage)])),
    );
  }
  return lines.join("\n");
}

export function parseCliArguments(argv) {
  const options = {
    json: false,
    details: false,
    endpoint: "",
    model: "",
    since: "",
    until: "",
    policy: "",
    build: "",
    files: [],
  };
  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument === "--details") options.details = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--endpoint=")) options.endpoint = argument.slice("--endpoint=".length);
    else if (argument.startsWith("--model=")) options.model = argument.slice("--model=".length);
    else if (argument.startsWith("--since=")) {
      options.since = argument.slice("--since=".length);
      if (!options.since) throw new Error("--since must be a valid ISO 8601 timestamp with a timezone");
    } else if (argument.startsWith("--until=")) {
      options.until = argument.slice("--until=".length);
      if (!options.until) throw new Error("--until must be a valid ISO 8601 timestamp with a timezone");
    } else if (argument.startsWith("--policy=")) {
      options.policy = argument.slice("--policy=".length);
      if (!options.policy) throw new Error("--policy requires a non-empty exact version");
    } else if (argument.startsWith("--build=")) {
      options.build = argument.slice("--build=".length);
      if (!options.build) throw new Error("--build requires a non-empty exact version");
    }
    else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else options.files.push(argument);
  }
  const filters = normalizeFilters(options);
  options.since = filters.since?.iso || "";
  options.until = filters.until?.iso || "";
  return options;
}

function usage() {
  return `Usage: node scripts/analyze-solve-telemetry.mjs [options] <log-file...>

Options:
  --json                Emit machine-readable JSON only
  --details             Include endpoint/model/role/failure/outcome tables
  --endpoint=<endpoint> Analyze one endpoint
  --model=<model>       Analyze stages and solves touching one model
  --since=<timestamp>   Include events at/after this ISO timestamp
  --until=<timestamp>   Include events before this ISO timestamp
  --policy=<version>    Exact orchestration-policy cohort match
  --build=<version>     Exact build/version cohort match
  -h, --help            Show this help`;
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.files.length === 0) throw new Error("At least one telemetry log file is required.\n\n" + usage());
  const report = await analyzeTelemetryFiles(options.files, options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderConsoleReport(report, options));
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === currentFile) {
  main().catch((error) => {
    console.error(`Telemetry analysis failed: ${error.message}`);
    process.exitCode = 1;
  });
}
