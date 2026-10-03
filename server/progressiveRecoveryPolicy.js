// Provider attempts are internal to one user-visible progressive solve.
// Decisions are made only while no authoritative step has been published.
const TRANSIENT_PROVIDER_CODES = new Set([
  "server_error", "internal_error", "temporarily_unavailable", "service_unavailable",
]);
const CAPABILITY_PROVIDER_CODES = new Set(["model_not_capable", "model_cannot_solve", "unsupported_reasoning"]);
const AUTH_PROVIDER_CODES = new Set(["invalid_api_key", "authentication_error", "invalid_authentication", "permission_denied"]);
const USAGE_PROVIDER_CODES = new Set(["insufficient_quota", "rate_limit_exceeded", "usage_limit_exceeded", "billing_hard_limit_reached"]);

export function classifyProgressiveFailure(error, { cancelled = false, disconnected = false } = {}) {
  const code = String(error?.code || "").toLowerCase();
  const providerCode = String(error?.providerCode || "").toLowerCase();
  const failureType = String(error?.responseFailureType || "").toLowerCase();
  const status = Number(error?.providerStatus || 0);
  if (cancelled || disconnected || error?.name === "AbortError") return "user_cancellation";
  if (code === "server_config_error" || AUTH_PROVIDER_CODES.has(providerCode) || status === 401 || status === 403) return "authentication_configuration_error";
  if (code === "ai_provider_rate_limited" || status === 429 || USAGE_PROVIDER_CODES.has(providerCode)) return "usage_rate_limit_error";
  if (providerCode === "refusal" || failureType === "response.refusal") return "refusal";
  if (CAPABILITY_PROVIDER_CODES.has(providerCode)) return "model_capability_failure";
  if (status >= 400 && status < 500) return "bad_request";
  if (failureType === "interactive_deadline_exceeded" || error?.timeoutScope === "total_solve") return "total_solve_deadline";
  if (failureType === "request_timeout" || failureType === "interactive_deadline_exceeded") return "request_timeout";
  if (failureType === "truncated" || failureType === "response.incomplete") return "truncated_output";
  if (failureType === "empty_response") return "empty_response";
  if (code === "progressive_step_rejected") return "strict_step_validation_failure";
  if (code === "progressive_frame_invalid") return "parser_framing_failure";
  if (code === "ai_response_invalid") return "malformed_structured_output";
  if (["missing_response_body", "invalid_text_delta", "missing_terminal_completion"].includes(failureType)) return "unsupported_stream_behavior";
  if (["response.failed", "error"].includes(failureType) && TRANSIENT_PROVIDER_CODES.has(providerCode)) {
    return "transient_provider_network_error";
  }
  if (status >= 500 || code === "ai_service_unavailable" || error?.networkCauseCode) return "transient_provider_network_error";
  if (failureType === "response.failed" || code === "ai_service_error") return "provider_failure";
  return "unknown_failure";
}

export function decideProgressiveRecovery({
  classification, authoritativePrefixPublished, retryAttempted,
  repairAttempted, escalationAttempted, repairCandidateAvailable,
  escalationModelAvailable, deadlineRemaining, providerAttemptCount,
} = {}) {
  if (authoritativePrefixPublished) return { action: "fail", reason: "authoritative_prefix_published" };
  if (!deadlineRemaining || ["user_cancellation", "total_solve_deadline", "refusal"].includes(classification)) return { action: "fail", reason: classification };
  if (escalationAttempted || providerAttemptCount >= 4) return { action: "fail", reason: "recovery_attempt_limit" };
  if (["authentication_configuration_error", "usage_rate_limit_error", "bad_request"].includes(classification)) {
    return { action: "fail", reason: classification };
  }
  if (classification === "model_capability_failure") {
    return escalationModelAvailable && !escalationAttempted
      ? { action: "escalate", reason: classification }
      : { action: "fail", reason: "escalation_configuration_unavailable_or_duplicate" };
  }
  if (["parser_framing_failure", "strict_step_validation_failure", "malformed_structured_output"].includes(classification)
      && repairCandidateAvailable && !repairAttempted) {
    return { action: "repair", reason: classification };
  }
  // An exact same-route retry is reserved for transport/timing failures. A
  // generation/structure failure must change prompt or execution strategy.
  if (["transient_provider_network_error", "request_timeout"].includes(classification)
      && !retryAttempted) {
    return { action: "retry", reason: classification };
  }
  if (["parser_framing_failure", "strict_step_validation_failure", "malformed_structured_output",
    "truncated_output", "unsupported_stream_behavior", "empty_response"].includes(classification)
      && escalationModelAvailable && !escalationAttempted) {
    return {
      action: "escalate",
      reason: repairAttempted || retryAttempted ? `repeated_${classification}` : classification,
    };
  }
  if (["parser_framing_failure", "strict_step_validation_failure", "malformed_structured_output",
    "truncated_output", "unsupported_stream_behavior", "empty_response"].includes(classification)
      && !escalationModelAvailable) {
    return { action: "fail", reason: "escalation_configuration_unavailable_or_duplicate" };
  }
  return { action: "fail", reason: classification };
}
