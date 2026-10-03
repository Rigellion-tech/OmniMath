import { isMeaningfullyDifferentEscalationConfig } from "./modelExecutionConfig.js";

const STRUCTURED_OUTPUT_FAILURES = new Set([
  "json_parse",
  "schema_contract",
  "latex_syntax",
  "field_structure",
  "generated_validation",
  "truncated",
  "empty_response",
  "missing_text",
]);

const INFRASTRUCTURE_CODES = new Set([
  "AI_SERVICE_UNAVAILABLE",
  "AI_PROVIDER_RATE_LIMITED",
  "AI_SERVICE_ERROR",
  "SERVER_CONFIG_ERROR",
]);

export const ORDINARY_MAX_ROUTE_ATTEMPTS = 2;

export function classifyOrdinarySolveFailure(error = null) {
  const code = String(error?.code || "");
  const responseFailureType = String(error?.responseFailureType || "");
  if (code === "AI_REQUEST_REFUSED" || responseFailureType === "refusal") return "refusal";
  if (responseFailureType === "interactive_deadline_exceeded" || error?.timeoutScope === "total_solve") {
    return "total_solve_deadline";
  }
  if (responseFailureType === "request_timeout") return "request_timeout";
  if (STRUCTURED_OUTPUT_FAILURES.has(responseFailureType)
      || code === "AI_RESPONSE_INVALID"
      || code === "AI_RESPONSE_TRUNCATED") {
    return "structured_output_failure";
  }
  if (INFRASTRUCTURE_CODES.has(code)) return "transport_or_provider_failure";
  return "unknown_failure";
}

export function decideOrdinaryRecovery({
  error = null,
  routeAttemptCount = 1,
  escalationAttempted = false,
  deadlineRemaining = false,
  initialConfig = null,
  escalationConfig = null,
} = {}) {
  const classification = classifyOrdinarySolveFailure(error);
  if (routeAttemptCount >= ORDINARY_MAX_ROUTE_ATTEMPTS || escalationAttempted) {
    return { action: "fail", reason: "recovery_attempt_limit", classification };
  }
  if (!deadlineRemaining) {
    return { action: "fail", reason: "total_solve_deadline", classification };
  }
  if (classification !== "structured_output_failure") {
    return { action: "fail", reason: classification, classification };
  }
  if (!initialConfig || !escalationConfig
      || !isMeaningfullyDifferentEscalationConfig(initialConfig, escalationConfig)) {
    return { action: "fail", reason: "duplicate_execution_configuration", classification };
  }
  return {
    action: "escalate",
    reason: "structured_output_recovery",
    classification,
  };
}
