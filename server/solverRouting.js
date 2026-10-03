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
  if (/Euler[- ]Lagrange|variational|first variation|second variation|functional derivative|calculus of variations|\\delta\s*[A-Z]|\\frac\{\\delta/iu.test(text)) {
    return { tier: "repair", reason: "variational_calculus" };
  }
  if (/partial differential equation|\bPDE\b|heat equation|wave equation|Laplace equation|Poisson equation|\\partial|\\nabla\^2/iu.test(text)) {
    return { tier: "repair", reason: "partial_differential_equation" };
  }
  if (/\\(?:iint|iiint|oint|nabla)|Stokes|Green|curl|Jacobian|surface integral/iu.test(text)) {
    return { tier: "escalation", reason: "vector_or_multivariable_calculus" };
  }
  if (/\\begin\{(?:[pbvV]?matrix|array)\}|determinant|eigenvalue|eigenvector|characteristic polynomial|linear operator/iu.test(text)) {
    return { tier: "repair", reason: "matrix_or_linear_operator" };
  }
  if (/ordinary differential equation|\bODE\b|initial value problem|boundary value problem|(?:^|\s)[a-zA-Z]\s*['′]{1,3}\s*[+=]/u.test(text)) {
    return { tier: "repair", reason: "differential_equation" };
  }
  if (/Hilbert space|Banach space|functional analysis|bounded operator|weak convergence|Sobolev space/iu.test(text)) {
    return { tier: "repair", reason: "functional_analysis" };
  }
  if (/Karush[- ]Kuhn[- ]Tucker|\bKKT\b|Lagrange multiplier|constrained optimi[sz]ation|convex optimi[sz]ation|gradient descent/iu.test(text)) {
    return { tier: "repair", reason: "optimization" };
  }
  if (/Hamiltonian|Lagrangian|Maxwell(?:'s)? equations|Schr[oö]dinger|stress[- ]energy|tensor notation|Einstein summation/iu.test(text)) {
    return { tier: "repair", reason: "advanced_physics_math" };
  }
  if (/\\sum|\\prod|infinite series|series from|\\infty/iu.test(text) && /\\sum|series/iu.test(text)) {
    return { tier: "repair", reason: "infinite_series" };
  }
  if (/\\int[\s\S]*\\infty|improper|infinity/iu.test(text)) {
    return { tier: "standard", reason: "improper_integral_standard_first" };
  }
  // Length is useful diagnostic context, but it is not mathematical
  // difficulty evidence by itself and must not select a costly route.
  if (text.length > 1200) return { tier: "standard", reason: "long_context_standard_first" };
  if (/\\int|integral/iu.test(text)) {
    return { tier: "standard", reason: "one_dimensional_integral" };
  }
  return { tier: "standard", reason: "default_standard" };
}

export function chooseSolverRoleForProblem(input = {}) {
  const classification = classifyProblemComplexity(input);
  const role = classification.tier === "standard" ? "solver" : "repair";
  return {
    role,
    ...classification,
    reason: classification.reason,
  };
}
