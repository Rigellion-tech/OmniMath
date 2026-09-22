import { loadEnvFiles } from "./env.js";

loadEnvFiles();

export const MODEL_ROLES = Object.freeze({
  IMAGE_EXTRACTION: "extraction",
  EXTRACTION_REVIEW: "extractionReview",
  SOLVER: "standardSolve",
  REPAIR: "repair",
  ESCALATION: "escalation",
  PREMIUM_ESCALATION: "premiumEscalation",
  HOVER: "hover",
  PINNED: "pinned",
});

export const DEFAULT_OPENAI_MODELS = {
  imageExtraction: "gpt-4.1",
  extractionReview: "gpt-4.1-mini",
  solver: "gpt-5.6-sol",
  repair: "gpt-5.6-sol",
  escalation: "gpt-5.6-sol",
  premiumEscalation: "gpt-5.6-sol",
  hover: "gpt-4.1-mini",
  pinned: "gpt-4.1-mini",
};

// Shared canonical solve requests use Sol even when the generic solver role is configured differently.
export const CANONICAL_SOLVE_MODEL = "gpt-5.6-sol";

export const DEFAULT_OPENAI_SAMPLING = {
  solver: {
    temperature: 0,
    top_p: 1,
  },
  repair: {
    temperature: 0,
    top_p: 1,
  },
  escalation: {
    temperature: 0,
    top_p: 1,
  },
  premiumEscalation: {
    temperature: 0,
    top_p: 1,
  },
};

export const OPENAI_TIMEOUT_LIMITS = Object.freeze({
  minMs: 5000,
  maxMs: 300000,
});

export const DEFAULT_OPENAI_TIMEOUTS_MS = Object.freeze({
  imageExtraction: 60000,
  extractionReview: 60000,
  solver: 60000,
  repair: 120000,
  escalation: 180000,
  premiumEscalation: 180000,
  hover: 30000,
  pinned: 30000,
});

const ROLE_TIMEOUT_ENV = Object.freeze({
  imageExtraction: "OMNIMATH_OPENAI_IMAGE_EXTRACTION_TIMEOUT_MS",
  extractionReview: "OMNIMATH_OPENAI_EXTRACTION_REVIEW_TIMEOUT_MS",
  solver: "OMNIMATH_OPENAI_SOLVER_TIMEOUT_MS",
  repair: "OMNIMATH_OPENAI_REPAIR_TIMEOUT_MS",
  escalation: "OMNIMATH_OPENAI_ESCALATION_TIMEOUT_MS",
  premiumEscalation: "OMNIMATH_OPENAI_PREMIUM_ESCALATION_TIMEOUT_MS",
  hover: "OMNIMATH_OPENAI_LAZY_TIMEOUT_MS",
  pinned: "OMNIMATH_OPENAI_LAZY_TIMEOUT_MS",
});

const ROLE_DEFAULT_REASONING_EFFORT = {
  solver: "medium",
  repair: "high",
  escalation: "high",
  premiumEscalation: "high",
};

const ROLE_MODEL_ENV = {
  imageExtraction: ["OMNIMATH_IMAGE_EXTRACTION_MODEL", "OPENAI_IMAGE_EXTRACTION_MODEL"],
  extractionReview: ["OMNIMATH_EXTRACTION_REVIEW_MODEL", "OPENAI_EXTRACTION_REVIEW_MODEL"],
  solver: ["OMNIMATH_SOLVER_MODEL", "OPENAI_SOLVER_MODEL"],
  repair: ["OMNIMATH_REPAIR_MODEL", "OPENAI_REPAIR_MODEL"],
  escalation: ["OMNIMATH_ESCALATION_MODEL", "OPENAI_ESCALATION_MODEL"],
  premiumEscalation: ["OMNIMATH_PREMIUM_ESCALATION_MODEL", "OPENAI_PREMIUM_ESCALATION_MODEL", "OMNIMATH_ESCALATION_MODEL", "OPENAI_ESCALATION_MODEL"],
  hover: ["OMNIMATH_HOVER_MODEL", "OPENAI_HOVER_MODEL", "OPENAI_LAZY_MODEL"],
  pinned: ["OMNIMATH_PINNED_MODEL", "OPENAI_PINNED_MODEL", "OPENAI_LAZY_MODEL"],
};

const ROLE_MODEL_FALLBACK_ENV = {
  repair: ["OMNIMATH_SOLVER_MODEL", "OPENAI_SOLVER_MODEL"],
};

