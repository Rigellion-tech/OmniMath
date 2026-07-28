function percentile(values = [], p = 0.5) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function sum(values = []) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function avg(values = []) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length ? sum(finite) / finite.length : 0;
}

export function classifyBenchmarkRecord(record = {}) {
  if (record.skipped) return "benchmark_cost_cap_skipped";
  if (record.infrastructureFailure) return "provider_infrastructure_failure";
  if (record.structuredOutputFailure) return "malformed_structured_output";
  if (record.acceptable && record.correct) return "valid_correct_answer";
  if (record.acceptable && record.correctRejection) return "correct_rejection";
  if (record.rejected && record.correctRejection) return "correct_rejection";
  if (record.rejected && record.expectedCorrect) return "false_positive_validator_rejection";
  if (record.rejected) return "mathematically_incorrect_answer_rejected";
  if (record.acceptable) return "valid_correct_answer";
  return "mathematically_incorrect_answer_returned";
}

export function aggregateBenchmarkResults(records = []) {
  const attemptedRecords = records.filter((record) => !record.skipped);
  const attempts = attemptedRecords.length;
  const byOutcome = new Map();
  for (const record of records) {
    const outcome = record.outcome || classifyBenchmarkRecord(record);
    byOutcome.set(outcome, (byOutcome.get(outcome) || 0) + 1);
  }
  const acceptable = (byOutcome.get("valid_correct_answer") || 0) + (byOutcome.get("correct_rejection") || 0);
  const totalCostUsd = sum(attemptedRecords.map((record) => Number(record.costUsd)));
  const latencies = attemptedRecords.map((record) => Number(record.latencyMs));
  const inputTokens = attemptedRecords.map((record) => Number(record.inputTokens));
  const outputTokens = attemptedRecords.map((record) => Number(record.outputTokens));
  const reasoningTokens = attemptedRecords.map((record) => Number(record.reasoningTokens));
  const transportAttempts = attemptedRecords.map((record) => Number(record.transportAttempts));
  const successfulProviderResponses = attemptedRecords.map((record) => Number(record.successfulProviderResponses));
  const billedProviderCalls = attemptedRecords.map((record) => Number(record.billedProviderCalls ?? record.providerCalls));
  return {
    totalAttempts: attempts,
    benchmarkSkipped: byOutcome.get("benchmark_cost_cap_skipped") || 0,
    validCorrectAnswers: byOutcome.get("valid_correct_answer") || 0,
    mathematicallyIncorrectAnswersRejected: byOutcome.get("mathematically_incorrect_answer_rejected") || 0,
    falsePositiveValidatorRejections: byOutcome.get("false_positive_validator_rejection") || 0,
    malformedStructuredOutputs: byOutcome.get("malformed_structured_output") || 0,
    providerInfrastructureFailures: byOutcome.get("provider_infrastructure_failure") || 0,
    correctRejections: byOutcome.get("correct_rejection") || 0,
    returnedWrongAnswers: byOutcome.get("mathematically_incorrect_answer_returned") || 0,
    repairFrequency: attemptedRecords.filter((record) => Number(record.providerCalls || 0) >= 2).length,
    escalationFrequency: attemptedRecords.filter((record) => Boolean(record.escalated)).length,
    finalSuccessRate: attempts ? (byOutcome.get("valid_correct_answer") || 0) / attempts : 0,
    correctRejectionRate: attempts ? (byOutcome.get("correct_rejection") || 0) / attempts : 0,
    acceptableOutcomeRate: attempts ? acceptable / attempts : 0,
    averageInputTokens: avg(inputTokens),
    averageOutputTokens: avg(outputTokens),
    averageReasoningTokens: avg(reasoningTokens),
    totalTransportAttempts: sum(transportAttempts),
    totalSuccessfulProviderResponses: sum(successfulProviderResponses),
    totalBilledProviderCalls: sum(billedProviderCalls),
    averageTransportAttempts: avg(transportAttempts),
    averageSuccessfulProviderResponses: avg(successfulProviderResponses),
    averageLatencyMs: avg(latencies),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    totalCostUsd,
    costPerValidCorrectAnswer: byOutcome.get("valid_correct_answer") ? totalCostUsd / byOutcome.get("valid_correct_answer") : null,
    costPerValidatedAcceptableOutcome: acceptable ? totalCostUsd / acceptable : null,
  };
}

export function summarizeBenchmarkByCandidate(records = []) {
  const groups = new Map();
  for (const record of records) {
    const key = record.candidateId || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()].map(([candidateId, groupRecords]) => ({
    candidateId,
    ...aggregateBenchmarkResults(groupRecords),
  }));
}
