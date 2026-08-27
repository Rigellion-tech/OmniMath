import { createRequire } from "node:module";

const STAGE_EVENT = "[omnimath:solve-orchestration-stage]";
const SUMMARY_EVENT = "[omnimath:solve-orchestration-summary]";

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION = "unknown" } = require("../package.json");

export const ORCHESTRATION_POLICY_VERSION = "structural-accept-v1";

function safeCohortValue(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) return null;
  return /^[a-z0-9._:@/-]+$/iu.test(normalized) ? normalized : null;
}

export function resolveSolveTelemetryBuildVersion(env = process.env) {
  const candidates = [
    ["OMNIMATH_BUILD_ID", env.OMNIMATH_BUILD_ID],
    ["VERCEL_GIT_COMMIT_SHA", env.VERCEL_GIT_COMMIT_SHA],
    ["GITHUB_SHA", env.GITHUB_SHA],
    ["GIT_COMMIT_SHA", env.GIT_COMMIT_SHA],
    ["COMMIT_SHA", env.COMMIT_SHA],
    ["VERCEL_DEPLOYMENT_ID", env.VERCEL_DEPLOYMENT_ID],
  ];
  for (const [source, value] of candidates) {
    const buildVersion = safeCohortValue(value);
    if (buildVersion) return Object.freeze({ buildVersion, buildVersionSource: source });
  }
  return Object.freeze({
    buildVersion: safeCohortValue(PACKAGE_VERSION) || "unknown",
    buildVersionSource: "package.json",
  });
}

export const solveOrchestrationTelemetryCohort = Object.freeze({
  orchestrationPolicyVersion: ORCHESTRATION_POLICY_VERSION,
  ...resolveSolveTelemetryBuildVersion(),
});

const GENERATION_STAGES = new Set([
  "initial",
  "initial_compact",
]);

function nonNegativeInteger(value) {
  return Math.max(0, Math.ceil(Number(value) || 0));
}

function nonNegativeNumber(value) {
  return Math.max(0, Number(value) || 0);
}

function safeClassification(value = null) {
  if (!value) return null;
  if (typeof value === "string") return { category: value };
  if (typeof value !== "object") return { category: String(value) };
  return {
    category: value.category || null,
    errorCode: value.errorCode || value.code || null,
    responseFailureType: value.responseFailureType || null,
    hasParsedCandidate: value.hasParsedCandidate ?? null,
  };
}

function stageFromSource(source = "") {
  const normalized = String(source || "").replace(/_/gu, "-").toLowerCase();
  if (normalized.includes("initial-compact")) return "initial_compact";
  if (normalized.includes("initial")) return "initial";
  return null;
}

function safeConsoleInfo(label, payload) {
  try {
    console.info(label, payload);
  } catch {
    // Telemetry must never affect solve behavior.
  }
}

