import { selectOpenAiModel } from "./openaiModels.js";

const EXACT_IDENTITY_FIELDS = Object.freeze([
  "requestedModel",
  "effectiveModel",
  "role",
  "reasoningEffort",
  "timeoutMs",
  "responseMode",
  "structuredOutputPolicy",
  "modelPath",
  "recoveryPurpose",
  "promptStrategy",
  "maxOutputTokens",
]);

const MATERIAL_IDENTITY_FIELDS = Object.freeze([
  "effectiveModel",
  "reasoningEffort",
  "timeoutMs",
  "responseMode",
  "structuredOutputPolicy",
  "promptStrategy",
  "maxOutputTokens",
]);

// Escalation eligibility ignores descriptive labels. A different role or
// recovery name is not useful by itself unless it changes a provider-facing
// parameter or the prompt strategy.
const ESCALATION_IDENTITY_FIELDS = Object.freeze([
  "effectiveModel",
  "reasoningEffort",
  "timeoutMs",
  "responseMode",
  "structuredOutputPolicy",
  "promptStrategy",
  "maxOutputTokens",
]);

function normalizeIdentityValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeIdentityValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeIdentityValue(value[key])]),
    );
  }
  if (value === undefined) return null;
  return value;
}

function identityRecord(config = {}, fields = EXACT_IDENTITY_FIELDS) {
  return Object.fromEntries(
    fields.map((field) => [field, normalizeIdentityValue(config[field])]),
  );
}

function stableIdentity(config = {}, fields = EXACT_IDENTITY_FIELDS) {
  return JSON.stringify(identityRecord(config, fields));
}

export function getModelExecutionConfigIdentity(config = {}) {
  return stableIdentity(config, EXACT_IDENTITY_FIELDS);
}

export function getMaterialModelExecutionConfigIdentity(config = {}) {
  return stableIdentity(config, MATERIAL_IDENTITY_FIELDS);
}

export function areModelExecutionConfigsExactlyEqual(left = {}, right = {}) {
  return getModelExecutionConfigIdentity(left) === getModelExecutionConfigIdentity(right);
}

export function areModelExecutionConfigsMateriallyEqual(left = {}, right = {}) {
  return getMaterialModelExecutionConfigIdentity(left)
    === getMaterialModelExecutionConfigIdentity(right);
}

export function isMateriallyDifferentModelExecutionConfig(left = {}, right = {}) {
  return !areModelExecutionConfigsMateriallyEqual(left, right);
}

export function isMeaningfullyDifferentEscalationConfig(initial = {}, escalation = {}) {
  return stableIdentity(initial, ESCALATION_IDENTITY_FIELDS)
    !== stableIdentity(escalation, ESCALATION_IDENTITY_FIELDS);
}

export function buildModelExecutionConfig({
  modelPath = "solver",
  model = "",
  debugContext = {},
  responseMode = "unspecified",
  structuredOutputPolicy = "unspecified",
  recoveryPurpose = "",
  maxOutputTokens,
  promptStrategy = "default",
} = {}) {
  const resolvedRecoveryPurpose = recoveryPurpose
    || debugContext.retryPurpose
    || debugContext.attemptType
    || "initial";
  const selection = selectOpenAiModel({
    modelPath,
    model,
    debugContext: {
      ...debugContext,
      retryPurpose: debugContext.retryPurpose || resolvedRecoveryPurpose,
    },
  });
  const config = {
    requestedModel: selection.modelId,
    effectiveModel: selection.modelId,
    role: selection.role,
    reasoningEffort: selection.reasoningEffort,
    timeoutMs: selection.timeoutMs,
    responseMode,
    structuredOutputPolicy: normalizeIdentityValue(structuredOutputPolicy),
    modelPath: selection.modelPath,
    recoveryPurpose: resolvedRecoveryPurpose,
    promptStrategy,
    maxOutputTokens: Number.isFinite(maxOutputTokens)
      ? maxOutputTokens
      : selection.maxOutputTokens,
  };

  return Object.freeze({
    ...config,
    identity: getModelExecutionConfigIdentity(config),
    materialIdentity: getMaterialModelExecutionConfigIdentity(config),
  });
}
