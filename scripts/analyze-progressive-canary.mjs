#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RECOVERY_MARKER = "[omnimath:progressive-recovery]";
const TERMINAL_MARKER = "[omnimath:progressive-terminal]";
const JSON_RECOVERY_MARKER = "[omnimath:progressive-canary-recovery]";
const JSON_TERMINAL_MARKER = "[omnimath:progressive-canary-terminal]";

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const number = (value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const idOf = (event = {}) => event.requestId || event.solveId || null;
const asArray = (value) => Array.isArray(value) ? value : [];

function parseObject(source) {
  try { const parsed = JSON.parse(source); return object(parsed) ? parsed : null; } catch { return null; }
}

function matchingBraceEnd(text, start) {
  let depth = 0; let quote = null; let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

export function parseProgressiveCanaryText(textValue) {
  const text = String(textValue || "");
  const events = [];
  let malformedEvents = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const candidates = [
      { marker: RECOVERY_MARKER, type: "recovery" },
      { marker: TERMINAL_MARKER, type: "terminal" },
      { marker: JSON_RECOVERY_MARKER, type: "recovery" },
      { marker: JSON_TERMINAL_MARKER, type: "terminal" },
    ].map((item) => ({ ...item, index: text.indexOf(item.marker, cursor) }))
      .filter((item) => item.index >= 0).sort((a, b) => a.index - b.index);
    const next = candidates[0];
    if (!next) break;
    const markers = [RECOVERY_MARKER, TERMINAL_MARKER, JSON_RECOVERY_MARKER, JSON_TERMINAL_MARKER];
    const nextMarker = markers.map((marker) => text.indexOf(marker, next.index + next.marker.length))
      .filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? text.length;
    const start = text.indexOf("{", next.index + next.marker.length);
    if (start < 0 || start >= nextMarker) { malformedEvents += 1; cursor = nextMarker > next.index ? nextMarker : next.index + next.marker.length; continue; }
    const end = matchingBraceEnd(text, start);
    const payload = end > start && end <= nextMarker ? parseObject(text.slice(start, end)) : null;
    if (payload) events.push({ type: next.type, payload });
    else malformedEvents += 1;
    cursor = end > start ? end : start + 1;
  }
  return { events, malformedEvents };
}

function durationFrom(event, startField, endField) {
  const start = number(event?.[startField]); const end = number(event?.[endField]);
  return start === null || end === null || end < start ? null : end - start;
}

function stats(values) {
  const known = values.map(number).filter((value) => value !== null);
  return {
    knownCount: known.length,
    unknownCount: values.length - known.length,
    total: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
    average: known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null,
  };
}

export function analyzeProgressiveCanaryEvents(events = []) {
  const solves = new Map();
  let unidentifiedEvents = 0;
  for (const item of events) {
    const payload = item?.payload;
    const id = idOf(payload);
    if (!id) { unidentifiedEvents += 1; continue; }
    if (!solves.has(id)) solves.set(id, { requestId: id, recoveries: [], terminal: null });
    const solve = solves.get(id);
    if (item.type === "recovery") solve.recoveries.push(payload);
    else if (item.type === "terminal") solve.terminal = payload;
  }

  const records = [...solves.values()].map((solve) => {
    const attempts = [...solve.recoveries].sort((a, b) => (number(a.providerAttemptIndex) ?? 0) - (number(b.providerAttemptIndex) ?? 0));
    const terminal = solve.terminal || {};
    const firstAttempt = attempts.find((attempt) => number(attempt.providerAttemptIndex) === 1) || attempts[0] || null;
    const firstDecision = firstAttempt?.decision || firstAttempt?.recoveryDecision || null;
    const hasTerminal = Boolean(solve.terminal);
    const retryCount = number(terminal.retryCount ?? terminal.retryAttempts) ?? (hasTerminal ? attempts.filter((attempt) => (attempt.decision || attempt.recoveryDecision) === "retry").length : null);
    const repairCount = number(terminal.repairCount ?? terminal.repairAttempts) ?? (hasTerminal ? attempts.filter((attempt) => (attempt.decision || attempt.recoveryDecision) === "repair").length : null);
    const escalationAttempts = attempts.filter((attempt) => (attempt.decision || attempt.recoveryDecision) === "escalate");
    const escalationCount = number(terminal.escalationCount ?? terminal.escalationAttempts) ?? (hasTerminal ? escalationAttempts.length : null);
    const providerCalls = number(terminal.providerCallCount);
    const firstStepMs = number(terminal.firstValidatedStepMs) ?? number(terminal.firstStepMs) ?? number(terminal.firstStepLatencyMs);
    const recoveryAttempts = attempts.slice(1);
    const derivedRecoveryDurations = recoveryAttempts.map((attempt) => number(attempt.durationMs) ?? durationFrom(attempt, "startedAt", "endedAt"));
    const recoveryDurationMs = number(terminal.recoveryDurationMs) ?? (hasTerminal && recoveryAttempts.length && derivedRecoveryDurations.every((value) => value !== null)
      ? derivedRecoveryDurations.reduce((sum, value) => sum + value, 0) : null);
    const usage = terminal.aggregateUsage || terminal.usage || null;
    const usageTokens = number(usage?.totalTokens ?? usage?.total_tokens ?? terminal.totalTokens);
    const cost = number(usage?.estimatedCostUsd ?? terminal.costUsd ?? terminal.estimatedCostUsd ?? terminal.totalEstimatedCostUsd);
    return {
      requestId: solve.requestId,
      initialModel: terminal.initialSelectedModel ?? attempts[0]?.model ?? null,
      finalModel: terminal.finalAuthoritativeModel ?? terminal.model ?? attempts.at(-1)?.model ?? null,
      firstAttemptSuccess: typeof terminal.initialAttemptSucceeded === "boolean"
        ? terminal.initialAttemptSucceeded
        : firstDecision === "authoritative" ? true : (firstDecision ? false : null),
      retryCount: retryCount ?? null,
      retryCountKnown: retryCount !== null,
      repairCount: repairCount ?? null,
      repairCountKnown: repairCount !== null,
      escalationCount: escalationCount ?? null,
      escalationCountKnown: escalationCount !== null,
      escalationReasons: escalationAttempts.map((attempt) => attempt.escalationReason || attempt.decisionReason || attempt.recoveryReason).filter(Boolean),
      providerCalls,
      recoveryDurationMs,
      firstValidatedStepMs: firstStepMs,
      firstProviderEventMs: number(terminal.firstProviderEventMs),
      totalLatencyMs: number(terminal.totalDurationMs ?? terminal.totalLatencyMs ?? terminal.durationMs),
      completedSteps: number(terminal.steps ?? terminal.completedSteps),
      partialFailure: typeof terminal.partialPrefixFailure === "boolean" ? terminal.partialPrefixFailure
        : ["failure", "failed", "partial_failure"].includes(String(terminal.terminalReason || "").toLowerCase())
          && number(terminal.steps ?? terminal.completedSteps) > 0 ? true : (terminal.terminalReason ? false : null),
      terminalStatus: terminal.terminalReason || null,
      usageTokens,
      costUsd: cost,
    };
  });
  const known = (field) => records.map((record) => record[field]);
  const countTrue = (field) => records.filter((record) => record[field] === true).length;
  return {
    solveCount: records.length,
    unidentifiedEvents,
    records,
    totals: {
      firstAttemptSuccess: { count: countTrue("firstAttemptSuccess"), unknownCount: records.filter((r) => r.firstAttemptSuccess === null).length, rate: records.some((r) => r.firstAttemptSuccess !== null) ? countTrue("firstAttemptSuccess") / records.filter((r) => r.firstAttemptSuccess !== null).length : null },
      retries: stats(records.map((record) => record.retryCount)).total,
      repairs: stats(records.map((record) => record.repairCount)).total,
      escalations: stats(records.map((record) => record.escalationCount)).total,
      providerCalls: stats(known("providerCalls")),
      recoveryDurationMs: stats(known("recoveryDurationMs")),
      firstValidatedStepMs: stats(known("firstValidatedStepMs")),
      totalLatencyMs: stats(known("totalLatencyMs")),
      usageTokens: stats(known("usageTokens")),
      costUsd: stats(known("costUsd")),
      partialFailures: records.filter((record) => record.partialFailure === true).length,
      unknownPartialFailure: records.filter((record) => record.partialFailure === null).length,
    },
  };
}

export async function analyzeProgressiveCanaryFiles(files = []) {
  const parsed = await Promise.all(files.map(async (file) => parseProgressiveCanaryText(await readFile(file, "utf8"))));
  const report = analyzeProgressiveCanaryEvents(parsed.flatMap((result) => result.events));
  report.malformedEvents = parsed.reduce((sum, result) => sum + result.malformedEvents, 0);
  return report;
}

function usage() {
  return "Usage: node scripts/analyze-progressive-canary.mjs [--json] <log-file...>";
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const files = args.filter((arg) => arg !== "--json");
  if (!files.length) throw new Error(usage());
  const report = await analyzeProgressiveCanaryFiles(files);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Progressive canary solves: ${report.solveCount}`);
    console.log(JSON.stringify(report.totals, null, 2));
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => { console.error(`Canary analysis failed: ${error.message}`); process.exitCode = 1; });
}
