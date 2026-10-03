// Mathematical evidence is candidate-scoped. These statuses describe the
// supported checks that ran, never proof of the whole solution.
import { ORDINARY_MAX_ROUTE_ATTEMPTS } from "./ordinaryRecoveryPolicy.js";
const DETERMINISTIC_METHODS = new Set([
  "exact_rational_evaluation", "parsed_expression_identity",
  "exact_rational_normal_form", "exact_rational_counterexample",
  "exact_polynomial_integration", "solution_substitution", "exact_domain_check",
]);

const NUMERICAL_METHODS = new Set([
  "numerical_counterexample", "numerical_substitution", "constant_evaluation",
  "numerical_quadrature", "adaptive_simpson_two_partitions",
]);

export function classifyVerificationCheck(check) {
  // Some checks have a deterministic outer calculation but compare its result
  // to the candidate with a weaker method. The comparison is the evidence that
  // decides agreement or contradiction.
  const evidenceMethod = check.comparisonMethod || check.method;
  const supported = DETERMINISTIC_METHODS.has(evidenceMethod)
    && ["verified", "contradicted"].includes(check.state);
  const numerical = NUMERICAL_METHODS.has(evidenceMethod)
    || check.state === "numerically_supported";
  const scope = check.linkedInput || check.definitionField === "input"
    ? "input_linked" : check.definitionField ? "candidate_internal" : "standalone";
  return {
    checkId: check.id,
    fieldPath: check.fieldPath,
    classification: supported ? "deterministic_supported_check"
      : numerical ? "heuristic_warning" : "unsupported",
    applicability: supported || numerical ? "applicable" : "unsupported",
    scope,
    outcome: supported ? (check.state === "contradicted" ? "contradiction" : "passed")
      : numerical ? "warning" : "inconclusive",
    category: supported && check.state === "contradicted" ? check.reason : null,
  };
}

export function assessMathematicalAssurance(verification, { candidateId = null, routeAttemptId = null } = {}) {
  const verificationAttemptId = candidateId ? `${candidateId}:verification:1` : null;
  const checks = (verification?.checks || []).map((check) => ({
    ...classifyVerificationCheck(check), candidateId, verificationAttemptId,
  }));
  const contradictions = checks.filter((check) => check.outcome === "contradiction");
  const inputLinkedFinalPass = checks.some((check) => check.outcome === "passed"
    && check.scope === "input_linked" && check.fieldPath?.startsWith("finalAnswer"));
  const status = contradictions.length ? "contradiction_detected"
    : inputLinkedFinalPass ? "supported_checks_passed"
      : checks.length ? "inconclusive" : "not_checked";
  return {
    version: "bounded-assurance-v1", status, candidateId, routeAttemptId, verificationAttemptId,
    summary: {
      supportedPassed: checks.filter((check) => check.outcome === "passed").length,
      contradictions: contradictions.length,
      inconclusive: checks.filter((check) => check.outcome === "inconclusive").length,
      heuristicWarnings: checks.filter((check) => check.outcome === "warning").length,
      inputLinkedFinalPass,
      solutionCorrectness: "not_established",
    },
    findings: checks.filter((check) => check.outcome === "contradiction").slice(0, 8),
    checks: checks.slice(0, 33),
    coverage: {
      examinedFields: verification?.coverage?.examinedFields ?? 0,
      totalFields: verification?.coverage?.totalFields ?? 0,
      proseChecked: false, crossStepImplicationsChecked: false,
      solutionCompletenessChecked: false,
      assumptionsFullyChecked: false,
    },
    recoveryAttempted: false,
    history: [],
  };
}

export function decideAssuranceRecovery({ assurance, routeAttemptCount = 1,
  deadlineRemaining = false, escalationAvailable = false } = {}) {
  if (assurance?.status !== "contradiction_detected") return { action: "present", reason: "no_supported_contradiction" };
  if (routeAttemptCount >= ORDINARY_MAX_ROUTE_ATTEMPTS) return { action: "present_unresolved", reason: "shared_route_budget_exhausted" };
  if (!deadlineRemaining) return { action: "present_unresolved", reason: "total_solve_deadline" };
  if (!escalationAvailable) return { action: "present_unresolved", reason: "duplicate_execution_configuration" };
  return { action: "escalate", reason: "supported_mathematical_contradiction" };
}

const RANK = { supported_checks_passed: 3, inconclusive: 2, not_checked: 2, contradiction_detected: 1 };
export function selectAssuranceCandidate(candidates) {
  return candidates.reduce((best, item) => (best === null
    || RANK[item.assurance.status] > RANK[best.assurance.status] ? item : best), null);
}

export function finalizeAssuranceSelection(selected, candidates, recoveryAttempted = false,
  recovery = null) {
  const history = candidates.map((item) => ({
    candidateId: item.assurance.candidateId,
    routeAttemptId: item.assurance.routeAttemptId,
    status: item.assurance.status,
    contradictionCategories: item.assurance.findings.map((finding) => finding.category).slice(0, 8),
  }));
  selected.assurance.history = history;
  selected.assurance.recoveryAttempted = recoveryAttempted;
  selected.assurance.recovery = recovery || {
    attempted: recoveryAttempted,
    outcome: recoveryAttempted ? (selected.assurance.status === "contradiction_detected"
      ? "unresolved" : "replacement_selected") : "not_attempted",
    reason: null,
  };
  selected.assurance.unresolvedContradiction = selected.assurance.status === "contradiction_detected";
  if (selected.result.candidateAcceptance) {
    selected.result.candidateAcceptance.presentationAction = selected.assurance.unresolvedContradiction
      ? "present_unresolved" : "present";
  }
  return selected;
}
