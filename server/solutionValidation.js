function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function flattenSolutionText(result = {}) {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  return [
    result.title,
    result.summary,
    result.expression,
    result.finalAnswer,
    result.finalAnswerLatex,
    ...steps.flatMap((step) => [
      step.label,
      step.title,
      step.heading,
      step.math,
      step.summary,
      step.reasoning,
      step.plainExplanation,
    ]),
  ].map(safeString).filter(Boolean).join(" ");
}

function createInvalidSolutionError(message, issues = []) {
  return Object.assign(new Error(message), {
    statusCode: 502,
    code: "AI_RESPONSE_INVALID",
    publicMessage: "The AI service returned an invalid solution. Please review the extracted problem and try again.",
    solutionIssues: issues,
  });
}

export function looksLikeStokesCurlProblem(problem = "") {
  const text = safeString(problem);
  return /(?:stokes|curl|\\nabla\s*\\times|∇\s*×|\\iint|∬)/iu.test(text)
    && /(?:paraboloid|boundary curve|oriented upward|\\mathbf\s*\{?F\}?|F\s*\()/iu.test(text);
}

export function validateSolutionQuality(result, { problem = "" } = {}) {
  const issues = [];
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const finalAnswer = safeString(result?.finalAnswerLatex || result?.finalAnswer);
  const solutionText = flattenSolutionText(result);
  const compact = solutionText.replace(/\s+/g, " ").trim();

  if (!finalAnswer || finalAnswer.length < 3) {
    issues.push("missing_final_answer");
  }

  if (steps.length <= 1) {
    issues.push("too_few_steps");
  }

  if (/\bRecognized rule\b/i.test(compact)) {
    issues.push("generic_recognized_rule");
  }

  if (/\bf\s*g\s*x\b/i.test(compact) || /\bf'g\s*\+\s*fg'\b/i.test(compact)) {
    issues.push("generic_symbolic_junk");
  }

  const uniqueMath = new Set(steps.map((step) => safeString(step.math || step.latex)).filter(Boolean));
  if (uniqueMath.size <= 1 && steps.length > 1) {
    issues.push("no_meaningful_transformation");
  }

  if (looksLikeStokesCurlProblem(problem)) {
    if (!/(?:Stokes|\\oint|∮)/iu.test(compact)) issues.push("missing_stokes_theorem");
    if (!/(?:Green|\\iint_D|x\^2\s*\+\s*y\^2\s*\\le\s*9|x\^2\+y\^2\\le9)/iu.test(compact)) {
      issues.push("missing_green_disk_reduction");
    }
    if (/power rule|product rule|chain rule|quotient rule/i.test(compact)) {
      issues.push("wrong_simple_rule_for_curl_problem");
    }
  }

  if (issues.length > 0) {
    throw createInvalidSolutionError("Solution failed quality validation.", issues);
  }

  return true;
}
