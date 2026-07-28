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
  solver: "gpt-4.1",
  repair: "gpt-4.1-mini",
  escalation: "gpt-4.1",
  premiumEscalation: "o3",
  hover: "gpt-4.1-mini",
  pinned: "gpt-4.1-mini",
};

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

const ROLE_DEFAULT_REASONING_EFFORT = {
  solver: "medium",
  repair: "high",
  escalation: "high",
  premiumEscalation: "high",
};

const ROLE_MODEL_ENV = {
  imageExtraction: ["OMNIMATH_IMAGE_EXTRACTION_MODEL", "OPENAI_IMAGE_EXTRACTION_MODEL"],
  extractionReview: ["OMNIMATH_EXTRACTION_REVIEW_MODEL", "OPENAI_EXTRACTION_REVIEW_MODEL"],
  solver: ["OMNIMATH_SOLVER_MODEL", "OPENAI_SOLVER_MODEL", "OPENAI_MODEL"],
  repair: ["OMNIMATH_REPAIR_MODEL", "OPENAI_REPAIR_MODEL", "OMNIMATH_SOLVER_MODEL", "OPENAI_SOLVER_MODEL", "OPENAI_MODEL"],
  escalation: ["OMNIMATH_ESCALATION_MODEL", "OPENAI_ESCALATION_MODEL"],
  premiumEscalation: ["OMNIMATH_PREMIUM_ESCALATION_MODEL", "OPENAI_PREMIUM_ESCALATION_MODEL", "OMNIMATH_ESCALATION_MODEL", "OPENAI_ESCALATION_MODEL"],
  hover: ["OMNIMATH_HOVER_MODEL", "OPENAI_HOVER_MODEL", "OPENAI_LAZY_MODEL"],
  pinned: ["OMNIMATH_PINNED_MODEL", "OPENAI_PINNED_MODEL", "OPENAI_LAZY_MODEL"],
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
  if (path === "premiumEscalation") return "premiumEscalation";
  if (path === "escalation") return "escalation";
  const attemptType = String(debugContext.attemptType || debugContext.retryPurpose || "").toLowerCase();
  if (attemptType.includes("repair")) return "repair";
  if (attemptType.includes("escalation")) return "escalation";
  return "solver";
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

function resolveReasoningEffort(role = "solver", capability = {}) {
  const requested = firstEnv(ROLE_EFFORT_ENV[role] || []);
  const defaultEffort = ROLE_DEFAULT_REASONING_EFFORT[role] || "medium";
  const candidate = requested.value || defaultEffort;
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
  const legacyModel = process.env.OPENAI_MODEL;
  const legacyLazyModel = process.env.OPENAI_LAZY_MODEL;

  return {
    imageExtraction: process.env.OMNIMATH_IMAGE_EXTRACTION_MODEL || process.env.OPENAI_IMAGE_EXTRACTION_MODEL || legacyModel || DEFAULT_OPENAI_MODELS.imageExtraction,
    extractionReview: process.env.OMNIMATH_EXTRACTION_REVIEW_MODEL || process.env.OPENAI_EXTRACTION_REVIEW_MODEL || DEFAULT_OPENAI_MODELS.extractionReview,
    solver: process.env.OMNIMATH_SOLVER_MODEL || process.env.OPENAI_SOLVER_MODEL || legacyModel || DEFAULT_OPENAI_MODELS.solver,
    repair: process.env.OMNIMATH_REPAIR_MODEL || process.env.OPENAI_REPAIR_MODEL || process.env.OMNIMATH_SOLVER_MODEL || process.env.OPENAI_SOLVER_MODEL || legacyModel || DEFAULT_OPENAI_MODELS.repair,
    escalation: process.env.OMNIMATH_ESCALATION_MODEL || process.env.OPENAI_ESCALATION_MODEL || DEFAULT_OPENAI_MODELS.escalation,
    premiumEscalation: process.env.OMNIMATH_PREMIUM_ESCALATION_MODEL || process.env.OPENAI_PREMIUM_ESCALATION_MODEL || process.env.OMNIMATH_ESCALATION_MODEL || process.env.OPENAI_ESCALATION_MODEL || DEFAULT_OPENAI_MODELS.premiumEscalation,
    hover: process.env.OMNIMATH_HOVER_MODEL || process.env.OPENAI_HOVER_MODEL || legacyLazyModel || DEFAULT_OPENAI_MODELS.hover,
    pinned: process.env.OMNIMATH_PINNED_MODEL || process.env.OPENAI_PINNED_MODEL || legacyLazyModel || DEFAULT_OPENAI_MODELS.pinned,
  };
}

export function getOpenAiModelForPath(path, debugContext = {}) {
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
  const modelSelection = model
    ? { value: model, source: "explicit_override" }
    : firstEnv(ROLE_MODEL_ENV[role] || []);
  const modelId = modelSelection.value || DEFAULT_OPENAI_MODELS[role] || DEFAULT_OPENAI_MODELS.solver;
  const capability = getModelCapability(modelId);
  const reasoning = resolveReasoningEffort(role, capability);
  const pricing = resolvePricing(modelId, capability);
  const sampling = DEFAULT_OPENAI_SAMPLING[role] ? { ...DEFAULT_OPENAI_SAMPLING[role] } : {};
  const samplingOmitted = !capability.allowSampling && Object.keys(sampling).length > 0;
  return {
    role,
    modelPath,
    modelId,
    modelSource: modelSelection.source || "default",
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
    freshSolve: selection.freshSolve,
    purpose: extra.purpose,
  });
}
