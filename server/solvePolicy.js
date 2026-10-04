import { estimatePromptTokens, getSolveOutputTokenBudget } from "./openai.js";
import { DEFAULT_OPENAI_MODELS, getModelCapability, selectOpenAiModel } from "./openaiModels.js";
import { createSolveTimeoutError } from "./solveBudget.js";
import { resolveSolveRuntime } from "./solveRuntime.js";
import { inspectProblemDifficulty } from "./solverRouting.js";

const PROFILE_DEFAULTS = Object.freeze({
  simple: Object.freeze({ total: 45_000, primary: 35_000, recovery: 7_000, response: 3_000, output: 3_200, compact: 2_000 }),
  standard: Object.freeze({ total: 90_000, primary: 65_500, recovery: 22_500, response: 2_000, output: 6_500, compact: 3_200 }),
  advanced: Object.freeze({ total: 150_000, primary: 110_000, recovery: 35_000, response: 5_000, output: 12_000, compact: 6_000 }),
  elite: Object.freeze({ total: 240_000, primary: 180_000, recovery: 50_000, response: 10_000, output: 24_000, compact: 12_000 }),
});

const PROFILE_ENV_SUFFIX = Object.freeze({
  total: "TOTAL_TIMEOUT_MS",
  recovery: "RECOVERY_RESERVE_MS",
  response: "RESPONSE_RESERVE_MS",
  output: "MAX_OUTPUT_TOKENS",
  compact: "COMPACT_MAX_OUTPUT_TOKENS",
});