const ROLE_EFFORT_ENV = {
  solver: ["OMNIMATH_SOLVER_REASONING_EFFORT"],
  repair: ["OMNIMATH_REPAIR_REASONING_EFFORT", "OMNIMATH_SOLVER_REASONING_EFFORT"],
  escalation: ["OMNIMATH_ESCALATION_REASONING_EFFORT"],
  premiumEscalation: ["OMNIMATH_PREMIUM_ESCALATION_REASONING_EFFORT", "OMNIMATH_ESCALATION_REASONING_EFFORT"],
};

const MODEL_CAPABILITY_RULES = [
  {
    name: "o-series",
    pattern: /^o(?:1|3|4)(?:-|$)/iu,
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    allowSampling: false,
    structuredOutput: true,
    maxOutputTokens: 6500,
    inputCostPer1M: 10,
    outputCostPer1M: 40,
    pricingSource: "configurable_default_estimate",
  },
  {
    name: "gpt-5.6-sol",
    pattern: /^gpt-5\.6(?:-sol)?$/iu,
    reasoning: true,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    allowSampling: false,
    structuredOutput: true,
    maxOutputTokens: 128000,
    inputCostPer1M: 5,
    outputCostPer1M: 30,
    pricingSource: "configurable_default_estimate",
  },
  {
    name: "gpt-5.6-terra",
    pattern: /^gpt-5\.6-terra$/iu,
    reasoning: true,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    allowSampling: false,
    structuredOutput: true,
    maxOutputTokens: 128000,
    inputCostPer1M: 2.5,
    outputCostPer1M: 15,
    pricingSource: "configurable_default_estimate",
  },
  {
    name: "gpt-5.6-luna",
    pattern: /^gpt-5\.6-luna$/iu,
    reasoning: true,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    allowSampling: false,
    structuredOutput: true,
    maxOutputTokens: 128000,
    inputCostPer1M: 1,
    outputCostPer1M: 6,
    pricingSource: "configurable_default_estimate",
  },
  {
    name: "gpt-5-reasoning",
    pattern: /^gpt-5(?:\.|$|-)/iu,
    reasoning: true,
    reasoningEfforts: ["minimal", "low", "medium", "high"],
    allowSampling: false,
    structuredOutput: true,
    maxOutputTokens: 6500,
    inputCostPer1M: 5,
    outputCostPer1M: 30,
    pricingSource: "configurable_default_estimate",
  },
  {
    name: "gpt-4.1",
    pattern: /^gpt-4\.1(?:-|$)/iu,
    reasoning: false,
    reasoningEfforts: [],
    allowSampling: true,
    structuredOutput: true,
    maxOutputTokens: 6500,
    inputCostPer1M: 5,
    outputCostPer1M: 30,
    pricingSource: "configurable_default_estimate",
  },
  {
    name: "gpt-4o",
    pattern: /^gpt-4o(?:-|$)/iu,
    reasoning: false,
    reasoningEfforts: [],
    allowSampling: true,
    structuredOutput: true,
    maxOutputTokens: 6500,
    inputCostPer1M: 5,
    outputCostPer1M: 20,
    pricingSource: "configurable_default_estimate",
  },
];

const UNKNOWN_MODEL_CAPABILITY = Object.freeze({
  name: "unknown",
  reasoning: false,
  reasoningEfforts: [],
  allowSampling: true,
  structuredOutput: true,
  maxOutputTokens: 6500,
  inputCostPer1M: null,
  outputCostPer1M: null,
  pricingSource: "global_env_fallback",
});

function firstEnv(names = []) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return {
        value: value.trim(),
        source: name,
      };
    }
  }
  return { value: "", source: "" };
}

function resolveRoleModel(role = "solver") {
  const primary = firstEnv(ROLE_MODEL_ENV[role] || []);
  if (primary.value) return primary;

  const fallback = firstEnv(ROLE_MODEL_FALLBACK_ENV[role] || []);
  if (fallback.value) {
    return {
      ...fallback,
      source: `${fallback.source}:role_fallback`,
    };
  }

  const defaultValue = DEFAULT_OPENAI_MODELS[role] || DEFAULT_OPENAI_MODELS.solver;
  return {
    value: defaultValue,
    source: "role_default",
  };
}

function readNumberEnv(names = [], fallback = null) {
  for (const name of names) {
    const value = Number(process.env[name]);
    if (Number.isFinite(value) && value >= 0) {
      return {
        value,
        source: name,
      };
    }
  }
  return { value: fallback, source: "" };
}

