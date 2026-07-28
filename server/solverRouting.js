export function classifyProblemComplexity({ problem = "", canonicalLatex = "", ocrConfidence = null, priorIssues = [] } = {}) {
  const text = `${problem || ""}\n${canonicalLatex || ""}`;
  const issues = Array.isArray(priorIssues) ? priorIssues : [];
  if (issues.some((issue) => /numerical_final_answer_mismatch|unsupported_|abrupt_special_function|invalid_antiderivative/u.test(String(issue)))) {
    return { tier: "escalation", reason: "prior_mathematical_validation_failure" };
  }
  if (issues.some((issue) => /^unexplained_generated_symbol/u.test(String(issue)))) {
    return { tier: "repair", reason: "prior_symbol_validation_failure" };
  }
  if (Number.isFinite(Number(ocrConfidence)) && Number(ocrConfidence) > 0 && Number(ocrConfidence) < 80) {
    return { tier: "repair", reason: "low_ocr_confidence" };
  }
  if (/\\(?:iint|iiint|oint|nabla)|Stokes|Green|curl|Jacobian|surface integral/iu.test(text)) {
    return { tier: "escalation", reason: "vector_or_multivariable_calculus" };
  }
  if (/\\sum|\\prod|infinite series|series from|\\infty/iu.test(text) && /\\sum|series/iu.test(text)) {
    return { tier: "repair", reason: "infinite_series" };
  }
  if (/\\int[\s\S]*\\infty|improper|infinity/iu.test(text)) {
    return { tier: "repair", reason: "improper_integral" };
  }
  if (text.length > 1200) {
    return { tier: "repair", reason: "long_context" };
  }
  if (/\\int|integral/iu.test(text)) {
    return { tier: "standard", reason: "one_dimensional_integral" };
  }
  return { tier: "standard", reason: "default_standard" };
}

export function chooseSolverRoleForProblem(input = {}) {
  const classification = classifyProblemComplexity(input);
  if (classification.tier === "escalation") return { role: "escalation", ...classification };
  if (classification.tier === "repair") return { role: "repair", ...classification };
  return { role: "solver", ...classification };
}
