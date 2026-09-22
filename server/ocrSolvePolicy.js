const STRUCTURAL_REVIEW_ISSUES = new Set([
  "text_latex_mismatch",
  "ocr_text_cleanup_review",
  "exponent_loss",
  "subscript_loss",
  "parentheses_loss",
  "function_argument_changed",
  "vector_component_count_mismatch",
  "integral_bounds_unclear",
  "theorem_sensitive_structure_unclear",
  "command_stripping",
  "malformed_command",
]);

function issueType(issue) {
  return typeof issue === "string" ? issue : String(issue?.type || "");
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Decide whether an OCR solve may proceed without a human review action.
 * Consume the canonical review findings. Confidence and raw similarity/cleanup
 * metrics are diagnostic evidence, not a second independently tuned review
 * algorithm. A confirmation is authoritative only when its action receipt is
 * bound to the canonical input being submitted.
 */
export function assessOcrSolveDecision({
  solveDecision = "direct",
  extractionValidation = {},
  reviewAction = null,
  canonicalInputHash = "",
} = {}) {
  const validation = extractionValidation && typeof extractionValidation === "object"
    ? extractionValidation
    : {};
  const issues = Array.isArray(validation.issues) ? validation.issues : [];
  const issueTypes = issues.map(issueType).filter(Boolean);
  const metrics = validation.metrics && typeof validation.metrics === "object" ? validation.metrics : {};
  const tier = String(validation.tier || validation.confidenceTier || "").toLowerCase();
  const confidence = numeric(validation.confidence ?? validation.mathIntegrityScore);
  const structuralDisagreement = issueTypes.some((type) => STRUCTURAL_REVIEW_ISSUES.has(type));
  const hasEvidence = Boolean(
    tier
    || validation.critical === true
    || (confidence !== null && confidence > 0)
    || issues.length > 0
    || Object.keys(metrics).length > 0
  );
  const action = reviewAction && typeof reviewAction === "object" ? reviewAction : null;
  const expectedActionKind = solveDecision === "confirmed"
    ? "confirmed_unchanged"
    : solveDecision === "edited"
      ? "edited"
      : "";
  const reviewActionValid = Boolean(
    action
    && expectedActionKind
    && action.kind === expectedActionKind
    && canonicalInputHash
    && action.canonicalInputHash === canonicalInputHash
  );
  const explicitReviewDecision = solveDecision === "confirmed" || solveDecision === "edited";
  const invalidReviewAction = explicitReviewDecision && !reviewActionValid;
  const humanReviewAcknowledged = reviewActionValid;
  const reviewRequired = invalidReviewAction || (
    !humanReviewAcknowledged && hasEvidence && (
      validation.critical === true
      || structuralDisagreement
    )
  );

  return {
    solveDecision,
    tier: tier || null,
    confidence,
    issueTypes,
    metrics,
    hasEvidence,
    structuralDisagreement,
    humanReviewAcknowledged,
    reviewActionValid,
    invalidReviewAction,
    reviewActionKind: action?.kind || null,
    reviewActionCanonicalInputHash: action?.canonicalInputHash || null,
    canonicalInputHash: canonicalInputHash || null,
    reviewRequired,
    allowed: !reviewRequired,
    reason: invalidReviewAction
      ? "ocr-review-action-input-mismatch"
      : reviewRequired
        ? "ocr-structural-review-required"
      : humanReviewAcknowledged
        ? "explicit-user-review-decision"
        : "ocr-no-structural-review-finding",
  };
}

export function assertOcrSolveAllowed(options = {}) {
  const decision = assessOcrSolveDecision(options);
  if (decision.reviewRequired) {
    throw Object.assign(new Error("This extraction must be reviewed before solving."), {
      statusCode: 409,
      code: "OCR_REVIEW_REQUIRED",
      publicMessage: "Review or edit the extracted problem before solving it.",
      ocrSolveDecision: decision,
    });
  }
  return decision;
}

export { STRUCTURAL_REVIEW_ISSUES };