function roleFromPath(path = "solver", debugContext = {}) {
  if (path === "imageExtraction") return "imageExtraction";
  if (path === "extractionReview") return "extractionReview";
  if (path === "hover") return "hover";
  if (path === "pinned") return "pinned";
  if (path === "repair") return "repair";
  if (path === "premiumEscalation") return "premiumEscalation";
  if (path === "escalation") return "escalation";
  const attemptType = String(debugContext.attemptType || debugContext.retryPurpose || "").toLowerCase();
  if (attemptType.includes("repair")) return "repair";
  if (attemptType.includes("escalation")) return "escalation";
  return "solver";
}

export function resolveOpenAiRequestTimeout(role = "solver") {
  const resolvedRole = Object.hasOwn(DEFAULT_OPENAI_TIMEOUTS_MS, role)
    ? role
    : "solver";
  const envName = ROLE_TIMEOUT_ENV[resolvedRole];
  const defaultTimeoutMs = DEFAULT_OPENAI_TIMEOUTS_MS[resolvedRole];
  const rawValue = process.env[envName];
  const configuredValue = typeof rawValue === "string" && rawValue.trim()
    ? Number(rawValue)
    : null;

  if (configuredValue === null) {
    return {
      role: resolvedRole,
      timeoutMs: defaultTimeoutMs,
      timeoutSource: "role_default",
      timeoutEnv: envName,
      timeoutConfigStatus: "default",
      defaultTimeoutMs,
    };
  }

  if (!Number.isFinite(configuredValue) || configuredValue <= 0) {
    return {
      role: resolvedRole,
      timeoutMs: defaultTimeoutMs,
      timeoutSource: "role_default",
      timeoutEnv: envName,
      timeoutConfigStatus: "invalid_fallback",
      defaultTimeoutMs,
    };
  }

  const roundedValue = Math.round(configuredValue);
  const timeoutMs = Math.min(
    OPENAI_TIMEOUT_LIMITS.maxMs,
    Math.max(OPENAI_TIMEOUT_LIMITS.minMs, roundedValue),
  );
  const timeoutConfigStatus = timeoutMs === roundedValue
    ? "configured"
    : timeoutMs === OPENAI_TIMEOUT_LIMITS.minMs
      ? "clamped_min"
      : "clamped_max";

  return {
    role: resolvedRole,
    timeoutMs,
    timeoutSource: envName,
    timeoutEnv: envName,
    timeoutConfigStatus,
    defaultTimeoutMs,
  };
}

export function getOpenAiTimeoutPolicy() {
  return {
    minTimeoutMs: OPENAI_TIMEOUT_LIMITS.minMs,
    maxTimeoutMs: OPENAI_TIMEOUT_LIMITS.maxMs,
    compactRetryPolicy: "inherits_resolved_role",
    legacyRequestTimeoutConfigured: Boolean(
      typeof process.env.OPENAI_REQUEST_TIMEOUT_MS === "string"
      && process.env.OPENAI_REQUEST_TIMEOUT_MS.trim(),
    ),
    roles: Object.fromEntries(
      Object.keys(DEFAULT_OPENAI_TIMEOUTS_MS).map((role) => {
        const resolution = resolveOpenAiRequestTimeout(role);
        return [role, {
          timeoutMs: resolution.timeoutMs,
          timeoutSource: resolution.timeoutSource,
          timeoutEnv: resolution.timeoutEnv,
          timeoutConfigStatus: resolution.timeoutConfigStatus,
          defaultTimeoutMs: resolution.defaultTimeoutMs,
        }];
      }),
    ),
  };
}

export function getModelCapability(modelId = "") {
  const model = String(modelId || "").trim();
  const matched = MODEL_CAPABILITY_RULES.find((rule) => rule.pattern.test(model));
  return {
    ...UNKNOWN_MODEL_CAPABILITY,
    ...(matched || {}),
    modelId: model,
    known: Boolean(matched),
  };
}