const RECOVERY_SELECTIONS_BY_MODE = Object.freeze({
  ordinary: Object.freeze(["timeout", "structured"]),
  progressive: Object.freeze(["timeout", "structured", "repair"]),
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readPositiveInteger(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== "string" || !raw.trim()) return { value: fallback, source: "profile_default" };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return { value: fallback, source: `${name}:invalid_fallback` };
  return { value: Math.max(1, Math.round(parsed)), source: name };
}

function profileEnvName(tier, field) {
  return `OMNIMATH_SOLVE_${tier.toUpperCase()}_${PROFILE_ENV_SUFFIX[field]}`;
}

function hasTierTimingOverride(tier) {
  return ["total", "recovery", "response"].some((field) => {
    const raw = process.env[profileEnvName(tier, field)];
    return typeof raw === "string" && raw.trim();
  });
}

function resolveRequestedProfile(tier, recoveryEligible) {
  const defaults = PROFILE_DEFAULTS[tier] || PROFILE_DEFAULTS.standard;
  const legacyRaw = process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS;
  const legacyTotal = Number(legacyRaw);
  const validLegacy = typeof legacyRaw === "string" && legacyRaw.trim()
    && Number.isFinite(legacyTotal) && legacyTotal > 0;

  let total;
  let recovery;
  let response;
  let sources;
  if (validLegacy && !hasTierTimingOverride(tier)) {
    total = Math.round(legacyTotal);
    recovery = Math.min(30_000, Math.floor(total * 0.25));
    response = Math.min(2_000, Math.max(1, total - recovery - 1));
    sources = { total: "OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS", recovery: "legacy_25_percent", response: "legacy_completion_reserve" };
  } else {
    const totalSetting = readPositiveInteger(profileEnvName(tier, "total"), defaults.total);
    const recoverySetting = readPositiveInteger(profileEnvName(tier, "recovery"), defaults.recovery);
    const responseSetting = readPositiveInteger(profileEnvName(tier, "response"), defaults.response);
    total = totalSetting.value;
    recovery = recoverySetting.value;
    response = responseSetting.value;
    sources = { total: totalSetting.source, recovery: recoverySetting.source, response: responseSetting.source };
  }

  if (!recoveryEligible) recovery = 0;
  const maxResponseReserve = Math.max(1, Math.floor(total * 0.1));
  if (response > maxResponseReserve) {
    response = maxResponseReserve;
    sources.response = `${sources.response}:clamped_10_percent`;
  }
  if (recovery + response >= total) {
    const reserveRatio = Math.max(1, total - 1) / Math.max(1, recovery + response);
    recovery = Math.floor(recovery * reserveRatio);
    response = Math.max(1, Math.floor(response * reserveRatio));
    if (recovery + response >= total) recovery = Math.max(0, total - response - 1);
  }
  const primary = total - recovery - response;
  return { total, primary, recovery, response, sources };
}

function applyRuntimeCap(profile, { endpoint, runtimeStartedAt, now }) {
  const runtime = resolveSolveRuntime({ endpoint, runtimeStartedAt, now });
  const available = runtime.runtimeAvailableBudgetMs === null
    ? profile.total
    : runtime.runtimeAvailableBudgetMs;
  if (runtime.effectiveRuntimeCeilingMs !== null && available < 2) {
    const error = createSolveTimeoutError({ timeoutSource: "total_solve_deadline", budgetLimitReason: "deployment_runtime_budget" });
    Object.assign(error, runtime);
    throw error;
  }
  const common = {
    runtimeLimitMs: runtime.effectiveRuntimeCeilingMs,
    runtimeLimitSource: runtime.runtimeLimitSource,
    runtimeRemainingMs: runtime.effectiveRuntimeCeilingMs === null
      ? null
      : Math.max(0, runtime.effectiveRuntimeCeilingMs - runtime.elapsedPreSolveWorkMs),
    infrastructureHeadroomMs: runtime.deploymentHeadroomMs,
    deploymentMaxDurationMs: runtime.deploymentMaxDurationMs,
    deploymentHeadroomMs: runtime.deploymentHeadroomMs,
    elapsedPreSolveWorkMs: runtime.elapsedPreSolveWorkMs,
    runtimeAvailableBudgetMs: runtime.runtimeAvailableBudgetMs,
    configuredRuntimeCeilingMs: runtime.configuredRuntimeCeilingMs,
    effectiveRuntimeCeilingMs: runtime.effectiveRuntimeCeilingMs,
    policySelectedAt: runtime.selectedAtMs,
  };
  if (available >= profile.total) {
    return {
      ...profile,
      ...common,
      canonicalDeadlineAt: runtime.latestCanonicalDeadlineAt === null
        ? runtime.selectedAtMs + profile.total
        : Math.min(runtime.selectedAtMs + profile.total, runtime.latestCanonicalDeadlineAt),
      runtimeCapApplied: false,
      runtimeCapReason: null,
    };
  }
  const total = Math.floor(available);
  const ratio = total / profile.total;
  const recovery = Math.floor(profile.recovery * ratio);
  const response = Math.max(1, Math.floor(profile.response * ratio));
  const primary = Math.max(1, total - recovery - response);
  return {
    ...profile,
    ...common,
    total,
    primary,
    recovery,
    response,
    canonicalDeadlineAt: runtime.latestCanonicalDeadlineAt,
    runtimeCapApplied: true,
    runtimeCapReason: runtime.runtimeLimitSource === "environment"
      ? "configured_runtime_ceiling"
      : "deployment_max_duration",
  };
}

function resolveOutputBudget(tier, selection, modelPath, compact) {
  const field = compact ? "compact" : "output";
  const setting = readPositiveInteger(profileEnvName(tier, field), PROFILE_DEFAULTS[tier][field]);
  const roleBudget = getSolveOutputTokenBudget({ compact, modelPath, debugContext: { attemptType: "policy_selection" } });
  const tierOverrideValid = setting.source !== "profile_default" && !setting.source.endsWith(":invalid_fallback");
  const requested = tierOverrideValid ? setting.value : Math.min(setting.value, roleBudget);
  const capability = Number(selection.maxOutputTokenCapability ?? selection.maxOutputTokens);
  return Math.max(1, Math.floor(Number.isFinite(capability) && capability > 0 ? Math.min(requested, capability) : requested));
}

function makeSelection(tier, modelPath, debugContext = {}) {
  const rawSelection = selectOpenAiModel({ modelPath, debugContext });
  const fallbackPricing = getModelCapability(DEFAULT_OPENAI_MODELS.solver);
  const missingInputPrice = typeof rawSelection.inputCostPer1M !== "number"
    || !Number.isFinite(rawSelection.inputCostPer1M);
  const missingOutputPrice = typeof rawSelection.outputCostPer1M !== "number"
    || !Number.isFinite(rawSelection.outputCostPer1M);
  const selected = missingInputPrice || missingOutputPrice
    ? {
        ...rawSelection,
        inputCostPer1M: missingInputPrice ? fallbackPricing.inputCostPer1M : rawSelection.inputCostPer1M,
        outputCostPer1M: missingOutputPrice ? fallbackPricing.outputCostPer1M : rawSelection.outputCostPer1M,
        pricingSource: "unknown_model_policy_default_estimate",
      }
    : rawSelection;
  const maxOutputTokens = resolveOutputBudget(tier, selected, modelPath, false);
  return {
    ...selected,
    maxOutputTokens,
    compactMaxOutputTokens: Math.min(maxOutputTokens, resolveOutputBudget(tier, selected, modelPath, true)),
  };
}

function resolveRecoveryStrategy() {
  const configured = String(process.env.OMNIMATH_SOLVE_TIMEOUT_RECOVERY_STRATEGY || "same_route").trim().toLowerCase();
  return ["same_route", "escalation", "disabled"].includes(configured) ? configured : "same_route";
}

export function selectSolvePolicy(input = {}, {
  endpoint = "/api/explain",
  runtimeStartedAt = null,
  now = Date.now(),
  recoveryMode = "ordinary",
} = {}) {
  const difficulty = inspectProblemDifficulty(input);
  const tier = difficulty.tier;
  const actualRepair = difficulty.reason === "prior_symbol_validation_failure";
  const role = actualRepair ? "repair" : tier === "simple" || tier === "standard" ? "solver" : "hardSolve";
  const modelPath = role === "solver" ? "canonicalSolve" : role;
  const initialSelection = makeSelection(tier, modelPath, { attemptType: "initial" });
  const strategy = resolveRecoveryStrategy();
  const recoveryEligible = strategy !== "disabled";
  const resolvedRecoveryMode = recoveryMode === "progressive" ? "progressive" : "ordinary";
  const allowedSelections = recoveryEligible
    ? [...RECOVERY_SELECTIONS_BY_MODE[resolvedRecoveryMode]]
    : [];
  const timeoutPath = strategy === "escalation" ? "escalation" : modelPath;
  const recoverySelections = {
    timeout: makeSelection(tier, timeoutPath, { attemptType: "timeout_recovery", retryPurpose: "timeout" }),
    structured: makeSelection(tier, "escalation", { attemptType: "structured_recovery", retryPurpose: "structured" }),
    repair: makeSelection(tier, "repair", { attemptType: "repair", retryPurpose: "quality-repair" }),
  };
  const requestedProfile = resolveRequestedProfile(tier, recoveryEligible);
  const effectiveProfile = applyRuntimeCap(requestedProfile, { endpoint, runtimeStartedAt, now });
  const budgetProfile = `${tier}${effectiveProfile.runtimeCapApplied ? "_runtime_capped" : ""}`;

  return deepFreeze({
    difficultyTier: tier,
    routingReason: difficulty.reason,
    features: difficulty.features,
    role,
    modelPath,
    model: initialSelection.modelId,
    reasoningEffort: initialSelection.reasoningEffort,
    maxOutputTokens: initialSelection.maxOutputTokens,
    compactMaxOutputTokens: initialSelection.compactMaxOutputTokens,
    initialSelection,
    recoverySelections,
    budgetProfile,
    selectedPolicyBudgetMs: requestedProfile.total,
    requestedCanonicalBudgetMs: requestedProfile.total,
    effectiveCanonicalBudgetMs: effectiveProfile.total,
    canonicalBudgetMs: effectiveProfile.total,
    primaryBudgetMs: effectiveProfile.primary,
    recoveryBudgetMs: effectiveProfile.recovery,
    responseReserveMs: effectiveProfile.response,
    runtimeCapApplied: effectiveProfile.runtimeCapApplied,
    budgetCappedByRuntime: effectiveProfile.runtimeCapApplied,
    runtimeCapReason: effectiveProfile.runtimeCapReason,
    runtimeLimitMs: effectiveProfile.runtimeLimitMs,
    runtimeLimitSource: effectiveProfile.runtimeLimitSource,
    runtimeRemainingMs: effectiveProfile.runtimeRemainingMs,
    infrastructureHeadroomMs: effectiveProfile.infrastructureHeadroomMs,
    deploymentMaxDurationMs: effectiveProfile.deploymentMaxDurationMs,
    deploymentHeadroomMs: effectiveProfile.deploymentHeadroomMs,
    elapsedPreSolveWorkMs: effectiveProfile.elapsedPreSolveWorkMs,
    runtimeAvailableBudgetMs: effectiveProfile.runtimeAvailableBudgetMs,
    configuredRuntimeCeilingMs: effectiveProfile.configuredRuntimeCeilingMs,
    effectiveRuntimeCeilingMs: effectiveProfile.effectiveRuntimeCeilingMs,
    policySelectedAt: effectiveProfile.policySelectedAt,
    canonicalDeadlineAt: effectiveProfile.canonicalDeadlineAt,
    budgetSources: requestedProfile.sources,
    maxRouteAttempts: recoveryEligible ? 2 : 1,
    recoveryEligible,
    recoveryMode: resolvedRecoveryMode,
    recoveryPolicy: {
      strategy,
      eligible: recoveryEligible,
      allowCompactRetry: false,
      allowedSelections,
      maxRouteAttempts: recoveryEligible ? 2 : 1,
      timeoutSelection: "timeout",
      structuredSelection: "structured",
      repairSelection: "repair",
    },
  });
}

function estimateAttempt(selection, prompt, { inputOverheadTokens = 0, maxOutputTokens = selection.maxOutputTokens, variant = "full" } = {}) {
  const estimatedInputTokens = estimatePromptTokens(prompt) + inputOverheadTokens;
  const estimatedMaxOutputTokens = maxOutputTokens;
  const inputCostPer1M = selection.inputCostPer1M;
  const outputCostPer1M = selection.outputCostPer1M;
  const estimatedCostUsd = typeof inputCostPer1M === "number" && Number.isFinite(inputCostPer1M)
    && typeof outputCostPer1M === "number" && Number.isFinite(outputCostPer1M)
    ? (estimatedInputTokens / 1_000_000 * inputCostPer1M) + (estimatedMaxOutputTokens / 1_000_000 * outputCostPer1M)
    : null;
  return {
    model: selection.modelId,
    role: selection.role,
    variant,
    pricingSource: selection.pricingSource || null,
    inputCostPer1M,
    outputCostPer1M,
    inputOverheadTokens,
    estimatedInputTokens,
    estimatedMaxOutputTokens,
    estimatedTokens: estimatedInputTokens + estimatedMaxOutputTokens,
    estimatedCostUsd,
    estimatedCostMicros: estimatedCostUsd === null ? null : Math.ceil(estimatedCostUsd * 1_000_000),
  };
}

export function estimateSolvePolicyReservation({ policy, prompt = "" } = {}) {
  if (!policy?.initialSelection) throw new TypeError("A selected solve policy is required.");
  const primary = estimateAttempt(policy.initialSelection, prompt);
  const allowedSelections = new Set(policy.recoveryPolicy?.allowedSelections || []);
  const recoveryCandidates = policy.recoveryEligible
    ? Object.entries(policy.recoverySelections || {})
      .filter(([name]) => allowedSelections.has(name))
      .map(([name, selection]) => estimateAttempt(selection, prompt, {
        inputOverheadTokens: policy.recoveryMode === "progressive" && name === "repair" ? 4_096 : 512,
        variant: name,
      }))
    : [];
  const unpricedAttempt = [primary, ...recoveryCandidates]
    .find((attempt) => typeof attempt.estimatedCostUsd !== "number"
      || !Number.isFinite(attempt.estimatedCostUsd));
  if (unpricedAttempt) {
    throw Object.assign(new Error(`No cost estimate is configured for ${unpricedAttempt.model || "the selected model"}.`), {
      statusCode: 500,
      code: "SERVER_CONFIG_ERROR",
      publicMessage: "The selected AI model does not have a valid cost configuration.",
    });
  }
  const recovery = recoveryCandidates.reduce((largest, candidate) => {
    if (!largest) return candidate;
    if (candidate.estimatedCostUsd === null) return largest.estimatedCostUsd === null ? largest : candidate;
    if (largest.estimatedCostUsd === null) return largest;
    return candidate.estimatedCostUsd > largest.estimatedCostUsd ? candidate : largest;
  }, null);
  const maxRecoveryInputTokens = Math.max(0, ...recoveryCandidates.map((candidate) => candidate.estimatedInputTokens));
  const maxRecoveryOutputTokens = Math.max(0, ...recoveryCandidates.map((candidate) => candidate.estimatedMaxOutputTokens));
  const estimatedInputTokens = primary.estimatedInputTokens + maxRecoveryInputTokens;
  const estimatedMaxOutputTokens = primary.estimatedMaxOutputTokens + maxRecoveryOutputTokens;
  const estimatedCostUsd = primary.estimatedCostUsd === null || (recovery && recovery.estimatedCostUsd === null)
    ? null
    : primary.estimatedCostUsd + (recovery?.estimatedCostUsd || 0);
  const pricingSources = [...new Set([primary, ...recoveryCandidates]
    .map((attempt) => attempt.pricingSource).filter(Boolean))];
  return deepFreeze({
    primary,
    recovery,
    recoveryCandidates,
    estimatedTokens: estimatedInputTokens + estimatedMaxOutputTokens,
    estimatedInputTokens,
    estimatedMaxOutputTokens,
    estimatedCostUsd,
    estimatedCostMicros: estimatedCostUsd === null ? null : Math.ceil(estimatedCostUsd * 1_000_000),
    semanticGenerationLimit: policy.recoveryEligible ? 2 : 1,
    providerUsageAfterAbortMayBeUnknown: true,
    estimateKind: "conservative_selected_route_envelope",
    recoveryEstimateKind: policy.recoveryMode === "progressive"
      ? "timeout_structured_or_bounded_repair"
      : "timeout_or_structured",
    pricingSources,
    pricingFallbackUsed: pricingSources.includes("unknown_model_policy_default_estimate"),
  });
}

export function policyTelemetry(policy, reservation = null) {
  return {
    difficultyTier: policy.difficultyTier,
    routingReason: policy.routingReason,
    selectedModelRole: policy.role,
    selectedModel: policy.model,
    reasoningEffort: policy.reasoningEffort,
    budgetProfile: policy.budgetProfile,
    selectedPolicyBudgetMs: policy.selectedPolicyBudgetMs,
    requestedCanonicalBudgetMs: policy.requestedCanonicalBudgetMs,
    effectiveCanonicalBudgetMs: policy.effectiveCanonicalBudgetMs,
    canonicalBudgetMs: policy.canonicalBudgetMs,
    primaryBudgetMs: policy.primaryBudgetMs,
    recoveryBudgetMs: policy.recoveryBudgetMs,
    responseReserveMs: policy.responseReserveMs,
    maxOutputTokens: policy.maxOutputTokens,
    compactMaxOutputTokens: policy.compactMaxOutputTokens,
    recoveryStrategy: policy.recoveryPolicy.strategy,
    recoveryMode: policy.recoveryMode,
    allowedRecoverySelections: policy.recoveryPolicy.allowedSelections,
    maxRouteAttempts: policy.maxRouteAttempts,
    runtimeCapApplied: policy.runtimeCapApplied,
    budgetCappedByRuntime: policy.budgetCappedByRuntime,
    runtimeCapReason: policy.runtimeCapReason,
    runtimeLimitMs: policy.runtimeLimitMs,
    runtimeLimitSource: policy.runtimeLimitSource,
    infrastructureHeadroomMs: policy.infrastructureHeadroomMs,
    deploymentMaxDurationMs: policy.deploymentMaxDurationMs,
    deploymentHeadroomMs: policy.deploymentHeadroomMs,
    elapsedPreSolveWorkMs: policy.elapsedPreSolveWorkMs,
    runtimeAvailableBudgetMs: policy.runtimeAvailableBudgetMs,
    configuredRuntimeCeilingMs: policy.configuredRuntimeCeilingMs,
    effectiveRuntimeCeilingMs: policy.effectiveRuntimeCeilingMs,
    policySelectedAt: policy.policySelectedAt,
    canonicalDeadlineAt: policy.canonicalDeadlineAt,
    budgetSources: policy.budgetSources,
    routingFeatures: policy.features,
    estimatedInputTokens: reservation?.estimatedInputTokens ?? null,
    estimatedMaxOutputTokens: reservation?.estimatedMaxOutputTokens ?? null,
    estimatedCostMicros: reservation?.estimatedCostMicros ?? null,
    costEstimateKind: reservation?.estimateKind ?? null,
    recoveryEstimateKind: reservation?.recoveryEstimateKind ?? null,
    pricingSources: reservation?.pricingSources ?? null,
    pricingFallbackUsed: reservation?.pricingFallbackUsed ?? null,
  };
}

export { PROFILE_DEFAULTS as DEFAULT_SOLVE_POLICY_PROFILES };