export function createSolveOrchestrationTelemetry({
  requestId = "",
  endpoint = "",
  startedAt = Date.now(),
  cohort = solveOrchestrationTelemetryCohort,
  timestampNow = () => new Date(),
} = {}) {
  const records = [];
  let finalized = false;
  let fallbackStage = null;
  const solveCohort = Object.freeze({
    orchestrationPolicyVersion: safeCohortValue(cohort?.orchestrationPolicyVersion)
      || ORCHESTRATION_POLICY_VERSION,
    buildVersion: safeCohortValue(cohort?.buildVersion) || "unknown",
    buildVersionSource: safeCohortValue(cohort?.buildVersionSource) || "unknown",
  });

  function safely(action, fallback = null) {
    try {
      return action();
    } catch {
      return fallback;
    }
  }

  function emissionMetadata() {
    const eventTimestamp = safely(() => {
      const timestamp = timestampNow();
      return (timestamp instanceof Date ? timestamp : new Date(timestamp)).toISOString();
    });
    return { eventTimestamp, ...solveCohort };
  }

  function recordGenerationAttempt(details = {}) {
    return safely(() => {
      if (finalized) return null;
      const generationStage = GENERATION_STAGES.has(details.generationStage)
        ? details.generationStage
        : "initial";
      const previous = records.at(-1);
      if (previous && !previous.transitionTo) {
        previous.transitionTo = generationStage;
        previous.transitionFailureClassification = previous.failureClassification;
      }
      const inputTokens = nonNegativeInteger(details.inputTokens);
      const visibleOutputTokens = nonNegativeInteger(details.visibleOutputTokens);
      const reasoningTokens = nonNegativeInteger(details.reasoningTokens);
      const totalTokens = nonNegativeInteger(
        details.totalTokens || inputTokens + visibleOutputTokens + reasoningTokens,
      );
      const record = {
        requestId: details.requestId || requestId || null,
        solveId: details.solveId || details.requestId || requestId || null,
        endpoint: details.endpoint || endpoint || null,
        modelRole: details.modelRole || null,
        model: details.model || null,
        solveMode: details.solveMode || null,
        generationStage,
        attemptIndex: records.length + 1,
        httpAttemptCount: nonNegativeInteger(details.httpAttemptCount),
        responseClassification: details.responseClassification || null,
        providerResponseOutcome: details.providerResponseOutcome
          || (details.candidateProduced ? "success" : "failure"),
        candidateProduced: Boolean(details.candidateProduced),
        parsedCandidateProduced: Boolean(details.candidateProduced),
        candidateId: details.candidateId || null,
        candidateProvenance: details.candidateProvenance || null,
        structuralParseOutcome: details.structuralParseOutcome
          || (details.candidateProduced ? "passed" : "failed"),
        failureClassification: safeClassification(details.failureClassification),
        retryReason: details.retryReason
          || details.failureClassification?.responseFailureType
          || details.failureClassification?.errorCode
          || null,
        transitionTo: null,
        transitionFailureClassification: null,
        compactRetryAttempted: Boolean(details.compactRetryAttempted || generationStage.endsWith("_compact")),
        compactRetrySuppressedByPolicy: Boolean(details.compactRetrySuppressedByPolicy),
        fallbackUsed: false,
        selectedForFinal: false,
        inputTokens,
        visibleOutputTokens,
        reasoningTokens,
        totalTokens,
        durationMs: nonNegativeNumber(details.durationMs),
        estimatedCostUsd: details.estimatedCostUsd === null || details.estimatedCostUsd === undefined
          ? null
          : nonNegativeNumber(details.estimatedCostUsd),
      };
      records.push(record);
      return record.attemptIndex;
    });
  }

  function recordCandidateSelection({
    generationStage = null,
    responseClassification = null,
    candidateId = null,
    candidateProvenance = null,
  } = {}) {
    return safely(() => {
      const record = [...records].reverse().find((candidate) => (
        candidate.candidateProduced
        && (!generationStage || candidate.generationStage === generationStage)
        && !candidate.selectedForFinal
      ));
      if (!record) return false;
      record.structuralParseOutcome = "passed";
      record.responseClassification = responseClassification || "parsed_candidate";
      if (candidateId) record.candidateId = candidateId;
      if (candidateProvenance) record.candidateProvenance = candidateProvenance;
      return true;
    }, false);
  }

  function recordFallback({ source = "", candidateId = null } = {}) {
    return safely(() => {
      fallbackStage = stageFromSource(source);
      const record = [...records].reverse().find((candidate) => (
        candidate.candidateProduced
        && (!fallbackStage || candidate.generationStage === fallbackStage)
        && (!candidateId || !candidate.candidateId || candidate.candidateId === candidateId)
      ));
      if (!record) return false;
      record.fallbackUsed = true;
      if (candidateId) record.candidateId = candidateId;
      fallbackStage = record.generationStage;
      return true;
    }, false);
  }

  function finalize({
    finalOutcome = "success",
    finalFailureClassification = null,
    fallbackUsed = false,
    finalGenerationStage = null,
  } = {}) {
    return safely(() => {
      if (finalized) return null;
      finalized = true;
      const selectedStage = finalGenerationStage || fallbackStage;
      let selectedRecord = null;
      if (selectedStage) {
        selectedRecord = [...records].reverse().find((record) => record.generationStage === selectedStage) || null;
        if (selectedRecord) selectedRecord.selectedForFinal = true;
      }
      const totalInputTokens = records.reduce((sum, record) => sum + record.inputTokens, 0);
      const totalVisibleOutputTokens = records.reduce((sum, record) => sum + record.visibleOutputTokens, 0);
      const totalReasoningTokens = records.reduce((sum, record) => sum + record.reasoningTokens, 0);
      const totalTokens = records.reduce((sum, record) => sum + record.totalTokens, 0);
      const costIsReliable = records.every((record) => record.estimatedCostUsd !== null);
      const summary = {
        requestId: requestId || null,
        solveId: requestId || null,
        endpoint: endpoint || null,
        generationCount: records.length,
        HTTPAttemptCount: records.reduce((sum, record) => sum + record.httpAttemptCount, 0),
        initialCompactUsed: records.some((record) => record.generationStage === "initial_compact"),
        responseGenerationRetryUsed: records.some((record) => record.generationStage === "initial_compact")
          || records.some((record) => record.httpAttemptCount > 1),
        lateCompactSuppressed: records.some((record) => record.compactRetrySuppressedByPolicy),
        fallbackUsed: Boolean(fallbackUsed || fallbackStage),
        finalGenerationStage: selectedStage || null,
        finalModel: selectedRecord?.model || null,
        modelsUsed: [...new Set(records.map((record) => record.model).filter(Boolean))],
        finalOutcome,
        finalFailureClassification: safeClassification(finalFailureClassification),
        totalInputTokens,
        totalVisibleOutputTokens,
        totalReasoningTokens,
        totalTokens,
        totalDurationMs: nonNegativeNumber(Date.now() - startedAt),
        totalEstimatedCostUsd: costIsReliable
          ? records.reduce((sum, record) => sum + record.estimatedCostUsd, 0)
          : null,
      };
      const eventMetadata = emissionMetadata();
      for (const record of records) safeConsoleInfo(STAGE_EVENT, { ...record, ...eventMetadata });
      const emittedSummary = { ...summary, ...eventMetadata };
      safeConsoleInfo(SUMMARY_EVENT, emittedSummary);
      return emittedSummary;
    });
  }

  return Object.freeze({
    recordGenerationAttempt,
    recordCandidateSelection,
    recordFallback,
    finalize,
  });
}

export const solveOrchestrationTelemetryEvents = Object.freeze({
  stage: STAGE_EVENT,
  summary: SUMMARY_EVENT,
});
