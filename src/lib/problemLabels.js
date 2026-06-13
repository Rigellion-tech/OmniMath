const LATEX_COMMAND_PATTERN = /\\[a-zA-Z]+|\\[()[\]{}]|[_^{}]|\\,/;
const GENERIC_TITLE = "Math Problem";

function sourceText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);

  return [
    value.expression,
    value.problem,
    value.problemLatex,
    value.originalProblem,
    value.title,
    value.text,
  ].filter(Boolean).join(" ");
}

export function hasLatexSyntax(value) {
  return LATEX_COMMAND_PATTERN.test(String(value || ""));
}

export function classifyProblem(value, fallback = GENERIC_TITLE) {
  const text = sourceText(value);
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return fallback;
  if (/triple\s+integral|\\iiint/.test(normalized)) return "Triple Integral";
  if (/\\int[^]*\\infty|infinite\s+(limit|bound)|improper/.test(normalized)) return "Improper Integral";
  if (/\\int|integral/.test(normalized)) return "Integral Evaluation";
  if (/differentiat|derivative|\\frac\{d|d\/dx|prime/.test(normalized)) return "Differentiation";
  if (/\\lim|limit/.test(normalized)) return "Limit Problem";
  if (/\\sum|series|summation/.test(normalized)) return "Series Problem";
  if (/matrix|determinant|\\begin\{[bpv]?matrix/.test(normalized)) return "Matrix Problem";
  if (/solve|equation|=/.test(normalized)) return "Equation Problem";

  return fallback;
}

export function cleanLatexSnippet(value, fallback = GENERIC_TITLE, maxLength = 56) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;

  let clean = raw
    .replace(/\\\(|\\\)|\$\$/g, " ")
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2")
    .replace(/\\(ln|sin|cos|tan|arctan|sqrt|int|sum|lim)\b/g, "$1")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/[{}_^]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean || hasLatexSyntax(raw)) {
    clean = classifyProblem(raw, fallback);
  }

  return clean.length > maxLength ? `${clean.slice(0, Math.max(0, maxLength - 3)).trim()}...` : clean;
}

export function getProblemLabel(problem, fallback = GENERIC_TITLE) {
  const text = sourceText(problem);
  const title = typeof problem?.title === "string" ? problem.title.trim() : "";
  const problemBody = typeof problem === "object" && problem
    ? problem.expression || problem.problem || problem.problemLatex || problem.originalProblem || ""
    : "";
  const hasProblemBody = Boolean(
    typeof problem === "object"
      && problem
      && (problem.expression || problem.problem || problem.problemLatex || problem.originalProblem)
  );

  if (hasProblemBody) return classifyProblem(problemBody, fallback);

  if (/^demo\b|^demo problem:/i.test(title)) return fallback;
  if (title && title !== "New session" && !hasLatexSyntax(title) && title.length <= 48) return title;

  return classifyProblem(text || title, fallback);
}

export function getSessionLabel(session, fallback = GENERIC_TITLE) {
  const title = typeof session?.title === "string" ? session.title.trim() : "";
  const problem = session?.problem || session?.problems?.[0] || null;

  if (problem) return getProblemLabel(problem, fallback);

  if (/^demo\b|^demo problem:/i.test(title)) return fallback;
  if (title && title !== "New math session" && !hasLatexSyntax(title) && title.length <= 48) {
    return title;
  }

  return getProblemLabel(title, fallback);
}

export function getStatusStepText(steps = []) {
  const count = Array.isArray(steps) ? steps.length : Number(steps) || 0;
  return count > 0 ? `${count} ${count === 1 ? "step" : "steps"} generated` : "Explanation generated";
}
