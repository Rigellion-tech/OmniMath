const LATEX_COMMAND_NAMES = [
  "alpha", "approx", "arctan", "begin", "beta", "boxed", "cdot", "cos", "cot", "csc",
  "delta", "dfrac", "displaystyle", "end", "exp", "frac", "gamma", "ge", "geq", "iiint",
  "iint", "infty", "int", "lambda", "le", "left", "leq", "lim", "ln", "log", "mathrm",
  "mu", "nabla", "oint", "omega", "operatorname", "phi", "pi", "prod", "qquad", "quad",
  "rho", "right", "sec", "sigma", "sin", "sqrt", "sum", "tan", "text", "tfrac", "theta",
  "times", "to", "zeta",
];

const COMMAND_ALTERNATION = LATEX_COMMAND_NAMES
  .sort((left, right) => right.length - left.length)
  .join("|");
const ACTUAL_ENQUIRY_COMMAND = new RegExp(`\u0005(${COMMAND_ALTERNATION})(?![A-Za-z])`, "gu");
const RECOGNIZED_COMMAND_REMNANT = new RegExp(`(?<![A-Za-z])(${COMMAND_ALTERNATION})(?![A-Za-z])`, "gu");
const LITERAL_ENQUIRY_ESCAPE = /\\u0005/giu;
const ACTUAL_ENQUIRY = /\u0005/gu;

function countMatches(value, pattern) {
  return [...String(value || "").matchAll(pattern)].length;
}

function codePointLabel(value, index) {
  if (index <= 0) return "START";
  const codePoint = value.codePointAt(index - 1);
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function stringValues(value, seen = new WeakSet()) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => stringValues(item, seen));
  return Object.values(value).flatMap((item) => stringValues(item, seen));
}

export function inspectLatexControlCharacterStage(value, stage) {
  const predecessorCounts = new Map();
  let literalUnicodeEscapeCount = 0;
  let actualControlCharacterCount = 0;
  let recognizedCommandRemnantCount = 0;

  for (const text of stringValues(value)) {
    literalUnicodeEscapeCount += countMatches(text, LITERAL_ENQUIRY_ESCAPE);
    actualControlCharacterCount += countMatches(text, ACTUAL_ENQUIRY);
    for (const match of text.matchAll(RECOGNIZED_COMMAND_REMNANT)) {
      recognizedCommandRemnantCount += 1;
      const label = codePointLabel(text, match.index);
      predecessorCounts.set(label, (predecessorCounts.get(label) || 0) + 1);
    }
  }

  return {
    stage: String(stage || "unknown"),
    literalUnicodeEscapePresent: literalUnicodeEscapeCount > 0,
    literalUnicodeEscapeCount,
    actualControlCharacterPresent: actualControlCharacterCount > 0,
    actualControlCharacterCount,
    recognizedCommandRemnantCount,
    commandPredecessorCodePoints: [...predecessorCounts]
      .map(([codePoint, count]) => ({ codePoint, count }))
      .sort((left, right) => left.codePoint.localeCompare(right.codePoint)),
  };
}

function recoverLatexField(value) {
  if (typeof value !== "string") return value;
  return value.replace(ACTUAL_ENQUIRY_COMMAND, "\\$1");
}

function recoverStep(step) {
  if (!step || typeof step !== "object") return step;
  return {
    ...step,
    latex: recoverLatexField(step.latex),
    equationLatex: recoverLatexField(step.equationLatex),
    anchors: Array.isArray(step.anchors)
      ? step.anchors.map((anchor) => (
          anchor && typeof anchor === "object"
            ? { ...anchor, latex: recoverLatexField(anchor.latex) }
            : anchor
        ))
      : step.anchors,
    tokens: Array.isArray(step.tokens)
      ? step.tokens.map((token) => (
          token && typeof token === "object"
            ? { ...token, latex: recoverLatexField(token.latex) }
            : token
        ))
      : step.tokens,
  };
}

export function recoverDeclaredLatexControlCharacters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...value,
    problemLatex: recoverLatexField(value.problemLatex),
    extractedProblemLatex: recoverLatexField(value.extractedProblemLatex),
    finalAnswerLatex: recoverLatexField(value.finalAnswerLatex),
    steps: Array.isArray(value.steps) ? value.steps.map(recoverStep) : value.steps,
  };
}