function pricingEnvName(modelId = "", suffix = "") {
  const key = String(modelId || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key ? `OMNIMATH_MODEL_${key}_${suffix}` : "";
}

function resolvePricing(modelId = "", capability = {}) {
  const input = readNumberEnv([
    pricingEnvName(modelId, "INPUT_COST_PER_1M"),
    "OMNIMATH_DEFAULT_INPUT_COST_PER_1M_TOKENS",
    "OPENAI_INPUT_COST_PER_1M_TOKENS",
  ].filter(Boolean), capability.inputCostPer1M);
  const output = readNumberEnv([
    pricingEnvName(modelId, "OUTPUT_COST_PER_1M"),
    "OMNIMATH_DEFAULT_OUTPUT_COST_PER_1M_TOKENS",
    "OPENAI_OUTPUT_COST_PER_1M_TOKENS",
  ].filter(Boolean), capability.outputCostPer1M);
  return {
    inputCostPer1M: input.value,
    outputCostPer1M: output.value,
    pricingSource: input.source || output.source
      ? "environment"
      : capability.pricingSource || "global_env_fallback",
  };
}

function resolveReasoningEffort(role = "solver", capability = {}, debugContext = {}) {
  const requested = firstEnv(ROLE_EFFORT_ENV[role] || []);
  const defaultEffort = ROLE_DEFAULT_REASONING_EFFORT[role] || "medium";
  const candidate = requested.value || defaultEffort;
  if (debugContext.retryPurpose === "compact" && capability.reasoning) {
    const difficultRole = role === "repair" || role === "escalation" || role === "premiumEscalation";
    if (difficultRole && candidate !== "none") {
      const preferredEfforts = candidate === "low" || candidate === "minimal"
        ? [candidate, "low", "minimal"]
        : candidate === "medium"
          ? ["low", "medium", "minimal"]
          : ["medium", "low", "minimal"];
      const reducedCandidate = preferredEfforts
        .find((effort) => capability.reasoningEfforts.includes(effort));
      const effort = reducedCandidate
        || (capability.reasoningEfforts.includes(candidate) ? candidate : null);
      return {
        requestedEffort: effort || candidate,
        effort,
        source: "compact_retry_reduced_reasoning_policy",
        omittedReason: effort ? "" : "unsupported_reasoning_effort",
      };
    }
    if (!difficultRole && role === "solver") {
      const compactEffort = [candidate, "high", "medium", "low", "minimal", "none"]
        .find((effort) => capability.reasoningEfforts.includes(effort));
      return {
        requestedEffort: compactEffort || candidate,
        effort: compactEffort || null,
        source: "compact_solver_retry_inherits_authoritative_reasoning",
        omittedReason: compactEffort ? "" : "unsupported_reasoning_effort",
      };
    }
    if (!difficultRole && capability.reasoningEfforts.includes("none")) {
      return {
        requestedEffort: "none",
        effort: "none",
        source: "compact_retry_policy",
        omittedReason: "",
      };
    }
  }
  if (!capability.reasoning) {
    return {
      requestedEffort: requested.value || "",
      effort: null,
      source: requested.source || "",
      omittedReason: "model_does_not_support_reasoning",
    };
  }
  if (capability.reasoningEfforts.includes(candidate)) {
    return {
      requestedEffort: candidate,
      effort: candidate,
      source: requested.source || "role_default",
      omittedReason: "",
    };
  }
  return {
    requestedEffort: candidate,
    effort: null,
    source: requested.source || "role_default",
    omittedReason: "unsupported_reasoning_effort",
  };
}

export function getOpenAiModels() {
  const legacyLazyModel = process.env.OPENAI_LAZY_MODEL;

  return {
    imageExtraction: resolveRoleModel("imageExtraction").value,
    extractionReview: resolveRoleModel("extractionReview").value,
    solver: resolveRoleModel("solver").value,
    repair: resolveRoleModel("repair").value,
    escalation: resolveRoleModel("escalation").value,
    premiumEscalation: resolveRoleModel("premiumEscalation").value,
    hover: process.env.OMNIMATH_HOVER_MODEL || process.env.OPENAI_HOVER_MODEL || legacyLazyModel || DEFAULT_OPENAI_MODELS.hover,
    pinned: process.env.OMNIMATH_PINNED_MODEL || process.env.OPENAI_PINNED_MODEL || legacyLazyModel || DEFAULT_OPENAI_MODELS.pinned,
  };
}

export function getOpenAiModelResolutions() {
  return Object.fromEntries(Object.keys(DEFAULT_OPENAI_MODELS).map((role) => {
    const resolution = role === "hover" || role === "pinned"
      ? {
        value: getOpenAiModels()[role],
        source: firstEnv(ROLE_MODEL_ENV[role] || []).source || "role_default",
      }
      : resolveRoleModel(role);
    return [role, {
      modelId: resolution.value,
      modelSource: resolution.source,
    }];
  }));
}

export function getOpenAiModelForPath(path, debugContext = {}) {
  if (path === "canonicalSolve" && roleFromPath(path, debugContext) === "solver") {
    return CANONICAL_SOLVE_MODEL;
  }
  const role = roleFromPath(path, debugContext);
  return getOpenAiModels()[role] || getOpenAiModels().solver;
}

export function getOpenAiSamplingForPath(path, debugContext = {}) {
  const role = roleFromPath(path, debugContext);
  return DEFAULT_OPENAI_SAMPLING[role] ? { ...DEFAULT_OPENAI_SAMPLING[role] } : {};
}

export function selectOpenAiModel({
  modelPath = "solver",
  model = "",
  debugContext = {},
} = {}) {
  const role = roleFromPath(modelPath, debugContext);
  const modelSelection = modelPath === "canonicalSolve" && role === "solver"
    ? { value: CANONICAL_SOLVE_MODEL, source: "canonical_solve_policy" }
    : model
    ? { value: model, source: "explicit_override" }
    : resolveRoleModel(role);
  const modelId = modelSelection.value;
  const capability = getModelCapability(modelId);
  const reasoning = resolveReasoningEffort(role, capability, debugContext);
  const pricing = resolvePricing(modelId, capability);
  const timeout = resolveOpenAiRequestTimeout(role);
  const sampling = DEFAULT_OPENAI_SAMPLING[role] ? { ...DEFAULT_OPENAI_SAMPLING[role] } : {};
  const samplingOmitted = !capability.allowSampling && Object.keys(sampling).length > 0;
  return {
    role,
    modelPath,
    modelId,
    modelSource: modelSelection.source || "role_default",
    capabilityName: capability.name,
    knownModel: capability.known,
    supportsReasoning: capability.reasoning,
    supportedReasoningEfforts: [...capability.reasoningEfforts],
    reasoningEffort: reasoning.effort,
    requestedReasoningEffort: reasoning.requestedEffort,
    reasoningEffortSource: reasoning.source,
    reasoningOmittedReason: reasoning.omittedReason,
    allowSampling: capability.allowSampling,
    sampling: capability.allowSampling ? sampling : {},
    samplingOmitted,
    structuredOutput: capability.structuredOutput,
    maxOutputTokens: capability.maxOutputTokens,
    timeoutMs: timeout.timeoutMs,
    timeoutSource: timeout.timeoutSource,
    timeoutEnv: timeout.timeoutEnv,
    timeoutConfigStatus: timeout.timeoutConfigStatus,
    solveMode: debugContext.attemptType || debugContext.retryPurpose || "initial",
    freshSolve: role === "escalation" || role === "premiumEscalation",
    ...pricing,
  };
}

export function buildResponsesModelParameters(selection = {}) {
  const params = {};
  if (selection.reasoningEffort) {
    params.reasoning = { effort: selection.reasoningEffort };
  }
  if (selection.allowSampling) {
    Object.assign(params, selection.sampling || {});
  }
  return params;
}

export function estimateModelCostUsd(modelId = "", usage = {}) {
  const capability = getModelCapability(modelId);
  const pricing = resolvePricing(modelId, capability);
  const inputTokens = Number(usage?.input_tokens || usage?.prompt_tokens || usage?.inputTokens || 0);
  const outputTokens = Number(usage?.output_tokens || usage?.completion_tokens || usage?.outputTokens || 0);
  if (!Number.isFinite(pricing.inputCostPer1M) || !Number.isFinite(pricing.outputCostPer1M)) return null;
  return (inputTokens / 1000000 * pricing.inputCostPer1M)
    + (outputTokens / 1000000 * pricing.outputCostPer1M);
}

export function logOpenAiModelSelection(path, extra = {}) {
  if (process.env.NODE_ENV === "production") return;
  const selection = extra.selection || selectOpenAiModel({
    modelPath: path,
    model: extra.model,
    debugContext: extra.debugContext || {},
  });
  console.info("[omnimath:openai-model]", {
    path,
    role: selection.role,
    model: selection.modelId,
    modelSource: selection.modelSource,
    reasoningEffort: selection.reasoningEffort,
    requestedReasoningEffort: selection.requestedReasoningEffort || null,
    reasoningOmittedReason: selection.reasoningOmittedReason || null,
    sampling: selection.sampling,
    samplingOmitted: selection.samplingOmitted,
    solveMode: selection.solveMode,
    timeoutMs: selection.timeoutMs,
    timeoutSource: selection.timeoutSource,
    freshSolve: selection.freshSolve,
    purpose: extra.purpose,
  });
}
