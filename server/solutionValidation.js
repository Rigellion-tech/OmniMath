import { collectGeneratedLatexValidationIssues } from "./generatedLatexValidation.js";
import {
  analyzeFinalAnswerConsistency,
  analyzeNumericExpression,
  analyzePositiveIntegralSign,
  analyzeSetValuedAnswer,
  analyzeSubstitutionConsistency,
  finalValueExpression,
  looksLikeSetValuedAnswer,
  numericalFinalAnswerCheck,
  verifyCriticalIdentities,
} from "./mathValidationAnalysis.js";
import { analyzeSymbolOrigins, extractSymbolInventory } from "./symbolInventory.js";

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

const MAX_VALIDATION_STEPS = 120;
const MAX_STEP_CHARACTERS = 4000;
const MAX_TOTAL_VALIDATION_CHARACTERS = 80000;
const MAX_VALIDATION_MS = 500;

function createResourceLimitDiagnostic({
  limitType,
  configuredLimit,
  observedValue,
  validationStage,
  startedAt = Date.now(),
} = {}) {
  return {
    applicable: true,
    issue: "validation_resource_limit_reached",
    diagnosticIssue: "validation_resource_limit_reached",
    limitType,
    configuredLimit,
    observedValue,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    validationStage,
    inconclusiveReason: `${limitType} exceeded`,
    resourceLimit: {
      limitType,
      configuredLimit,
      observedValue,
      validationStage,
    },
  };
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
  const wrongProblem = issues.includes("derivative_rule_for_plain_equation");
  return Object.assign(new Error(message), {
    statusCode: 502,
    code: "AI_SOLUTION_QUALITY_INVALID",
    compactRetryable: false,
    publicMessage: wrongProblem
      ? "The generated solution did not match the submitted problem. Please retry."
      : "The AI service returned an invalid solution. Please review the extracted problem and try again.",
    solutionIssues: issues,
  });
}

function hasUndefinedFinalPlaceholder(finalAnswer = "", solutionText = "") {
  const final = safeString(finalAnswer);
  const compactSolution = safeString(solutionText).replace(/\s+/g, " ");
  if (/defined\s+above|symmetric\s+function/i.test(final)) return true;
  if (/\\?G\s*\(\s*r\s*,\s*\\?theta\s*\)|\\?H\s*\(\s*x\s*\)/i.test(final)) {
    const escapedFinal = final.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const definitionPattern = new RegExp(`${escapedFinal}\\s*=|=\\s*${escapedFinal}`, "i");
    return !definitionPattern.test(compactSolution);
  }
  return false;
}

function normalizeFinalAnswerForPresence(value = "") {
  return safeString(value)
    .replace(/^\\\(([\s\S]*)\\\)$/u, "$1")
    .replace(/^\\\[([\s\S]*)\\\]$/u, "$1")
    .replace(/^\$\$([\s\S]*)\$\$$/u, "$1")
    .replace(/^\$([\s\S]*)\$$/u, "$1")
    .replace(/\\left|\\right/g, "")
    .replace(/\\(?:,|;|:|!| )/g, "")
    .trim();
}

function hasBalancedDelimiters(value = "") {
  const stack = [];
  const pairs = new Map([["}", "{"], [")", "("], ["]", "["]]);
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") {
      const command = value.slice(index).match(/^\\[A-Za-z]+/u);
      if (command) {
        index += command[0].length - 1;
      }
      continue;
    }
    if (char === "{" || char === "(" || char === "[") stack.push(char);
    else if (char === "}" || char === ")" || char === "]") {
      if (stack.pop() !== pairs.get(char)) return false;
    }
  }
  return stack.length === 0;
}

function isClearlyMalformedFinalAnswer(value = "") {
  const text = safeString(value);
  if (!hasBalancedDelimiters(text)) return true;
  if (/\\(?:frac|dfrac|tfrac)\s*\{[^{}]*\}\s*\{\s*\}/u.test(text)) return true;
  if (/\\?(?:ln|log|sin|cos|tan|cot|sec|arctan|atan)\s*\^\s*(?:\{\s*\}|\(\s*\))/iu.test(text)) return true;
  if (/\\?(?:ln|log|sin|cos|tan|cot|sec|arctan|atan)\s*\^\s*(?:\{[^{}]*$|\([^()]*$)/iu.test(text)) return true;
  return false;
}

function analyzeFinalAnswerPresence(finalAnswer = "") {
  const rawFinalAnswer = typeof finalAnswer === "string" ? finalAnswer : "";
  const normalizedFinalAnswer = normalizeFinalAnswerForPresence(rawFinalAnswer);
  const evaluableFinalAnswerExpression = finalValueExpression(normalizedFinalAnswer);
  function result(present, detectionReason) {
    return {
      present,
      rawFinalAnswer,
      normalizedFinalAnswer,
      evaluableFinalAnswerExpression,
      detectionReason,
    };
  }
  if (!rawFinalAnswer || !rawFinalAnswer.trim()) return result(false, "empty_or_whitespace");
  if (!normalizedFinalAnswer) return result(false, "only_delimiters_or_spacing");
  if (/^[=\-+.,;:|()[\]{}]+$/u.test(normalizedFinalAnswer)) return result(false, "bare_punctuation_or_relation");
  if (/^\\(?:frac|dfrac|tfrac)\s*(?:\{[^{}]*\})?\s*$/u.test(normalizedFinalAnswer)) return result(false, "unfinished_latex_command");
  if (/\\(?:frac|dfrac|tfrac)\s*\{[^{}]*\}\s*\{\s*\}/u.test(normalizedFinalAnswer)) return result(false, "truncated_fraction");
  if (/^\\[A-Za-z]+$/u.test(normalizedFinalAnswer) && !/^\\(?:pi|infty)$/u.test(normalizedFinalAnswer)) {
    return result(false, "unfinished_latex_command");
  }
  if (/^[A-Za-z]{2,}$/u.test(normalizedFinalAnswer) && !/^(?:sin|cos|tan|cot|sec|csc|log|ln|exp|det)$/iu.test(normalizedFinalAnswer)) {
    return result(false, "prose_or_placeholder");
  }
  if (looksLikeSetValuedAnswer(normalizedFinalAnswer)) return result(true, "set_valued_answer");
  if (isClearlyMalformedFinalAnswer(evaluableFinalAnswerExpression)) return result(false, "malformed_math_syntax");
  const numeric = analyzeNumericExpression(evaluableFinalAnswerExpression);
  if (numeric.status === "evaluable") return result(true, "evaluable_numeric_expression");
  if (/[=<>]|\\(?:frac|dfrac|tfrac)(?![A-Za-z])|\\(?:in|pm|mp|det|lim|to|partial|sqrt|pi|ln|log|sin|cos|tan|cot|sec|exp|int|sum|prod)\b|[A-Za-z]\s*(?:\(|'|\^|_)/u.test(normalizedFinalAnswer)) {
    return result(true, "mathematical_expression_or_equation");
  }
  if (/^[A-Za-z]$/u.test(normalizedFinalAnswer)) return result(true, "single_symbol_expression");
  return result(false, "no_mathematical_structure_detected");
}

function normalizeTargetSymbol(value = "") {
  const text = safeString(value)
    .replace(/^\\/, "")
    .replace(/[{}]/g, "")
    .trim();
  if (!text) return "";
  const greek = text.match(/^(alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)$/iu);
  if (greek) return `\\${greek[1].toLowerCase()}`;
  return /^[A-Za-z]$/u.test(text) ? text : "";
}

function stripTargetDecorators(value = "") {
  return safeString(value)
    .replace(/^\\left/u, "")
    .replace(/\\right$/u, "")
    .replace(/\\[,;:! ]/g, "")
    .trim();
}

function splitTopLevelTargetEquality(value = "") {
  const text = safeString(value);
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (char === "=" && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function isTargetCheckExcludedProblem(problem = "") {
  return /(?:\\int|∫|\\lim|\\det|determinant|integral|differentiat|derivative|proof|prove|show|matrix|eigenvalue|expectation|probability|evaluate\s+(?:the\s+)?(?:integral|limit|determinant))/iu.test(problem);
}

function extractExpectedAnswerTargets(problem = "") {
  const text = safeString(problem);
  if (!text || isTargetCheckExcludedProblem(text)) return [];

  const solveFor = text.match(/\bsolve\s+for\s+(\\?[A-Za-z])(?:\s*(?:,|and)\s*(\\?[A-Za-z]))?/iu);
  if (solveFor) {
    return [normalizeTargetSymbol(solveFor[1]), normalizeTargetSymbol(solveFor[2])]
      .filter(Boolean);
  }

  const explicit = text.match(/\b(?:solve|find|determine)\s+(?:for\s+)?(?:the\s+)?(?:value|values|root|roots|solution|solutions)?(?:\s+of)?\s*(\\?[A-Za-z])\b/iu);
  if (explicit) {
    const symbol = normalizeTargetSymbol(explicit[1]);
    return symbol ? [symbol] : [];
  }

  if (/\bsolve\b/iu.test(text) && /[=<>]|\\le|\\ge/u.test(text)) {
    const symbols = [...extractSymbolInventory(text)]
      .map(normalizeTargetSymbol)
      .filter((symbol) => symbol && !["e", "i", "C"].includes(symbol));
    const uniqueSymbols = [...new Set(symbols)];
    if (uniqueSymbols.length === 1) return uniqueSymbols;
  }

  return [];
}

function extractSimpleTargetList(value = "") {
  const text = stripTargetDecorators(value)
    .replace(/^\(/u, "")
    .replace(/\)$/u, "");
  const parts = text.split(",").map(normalizeTargetSymbol).filter(Boolean);
  if (parts.length > 0 && parts.join(",") === text.replace(/\s+/g, "")) return parts;
  const single = normalizeTargetSymbol(text);
  return single ? [single] : [];
}

function extractGeneratedAssignmentTargets(finalAnswer = "") {
  const normalized = normalizeFinalAnswerForPresence(finalAnswer)
    .replace(/\\\{/g, "{")
    .replace(/\\\}/g, "}");
  const membership = normalized.match(/^\s*(\\?[A-Za-z])\s*\\in\b/u);
  if (membership) return [normalizeTargetSymbol(membership[1])].filter(Boolean);
  const equalityParts = splitTopLevelTargetEquality(normalized);
  if (equalityParts.length !== 2) return [];
  const lhs = equalityParts[0];
  if (/\\(?:det|lim|int|sum|prod|frac|partial)\b|['^_]/u.test(lhs)) return [];
  return extractSimpleTargetList(lhs);
}

function collectEquivalentTargetDefinitions(result = {}, expectedTargets = []) {
  const expected = new Set(expectedTargets);
  const equivalents = new Set(expectedTargets);
  const fields = Array.isArray(result?.steps)
    ? result.steps.map((step) => safeString(step?.math || step?.latex || step?.equationLatex))
    : [];
  for (const field of fields) {
    const equalityParts = splitTopLevelTargetEquality(normalizeFinalAnswerForPresence(field));
    if (equalityParts.length !== 2) continue;
    const left = extractSimpleTargetList(equalityParts[0]);
    const right = extractSimpleTargetList(equalityParts[1]);
    if (left.length !== 1 || right.length !== 1) continue;
    if (expected.has(left[0])) equivalents.add(right[0]);
    if (expected.has(right[0])) equivalents.add(left[0]);
  }
  return equivalents;
}

function analyzeAnswerTargetConsistency(problem = "", result = {}) {
  const expectedTargets = extractExpectedAnswerTargets(problem);
  const generatedTargets = extractGeneratedAssignmentTargets(result?.finalAnswerLatex || result?.finalAnswer || "");
  const base = {
    applicable: expectedTargets.length > 0 && generatedTargets.length > 0,
    issue: null,
    expectedTargets,
    generatedTargets,
    detectionReason: expectedTargets.length > 0
      ? "unambiguous_solve_target"
      : "no_unambiguous_solve_target",
  };
  if (!base.applicable) return base;
  const allowedTargets = collectEquivalentTargetDefinitions(result, expectedTargets);
  const mismatchedTargets = generatedTargets.filter((target) => !allowedTargets.has(target));
  if (mismatchedTargets.length === 0 && generatedTargets.some((target) => allowedTargets.has(target))) {
    return { ...base, allowedTargets: [...allowedTargets].sort(), mismatchedTargets: [] };
  }
  return {
    ...base,
    issue: "answer_target_mismatch",
    allowedTargets: [...allowedTargets].sort(),
    mismatchedTargets,
    evidence: JSON.stringify({
      expectedTargets,
      generatedTargets,
      detectionReason: base.detectionReason,
    }),
  };
}

export function looksLikeStokesCurlProblem(problem = "") {
  const text = safeString(problem);
  const hasVectorField = /(?:\\mathbf\s*\{?F\}?|F\s*\(|vector\s+field|<[^>]+>)/iu.test(text);
  const hasStokesContext = /(?:stokes|boundary\s+curve|oriented\s+upward|upward\s+oriented|upper\s+cap|paraboloid|surface\s+S|\\iint_?\s*\{?S\}?|∬_?\s*S)/iu.test(text);
  const hasCurlSurfaceIntegral = /(?:curl|\\nabla\s*\\times|∇\s*×)/iu.test(text)
    && /(?:dS|surface|\\cdot\s*(?:\\mathbf\s*\{?n\}?|n)|boundary|oriented)/iu.test(text);
  return hasVectorField && (hasStokesContext || hasCurlSurfaceIntegral);
}

function hasEllipseGreenDomain(problem = "") {
  const compact = safeString(problem).replace(/\s+/g, "");
  return /x\^2\/4\+y\^2\/9=1|x\^2\+y\^2\/?/.test(compact)
    || /ellipse|ellipsoid|elliptic/i.test(problem);
}

function hasNonPolynomialCosFraction(problem = "") {
  const compact = safeString(problem).replace(/\s+/g, "");
  return /cos\(xy\)\/\(1\+x\^2\+y\^2\)|\\frac\{\\cos\(xy\)\}\{1\+x\^2\+y\^2\}/i.test(compact);
}

function hasSupportedParityProof(text = "") {
  return /parity|even|odd\s+in\s+[xy]|symmetric\s+domain|under\s+\(?x,y\)?\s*(?:\\mapsto|->|to)\s*\(?-?x,-?y\)?/i.test(text);
}

function mentionsFractionDerivative(text = "") {
  const compact = safeString(text).replace(/\s+/g, "");
  return /\\partial|∂|quotient|denominator.*squared|sin\(xy\)|\\sin\(xy\)|\(1\+x\^2\+y\^2\)\^2|\{2\}/i.test(compact);
}

function mentionsBoundaryOrParameterization(text = "") {
  return /(?:boundary|curve\s+C|\\oint|∮|parameteri[sz]|parametri[sz]|x\s*=|y\s*=|\\mathbf\{?r\}?|\br\s*\()/iu.test(text);
}

function mentionsIntegralSetup(text = "") {
  return /(?:\\oint|∮|\\iint|∬|\\int|∫|d\\mathbf\{?r\}?|,?d[xyztr]|d\\theta|dA|dS)/iu.test(text);
}

function mentionsSimplification(text = "") {
  return /(?:simplif|substitut|becomes|therefore|so\s+the\s+integrand|curl|Green|Jacobian|non-elementary|elementary closed form|does not simplify|cannot be simplified)/iu.test(text);
}

function statesNonElementary(text = "") {
  return /(?:non-elementary|no expected elementary closed form|does not simplify to an elementary closed form|cannot be expressed in elementary functions|leave(?:s)?\s+(?:it\s+)?as\s+(?:an\s+)?integral)/iu.test(text);
}

function isPlainEquationProblem(problem = "") {
  const text = safeString(problem);
  return /(?:=|\\le|\\ge|<=|>=)/.test(text)
    && !/(?:differentiat|derivative|d\/dx|\\frac\{d\}\{dx\}|prime|curl|divergence|gradient|\\nabla|∇|\\mathbf|vector\s+field|line\s+integral|surface\s+integral|stokes|green)/iu.test(text);
}

function normalizeMathText(value = "") {
  return safeString(value)
    .replace(/\\left|\\right/g, "")
    .replace(/\\boxed\{([^{}]+)\}/g, "$1")
    .replace(/\s+/g, "")
    .replace(/\{([+-]?\d+(?:\.\d+)?)\}/g, "$1")
    .replace(/−/g, "-");
}

function parseSimpleAdditivePowerEquation(problem = "") {
  const compact = normalizeMathText(problem);
  const match = compact.match(/^x\+(\d+)\^(\d+)=0$/i);
  if (!match) return null;
  const base = Number(match[1]);
  const exponent = Number(match[2]);
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(exponent) || exponent < 0 || exponent > 8) return null;
  const value = base ** exponent;
  if (!Number.isSafeInteger(value)) return null;
  return {
    base,
    exponent,
    expectedFinal: `x=-${value}`,
  };
}

function parsePerfectSquareTrinomialEquation(problem = "") {
  const compact = normalizeMathText(problem);
  const match = compact.match(/^x\^2([+-])(\d+)x([+-])(\d+)=0$/i);
  if (!match) return null;

  const middleSign = match[1] === "-" ? -1 : 1;
  const middleCoefficient = middleSign * Number(match[2]);
  const constant = (match[3] === "-" ? -1 : 1) * Number(match[4]);
  if (!Number.isSafeInteger(middleCoefficient) || !Number.isSafeInteger(constant) || constant <= 0) return null;
  if (middleCoefficient % 2 !== 0) return null;

  const binomialConstant = Math.abs(middleCoefficient / 2);
  if (binomialConstant ** 2 !== constant) return null;

  const binomialSign = middleCoefficient < 0 ? "-" : "+";
  return {
    binomialConstant,
    binomialSign,
    originalEquation: `x^2${binomialSign}${Math.abs(middleCoefficient)}x+${constant}=0`,
    expectedGroupedStep: `(x${binomialSign}${binomialConstant})^2=0`,
    expectedLinearStep: `x${binomialSign}${binomialConstant}=0`,
    expectedFinal: `x=${-(middleCoefficient / 2)}`,
    invalidChain: `x^2${binomialSign}${Math.abs(middleCoefficient)}x+${constant}=(x${binomialSign}${binomialConstant})^2=0`,
    forbiddenFlattenedStep: `x${binomialSign}${binomialConstant}^2=0`,
  };
}

function hasExpectedGroupedPerfectSquareStep(solutionText = "", perfectSquare = null) {
  if (!perfectSquare) return false;
  return normalizeMathText(solutionText).includes(normalizeMathText(perfectSquare.expectedGroupedStep));
}

function hasFlattenedPerfectSquarePowerStep(solutionText = "", perfectSquare = null) {
  if (!perfectSquare) return false;
  return normalizeMathText(solutionText).includes(normalizeMathText(perfectSquare.forbiddenFlattenedStep));
}

function hasInvalidPerfectSquareEqualityChain(solutionText = "", perfectSquare = null) {
  if (!perfectSquare) return false;
  return normalizeMathText(solutionText).includes(normalizeMathText(perfectSquare.invalidChain));
}

function hasExpectedLinearPerfectSquareStep(solutionText = "", perfectSquare = null) {
  if (!perfectSquare) return false;
  return normalizeMathText(solutionText).includes(normalizeMathText(perfectSquare.expectedLinearStep));
}

function hasPlusMinusPerfectSquareZeroRoot(solutionText = "", perfectSquare = null) {
  return Boolean(perfectSquare && /\\pm|±/.test(solutionText));
}

function stepRenderableText(step = {}) {
  const lineText = Array.isArray(step.lines)
    ? step.lines.map((line) => safeString(line?.latex || line?.math || line?.text)).filter(Boolean).join(" ")
    : "";
  return [
    step.math,
    step.latex,
    step.equationLatex,
    lineText,
  ].map(safeString).filter(Boolean).join(" ").trim();
}

function validateStepHasRenderableContent(step = {}, index = 0, total = 0) {
  const text = stepRenderableText(step);
  if (text) return null;
  const title = safeString(step.label || step.title || step.heading);
  if (/solve\s+for\s+x|set\s+the\s+equation\s+and\s+solve/iu.test(title)) return "empty_solve_for_x_step";
  if (index < total - 1) return "empty_non_final_step";
  return null;
}

const SPECIAL_FUNCTION_PATTERNS = [
  { name: "zeta", pattern: /\\zeta\b|ζ/iu },
  { name: "Gamma", pattern: /\\Gamma\b|Γ/iu },
  { name: "polylogarithm", pattern: /\\operatorname\s*\{\s*Li\s*\}|\\mathrm\s*\{\s*Li\s*\}|\\Li\b|\bLi_\s*\{?[\w+-]+\}?/iu },
  { name: "elliptic integral", pattern: /elliptic\s+integral|\\operatorname\s*\{\s*(?:Elliptic|EllipticE|EllipticK|EllipticF|EllipticPi)\s*\}|\\(?:EllipticE|EllipticK|EllipticF|EllipticPi)\b/iu },
];

function extractSpecialFunctions(text = "") {
  const value = safeString(text);
  return SPECIAL_FUNCTION_PATTERNS
    .filter(({ pattern }) => pattern.test(value))
    .map(({ name }) => name);
}

function stepFullText(step = {}) {
  const lineText = Array.isArray(step.lines)
    ? step.lines.map((line) => safeString(line?.latex || line?.math || line?.text || line?.summary)).filter(Boolean).join(" ")
    : "";
  return [
    step.label,
    step.title,
    step.heading,
    step.math,
    step.latex,
    step.equationLatex,
    step.summary,
    step.reasoning,
    step.plainExplanation,
    lineText,
  ].map(safeString).filter(Boolean).join(" ");
}

function explicitlyJustifiesSpecialFunction(stepText = "", specialName = "") {
  const text = safeString(stepText);
  if (!text) return false;
  const hasIdentityLanguage = /derive|derivation|prove|proof|shown\s+by|from\s+the\s+(?:series|definition|identity)|using\s+the\s+identity|identity\s+is|cite|cited|by\s+(?:Euler|Feynman|Parseval|Mellin|Beta|Gamma)|known\s+identity\s*:/iu.test(text);
  const hasDisplayedIdentity = /(?:=|\\sum|∑|\\prod|∏|\\int|∫).*(?:\\zeta|ζ|\\Gamma|Γ|\\operatorname\s*\{\s*Li\s*\}|elliptic)/iu.test(text);
  const merelyKnownResult = /known\s+(?:integral\s+)?result|standard\s+result|table\s+result/iu.test(text) && !hasDisplayedIdentity;
  return !merelyKnownResult && hasIdentityLanguage && (hasDisplayedIdentity || new RegExp(specialName, "iu").test(text));
}

function findAbruptSpecialFunctionIntroductions(result = {}, { problem = "" } = {}) {
  const seen = new Set(extractSpecialFunctions(problem));
  const issues = [];
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  for (const step of steps) {
    const text = stepFullText(step);
    for (const specialName of extractSpecialFunctions(text)) {
      if (seen.has(specialName)) continue;
      if (!explicitlyJustifiesSpecialFunction(text, specialName)) {
        issues.push(`abrupt_special_function_introduction:${specialName}`);
      }
      seen.add(specialName);
    }
  }
  for (const specialName of extractSpecialFunctions(safeString(result?.finalAnswerLatex || result?.finalAnswer))) {
    if (!seen.has(specialName)) issues.push(`abrupt_special_function_introduction:${specialName}`);
    seen.add(specialName);
  }
  return issues;
}

function finalAnswerMatchesSimplePowerEquation(finalAnswer = "", expectedFinal = "") {
  const compactFinal = normalizeMathText(finalAnswer)
    .replace(/\\,/g, "")
    .replace(/;/g, ",");
  const expected = normalizeMathText(expectedFinal);
  return compactFinal === expected
    || compactFinal.includes(expected)
    || compactFinal.includes(expected.replace("x=", ""));
}

function isDerivativeOnlyRuleResponse(text = "") {
  const compact = safeString(text).replace(/\s+/g, " ");
  return /(?:power rule|product rule|chain rule|quotient rule|d\/dx|\\frac\{d\}\{dx\}|n\s*x\^\(?n-?1\)?|n x\^\(n-1\))/iu.test(compact)
    && !/(?:solve|root|quadratic|zero|equation|=0|factor|formula|discriminant)/iu.test(compact);
}

function resultMathFragments(result = {}) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  return steps.flatMap((step, stepIndex) => {
    const fragments = [
      step.math,
      step.latex,
      step.equationLatex,
      ...(Array.isArray(step.lines)
        ? step.lines.map((line) => line?.latex || line?.math || line?.text)
        : []),
    ].map(safeString).filter(Boolean);
    return fragments.map((text) => ({
      stepIndex,
      text,
      step,
    }));
  });
}

function resultLatexValidationFields(result = {}) {
  const fields = [];
  if (result?.problemLatex) fields.push({ fieldPath: "problemLatex", value: result.problemLatex });
  if (result?.extractedProblemLatex) fields.push({ fieldPath: "extractedProblemLatex", value: result.extractedProblemLatex });
  if (result?.finalAnswerLatex || result?.finalAnswer) {
    fields.push({ fieldPath: "finalAnswerLatex", value: result.finalAnswerLatex || result.finalAnswer, finalAnswer: true });
  }
  for (const fragment of resultMathFragments(result)) {
    fields.push({ fieldPath: `steps[${fragment.stepIndex}]`, value: fragment.text });
  }
  return fields;
}

function isGenericImagePrompt(value = "") {
  return /explain\s+(?:the\s+)?math\s+problem\s+in\s+this\s+image/i.test(safeString(value));
}

function originalProblemForSymbolValidation(problem = "", result = {}) {
  if (isGenericImagePrompt(problem)) {
    return safeString(result?.extractedProblemLatex || result?.expression || result?.originalProblem || problem);
  }
  return safeString(problem || result?.extractedProblemLatex || result?.originalProblem || result?.expression || result?.problem);
}

function isAlignedDerivationFragment(text = "") {
  return /\\begin\s*\{\s*(?:aligned|align|alignat|gathered|split|array)\s*\}/iu.test(text);
}

function findDetachedRelationLeadingFragment(result = {}) {
  for (const fragment of resultMathFragments(result)) {
    if (isAlignedDerivationFragment(fragment.text)) continue;
    const trimmed = fragment.text.trim();
    if (/^&?\s*(?:=|<|>|≤|≥|≈|\\(?:leq?|geq?|lt|gt|approx|sim)(?![A-Za-z]))/u.test(trimmed)) {
      return {
        stepIndex: fragment.stepIndex,
        text: trimmed.slice(0, 80),
      };
    }
  }
  return null;
}

function findNamedSignInconsistency(result = {}) {
  const mathText = [
    ...resultMathFragments(result).map((fragment) => fragment.text),
    result?.finalAnswerLatex,
    result?.finalAnswer,
  ].map(safeString).filter(Boolean).join(";");
  const solutionCompact = normalizeMathText(mathText).replace(/\\cdot/g, "*");
  const finalCompact = normalizeMathText(result?.finalAnswerLatex || result?.finalAnswer).replace(/\\cdot/g, "*");
  if (!solutionCompact || !finalCompact) return null;
  const relationPattern = /(^|[^A-Za-z])([A-Z])=-(?:\d+(?:\.\d+)?\*?)?([A-Z])(?=$|[^A-Za-z])/g;
  for (const match of solutionCompact.matchAll(relationPattern)) {
    const left = match[2];
    const right = match[3];
    if (
      finalCompact === right
      || finalCompact.endsWith(`=${right}`)
      || finalCompact.includes(`${left}=${right}`)
      || finalCompact.includes(`${left}=+${right}`)
    ) {
      return {
        relation: `${left}=-...${right}`,
        finalAnswer: finalCompact,
      };
    }
  }
  return null;
}

function hasAffirmativeIntegrationByPartsClaim(text = "") {
  const compact = safeString(text).replace(/\s+/g, " ");
  const normalized = compact.replace(/integration-by-parts/giu, "integration by parts");
  return /\b(?:use|using|apply|applying|perform|performing|invoke|invoking|choose|choosing|via|with)\s+(?:the\s+)?integration\s+by\s+parts\b/iu.test(normalized)
    || /\bintegration\s+by\s+parts\s+(?:formula|setup|method|gives|yields|with)\b/iu.test(normalized);
}

function hasIntegrationByPartsDeclaration(text = "") {
  const compact = safeString(text).replace(/\s+/g, " ");
  return (/\bu\s*=/iu.test(compact) && /\bdv\s*=/iu.test(compact))
    || hasAffirmativeIntegrationByPartsClaim(compact);
}

function findIntegrationByPartsDeclarationEvidence(text = "") {
  const compact = safeString(text).replace(/\s+/g, " ");
  return compact.match(/\bu\s*=.{0,120}\bdv\s*=\s*.{0,180}/iu)?.[0]
    || compact.match(/(?:use|using|apply|applying|perform|performing|invoke|invoking|choose|choosing|via|with)\s+(?:the\s+)?integration\s+by\s+parts.{0,160}/iu)?.[0]
    || "integration by parts setup is unsupported";
}

function hasKnownFalseIntegrationByPartsIdentity(text = "") {
  const compact = safeString(text)
    .replace(/\\left|\\right/g, "")
    .replace(/\\[,;!]/g, "")
    .replace(/\s+/g, "");
  return /\\int\\cot\\theta\\ln\(?\\cos\\theta\)?d\\theta=-\\frac\{1\}\{2\}\\ln\^2\(?\\sin\\theta\)?/iu.test(compact);
}

function hasUsableIntegrationByPartsV(text = "") {
  const compact = safeString(text).replace(/\s+/g, " ");
  const assignments = [...compact.matchAll(/(?:^|[\s,;])v\s*=\s*([^.;]+)/giu)];
  return assignments.some((match) => {
    const rhs = safeString(match[1]).split(/\s+(?:and|then|so)\s+/iu)[0] || "";
    const rhsParts = rhs.split("=").map((part) => part.trim()).filter(Boolean);
    const finalRhs = rhsParts[rhsParts.length - 1] || rhs;
    return finalRhs
      && !/^(?:\\int|∫|\bint\b)/iu.test(finalRhs)
      && !/^(?:an\s+)?unevaluated\s+integral$/iu.test(finalRhs);
  });
}

function hasRecognizedIntegrationByPartsIdentity(text = "") {
  if (hasKnownFalseIntegrationByPartsIdentity(text)) return false;
  return /(?:derive|computed?|integrat(?:e|ing)|so)\s+v\b|tabular|reduction\s+formula|recognized\s+identity|using\s+the\s+identity|differentiati(?:ng|on)\s+under\s+the\s+integral/iu.test(text);
}

function findUnsupportedIntegrationByPartsSetup(result = {}) {
  const text = flattenSolutionText(result);
  if (!hasIntegrationByPartsDeclaration(text)) return null;
  const hasU = /\bu\s*=/iu.test(text);
  const hasDv = /\bdv\s*=/iu.test(text);
  if (!hasU || !hasDv) {
    return {
      evidence: findIntegrationByPartsDeclarationEvidence(text),
    };
  }
  if (hasKnownFalseIntegrationByPartsIdentity(text)) {
    const declarationEvidence = findIntegrationByPartsDeclarationEvidence(text);
    return {
      evidence: `${declarationEvidence}; \\int \\cot\\theta\\ln(\\cos\\theta)d\\theta = -\\frac12\\ln^2(\\sin\\theta)+C is not a valid antiderivative identity`,
    };
  }
  if (hasUsableIntegrationByPartsV(text)) return null;
  if (hasRecognizedIntegrationByPartsIdentity(text)) {
    return null;
  }
  return {
    evidence: findIntegrationByPartsDeclarationEvidence(text),
  };
}

function findUnsupportedFinalAnswerJump(result = {}) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  if (steps.length < 2) return null;
  const finalCompact = normalizeMathText(result?.finalAnswerLatex || result?.finalAnswer);
  if (!finalCompact || finalCompact.length < 2) return null;
  const finalValue = finalCompact.includes("=") ? finalCompact.split("=").filter(Boolean).pop() : finalCompact;
  if (!finalValue || finalValue.length < 1) return null;
  const lastStep = steps[steps.length - 1] || {};
  const lastMath = normalizeMathText(stepRenderableText(lastStep));
  if (!lastMath.includes("=") || !lastMath.includes(finalValue)) return null;
  const lhs = lastMath.split("=")[0] || "";
  const priorCompact = normalizeMathText(steps.slice(0, -1).map(stepFullText).join(" "));
  const hasPriorConnection = priorCompact.includes(finalValue) || (lhs.length >= 1 && priorCompact.includes(lhs));
  const hasBridgeLanguage = /from|using|substitut|evaluate|previous|above|therefore|hence|so|combine|simplif|identity|series|limit|plug/iu.test(stepFullText(lastStep));
  if (hasPriorConnection || hasBridgeLanguage) return null;
  return {
    finalStep: lastMath.slice(0, 120),
    finalAnswer: finalCompact,
  };
}

function findUnsupportedTheoremOrSymmetryClaim(result = {}, problem = "") {
  const text = flattenSolutionText(result);
  const compact = safeString(text).replace(/\s+/g, " ");
  const combined = `${safeString(problem)} ${compact}`;
  const symmetryClaim = /(?:by\s+symmetry|symmetry|odd|even).{0,80}(?:zero|vanish|cancel)|(?:zero|vanish|cancel).{0,80}(?:by\s+symmetry|odd|even)/iu.test(compact);
  const theoremClaim = /(?:by|using|apply)\s+(?:Green's theorem|Stokes'? theorem|divergence theorem)/iu.test(compact);
  if (!symmetryClaim && !theoremClaim) return null;
  const supportedSymmetry = hasSupportedParityProof(compact)
    || /symmetric\s+(?:domain|interval|limits)|(?:-\s*(?:a|\d+|\\pi|π).{0,40}(?:a|\d+|\\pi|π))|under\s+.+(?:\\mapsto|->|to).+-/iu.test(combined);
  const supportedTheorem = !theoremClaim
    || looksLikeStokesCurlProblem(problem)
    || /(?:\\iint|∬|\\oint|∮|dA|dS|boundary|region|curve|surface|vector\s+field|\\mathbf\s*\{?F\}?)/iu.test(problem);
  if (symmetryClaim && !supportedSymmetry) {
    return {
      evidence: "symmetry cancellation claimed without parity/domain transformation evidence",
    };
  }
  if (theoremClaim && !supportedTheorem) {
    return {
      evidence: "vector-calculus theorem claimed without matching problem domain evidence",
    };
  }
  return null;
}

function usesCoordinateChange(text = "") {
  return /(?:polar|change variables|coordinate change|x\s*=\s*r|y\s*=\s*r|x\s*=\s*2r|y\s*=\s*3r|Jacobian)/iu.test(text);
}

function isMultivariableIntegralProblem(problem = "") {
  return looksLikeStokesCurlProblem(problem)
    || /(?:\\iint|∬|\\iiint|∭|double\s+integral|triple\s+integral|surface\s+integral|line\s+integral|dA|dS|dV|Jacobian|polar|cylindrical|spherical|ellipse|elliptic|region\s+D|domain\s+D)/iu.test(problem);
}

function coordinateChangeApplicability(problemText = "", compact = "") {
  if (!usesCoordinateChange(compact)) {
    return {
      applicable: false,
      reason: "solution does not use a coordinate-change method",
    };
  }
  if (!isMultivariableIntegralProblem(problemText)) {
    return {
      applicable: false,
      reason: "submitted problem is not a multivariable integral or vector-calculus coordinate-change problem",
    };
  }
  return {
    applicable: true,
    reason: "solution uses a coordinate-change method for a multivariable/vector-calculus problem",
  };
}

function emitRuleEvaluation(evaluations, options, evaluation) {
  const normalized = {
    validatorName: evaluation.validatorName || evaluation.name,
    name: evaluation.name,
    issue: evaluation.issue || evaluation.name,
    domain: evaluation.domain || "general",
    applicable: Boolean(evaluation.applicable),
    applicabilityReason: evaluation.applicabilityReason || "",
    inputFields: evaluation.inputFields || [],
    global: Boolean(evaluation.global),
    result: evaluation.applicable
      ? (evaluation.passed ? "pass" : "fail")
      : "not_applicable",
    failureEvidence: evaluation.applicable && !evaluation.passed
      ? (evaluation.failureEvidence || evaluation.issue || evaluation.name)
      : null,
  };
  evaluations.push(normalized);
  if (typeof options.onRuleEvaluation === "function") {
    options.onRuleEvaluation(normalized);
  }
  return normalized;
}

function createValidationContext({
  result = {},
  problemText = "",
  includeQualityRules = true,
  steps = [],
  finalAnswer = "",
  solutionText = "",
  compact = "",
  complexStokes = false,
  ellipseGreenDomain = false,
  nonPolynomialStokesFraction = false,
  coordinateApplicability = {},
  finalIntegralApplicable = false,
  nonElementaryApplicable = false,
  perfectSquareApplicable = false,
  plainEquation = false,
  simplePowerEquation = null,
  symmetryClaimed = false,
  phase2Diagnostics = {},
} = {}) {
  return {
    includeQualityRules,
    stepCount: steps.length,
    finalAnswerPresent: Boolean(finalAnswer),
    finalAnswerLength: finalAnswer.length,
    solutionTextLength: solutionText.length,
    compactTextLength: compact.length,
    problemText,
    complexStokes,
    ellipseGreenDomain,
    nonPolynomialStokesFraction,
    coordinateChangeApplicability: coordinateApplicability,
    finalIntegralApplicable,
    nonElementaryApplicable,
    perfectSquareApplicable,
    plainEquation,
    simplePowerEquation: simplePowerEquation
      ? {
          base: simplePowerEquation.base,
          exponent: simplePowerEquation.exponent,
          expectedFinal: simplePowerEquation.expectedFinal,
        }
      : null,
    symmetryClaimed,
    numericFinalAnswerAnalysis: phase2Diagnostics.numericFinalAnswerAnalysis || null,
    finalAnswerPresenceResult: phase2Diagnostics.finalAnswerPresenceResult || null,
    setValuedAnswerAnalysis: phase2Diagnostics.setValuedAnswerAnalysis || null,
    answerTargetConsistencyResult: phase2Diagnostics.answerTargetConsistencyResult || null,
    signAnalysisResult: phase2Diagnostics.signAnalysisResult || null,
    finalAnswerConsistencyResult: phase2Diagnostics.finalAnswerConsistencyResult || null,
    identityVerificationResult: phase2Diagnostics.identityVerificationResult || null,
    substitutionConsistencyResult: phase2Diagnostics.substitutionConsistencyResult || null,
    numericalCrossCheckResult: phase2Diagnostics.numericalCrossCheckResult || null,
    symbolOriginDiagnostics: phase2Diagnostics.symbolOriginDiagnostics || null,
    firstFailingStepId: phase2Diagnostics.firstFailingStepId || null,
    relevantStepLatex: phase2Diagnostics.relevantStepLatex || "",
    resourceLimitResults: phase2Diagnostics.resourceLimitResults || [],
    resultFields: Object.keys(result || {}),
  };
}

function addValidationRule(evaluations, issues, options, {
  name,
  issue = name,
  domain = "general",
  applicable = true,
  applicabilityReason = "rule is global",
  inputFields = [],
  global = false,
  passed = true,
  failureEvidence = "",
}) {
  const evaluation = emitRuleEvaluation(evaluations, options, {
    name,
    issue,
    domain,
    applicable,
    applicabilityReason,
    inputFields,
    global,
    passed,
    failureEvidence,
  });
  if (evaluation.applicable && evaluation.result === "fail") {
    issues.push(issue);
  }
  return evaluation;
}

function buildSolutionRuleEvaluations(result, { problem = "", includeQualityRules = true, onRuleEvaluation = null } = {}) {
  const validationStartedAt = Date.now();
  const options = { onRuleEvaluation };
  const issues = [];
  const evaluations = [];
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const finalAnswer = safeString(result?.finalAnswerLatex || result?.finalAnswer);
  const solutionText = flattenSolutionText(result);
  const compact = solutionText.replace(/\s+/g, " ").trim();
  const problemText = originalProblemForSymbolValidation(problem, result);
  const complexStokes = looksLikeStokesCurlProblem(problemText);
  const ellipseGreenDomain = complexStokes && hasEllipseGreenDomain(problemText);
  const nonPolynomialStokesFraction = complexStokes && hasNonPolynomialCosFraction(problemText);
  const coordinateApplicability = coordinateChangeApplicability(problemText, compact);
  let finalIntegralApplicable = false;
  let nonElementaryApplicable = false;
  let perfectSquareApplicable = false;
  let plainEquation = false;
  let simplePowerEquation = null;
  let symmetryClaimed = false;
  const phase2Diagnostics = { resourceLimitResults: [] };

  function rememberPhase2Failure(diagnostic = {}) {
    if (!diagnostic?.issue) return;
    if (!phase2Diagnostics.firstFailingStepId && diagnostic.firstFailingStepId) {
      phase2Diagnostics.firstFailingStepId = diagnostic.firstFailingStepId;
    }
    if (!phase2Diagnostics.relevantStepLatex && diagnostic.relevantStepLatex) {
      phase2Diagnostics.relevantStepLatex = diagnostic.relevantStepLatex;
    }
  }

  function rememberResourceLimit(diagnostic = null) {
    if (!diagnostic) return;
    phase2Diagnostics.resourceLimitResults.push(diagnostic);
  }

  function addResourceLimitRule(diagnostic = null) {
    if (!diagnostic) return;
    rememberResourceLimit(diagnostic);
    addValidationRule(evaluations, issues, options, {
      name: "validation_resource_limit_reached",
      issue: "validation_resource_limit_reached",
      domain: "validation resource limits",
      applicable: true,
      applicabilityReason: "validation input exceeded a configured resource limit",
      inputFields: ["problem", "result.steps", "result.finalAnswerLatex"],
      global: true,
      passed: false,
      failureEvidence: JSON.stringify(diagnostic),
    });
  }

  function elapsedResourceLimit(validationStage) {
    const elapsedMs = Date.now() - validationStartedAt;
    if (elapsedMs <= MAX_VALIDATION_MS) return null;
    return createResourceLimitDiagnostic({
      limitType: "validation_wall_clock_ms",
      configuredLimit: MAX_VALIDATION_MS,
      observedValue: elapsedMs,
      validationStage,
      startedAt: validationStartedAt,
    });
  }

  const longestStepChars = steps.reduce((max, step) => Math.max(max, safeString(step?.math || step?.latex || step?.equationLatex || step?.summary || step?.reasoning).length), 0);
  const structuralResourceLimits = [
    steps.length > MAX_VALIDATION_STEPS
      ? createResourceLimitDiagnostic({
          limitType: "solution_steps",
          configuredLimit: MAX_VALIDATION_STEPS,
          observedValue: steps.length,
          validationStage: "validation_preflight",
          startedAt: validationStartedAt,
        })
      : null,
    longestStepChars > MAX_STEP_CHARACTERS
      ? createResourceLimitDiagnostic({
          limitType: "step_characters",
          configuredLimit: MAX_STEP_CHARACTERS,
          observedValue: longestStepChars,
          validationStage: "validation_preflight",
          startedAt: validationStartedAt,
        })
      : null,
    solutionText.length > MAX_TOTAL_VALIDATION_CHARACTERS
      ? createResourceLimitDiagnostic({
          limitType: "total_validation_characters",
          configuredLimit: MAX_TOTAL_VALIDATION_CHARACTERS,
          observedValue: solutionText.length,
          validationStage: "validation_preflight",
          startedAt: validationStartedAt,
        })
      : null,
  ].filter(Boolean);
  for (const resourceLimit of structuralResourceLimits) {
    addResourceLimitRule(resourceLimit);
  }

  const finalAnswerPresence = analyzeFinalAnswerPresence(finalAnswer);
  phase2Diagnostics.finalAnswerPresenceResult = finalAnswerPresence;

  addValidationRule(evaluations, issues, options, {
    name: "missing_final_answer",
    domain: "all generated solutions",
    applicable: true,
    applicabilityReason: "every solution must provide a final answer",
    inputFields: ["result.finalAnswer", "result.finalAnswerLatex"],
    global: true,
    passed: finalAnswerPresence.present,
    failureEvidence: finalAnswerPresence.present
      ? ""
      : JSON.stringify(finalAnswerPresence),
  });

  const setValuedAnswerAnalysis = analyzeSetValuedAnswer(finalAnswer);
  phase2Diagnostics.setValuedAnswerAnalysis = setValuedAnswerAnalysis;
  addValidationRule(evaluations, issues, options, {
    name: "malformed_set_valued_answer",
    issue: "malformed_set_valued_answer",
    domain: "set-valued and multi-valued final answers",
    applicable: setValuedAnswerAnalysis.candidate,
    applicabilityReason: setValuedAnswerAnalysis.candidate
      ? "final answer appears set-valued or multi-valued"
      : "final answer does not appear set-valued or multi-valued",
    inputFields: ["result.finalAnswerLatex"],
    passed: !setValuedAnswerAnalysis.candidate || setValuedAnswerAnalysis.wellFormed,
    failureEvidence: setValuedAnswerAnalysis.candidate && !setValuedAnswerAnalysis.wellFormed
      ? JSON.stringify({
          reason: setValuedAnswerAnalysis.reason,
          normalized: setValuedAnswerAnalysis.normalized,
        })
      : "",
  });

  const latexIssues = collectGeneratedLatexValidationIssues(resultLatexValidationFields(result));
  addValidationRule(evaluations, issues, options, {
    name: "strict_generated_latex",
    issue: latexIssues.length > 0 ? "strict_generated_latex" : "strict_generated_latex",
    domain: "all generated math fields",
    applicable: true,
    applicabilityReason: "all generated math returned to the UI must be strict KaTeX-compatible LaTeX",
    inputFields: ["result.problemLatex", "result.extractedProblemLatex", "result.finalAnswerLatex", "result.steps"],
    global: true,
    passed: latexIssues.length === 0,
    failureEvidence: latexIssues.map((issue) => `${issue.fieldPath}:${issue.issues.join(",")}`).join("; "),
  });

  const symbolDiagnostics = analyzeSymbolOrigins(problemText, result);
  phase2Diagnostics.symbolOriginDiagnostics = {
    originalSymbols: symbolDiagnostics.originalSymbols,
    generatedSymbols: symbolDiagnostics.generatedSymbols,
    newlyIntroducedSymbols: symbolDiagnostics.newlyIntroducedSymbols,
    explicitDefinitions: symbolDiagnostics.explicitDefinitions,
    unexplainedSymbols: symbolDiagnostics.unexplainedSymbols,
    boundSymbolProvenance: symbolDiagnostics.boundSymbolProvenance,
    fieldReports: symbolDiagnostics.fieldReports.map((field) => ({
      fieldPath: field.fieldPath,
      sourceType: field.sourceType,
      value: field.value,
      fragmentIndex: field.fragmentIndex,
      fragmentStart: field.fragmentStart,
      fragmentEnd: field.fragmentEnd,
      extractionReason: field.extractionReason,
      symbols: field.symbols,
      unexplainedSymbols: field.unexplainedSymbols,
      boundSymbolProvenance: field.boundSymbolProvenance,
    })),
  };
  for (const fieldReport of symbolDiagnostics.fieldReports) {
    for (const symbol of fieldReport.unexplainedSymbols) {
      addValidationRule(evaluations, issues, options, {
        name: "unexplained_generated_symbol",
        issue: `unexplained_generated_symbol:${symbol}`,
        domain: "generated equation fields",
        applicable: true,
        applicabilityReason: "generated equations may only use original, bound, standard, or explicitly introduced symbols",
        inputFields: [fieldReport.fieldPath],
        global: false,
        passed: false,
        failureEvidence: JSON.stringify({
          symbol,
          fieldPath: fieldReport.fieldPath,
          sourceType: fieldReport.sourceType,
          classification: "undefined_free_symbol",
          value: fieldReport.value,
          fragmentIndex: fieldReport.fragmentIndex,
          fragmentStart: fieldReport.fragmentStart,
          fragmentEnd: fieldReport.fragmentEnd,
          extractionReason: fieldReport.extractionReason,
          localBoundSymbols: (fieldReport.boundSymbolProvenance || []).map((binding) => binding.symbol),
        }),
      });
    }
  }
  if (symbolDiagnostics.unexplainedSymbols.length === 0) {
    addValidationRule(evaluations, issues, options, {
      name: "unexplained_generated_symbol",
      domain: "generated equation fields",
      applicable: true,
      applicabilityReason: "generated symbol inventory was checked",
      inputFields: ["problem", "result.steps", "result.finalAnswerLatex"],
      global: true,
      passed: true,
    });
  }

  const answerTargetConsistency = analyzeAnswerTargetConsistency(problemText, result);
  phase2Diagnostics.answerTargetConsistencyResult = answerTargetConsistency;
  addValidationRule(evaluations, issues, options, {
    name: "answer_target_mismatch",
    issue: "answer_target_mismatch",
    domain: "unambiguous solve-target final answers",
    applicable: answerTargetConsistency.applicable,
    applicabilityReason: answerTargetConsistency.applicable
      ? "problem has an unambiguous answer target and final answer assigns a target"
      : answerTargetConsistency.detectionReason,
    inputFields: ["problem", "result.finalAnswerLatex"],
    passed: !answerTargetConsistency.issue,
    failureEvidence: answerTargetConsistency.evidence || "",
  });

  addValidationRule(evaluations, issues, options, {
    name: "undefined_final_placeholder",
    domain: "all generated solutions",
    applicable: true,
    applicabilityReason: "every final answer must resolve placeholders introduced in the solution",
    inputFields: ["result.finalAnswer", "result.finalAnswerLatex", "result.steps"],
    global: true,
    passed: !hasUndefinedFinalPlaceholder(finalAnswer, solutionText),
    failureEvidence: finalAnswer,
  });

  const specialFunctionIssues = findAbruptSpecialFunctionIntroductions(result, { problem: problemText });
  if (specialFunctionIssues.length > 0) {
    for (const issue of specialFunctionIssues) {
      addValidationRule(evaluations, issues, options, {
        name: "abrupt_special_function_introduction",
        issue,
        domain: "solutions introducing special functions",
        applicable: true,
        applicabilityReason: "solution or final answer introduced a special function",
        inputFields: ["problem", "result.finalAnswer", "result.finalAnswerLatex", "result.steps"],
        global: true,
        passed: false,
        failureEvidence: issue,
      });
    }
  } else {
    addValidationRule(evaluations, issues, options, {
      name: "abrupt_special_function_introduction",
      domain: "solutions introducing special functions",
      applicable: true,
      applicabilityReason: "checked because any solution may introduce a special function",
      inputFields: ["problem", "result.finalAnswer", "result.finalAnswerLatex", "result.steps"],
      global: true,
      passed: true,
    });
  }

  const numericFinalAnswerAnalysis = analyzeNumericExpression(finalAnswer);
  phase2Diagnostics.numericFinalAnswerAnalysis = numericFinalAnswerAnalysis;
  if (numericFinalAnswerAnalysis.resourceLimit) {
    addResourceLimitRule(createResourceLimitDiagnostic({
      ...numericFinalAnswerAnalysis.resourceLimit,
      startedAt: validationStartedAt,
    }));
  }
  const unsupportedNumericFinal = numericFinalAnswerAnalysis.numericIntent
    && ["unsupported_numeric_syntax", "malformed"].includes(numericFinalAnswerAnalysis.status);
  addValidationRule(evaluations, issues, options, {
    name: "unsupported_numeric_final_answer_syntax",
    issue: "unsupported_numeric_final_answer_syntax",
    domain: "numeric final-answer expressions",
    applicable: unsupportedNumericFinal,
    applicabilityReason: unsupportedNumericFinal
      ? "final answer appears to be a numeric constant but cannot be evaluated safely"
      : (numericFinalAnswerAnalysis.status === "symbolic"
        ? "final answer is symbolic or parameterized"
        : "final answer numeric syntax was safely evaluated or not numeric-looking"),
    inputFields: ["result.finalAnswerLatex"],
    passed: !unsupportedNumericFinal,
    failureEvidence: unsupportedNumericFinal
      ? `status=${numericFinalAnswerAnalysis.status}; normalized=${numericFinalAnswerAnalysis.normalized}; reason=${numericFinalAnswerAnalysis.reason}`
      : "",
  });

  const finalAnswerConsistency = analyzeFinalAnswerConsistency(result);
  phase2Diagnostics.finalAnswerConsistencyResult = finalAnswerConsistency;
  rememberPhase2Failure(finalAnswerConsistency);
  if (finalAnswerConsistency.resourceLimit) {
    addResourceLimitRule(createResourceLimitDiagnostic({
      ...finalAnswerConsistency.resourceLimit,
      startedAt: validationStartedAt,
    }));
  }
  addValidationRule(evaluations, issues, options, {
    name: "final_answer_derivation_consistency",
    issue: finalAnswerConsistency.issue || "final_answer_derivation_consistency",
    domain: "final-answer derivation consistency",
    applicable: Boolean(finalAnswerConsistency.applicable || finalAnswerConsistency.issue),
    applicabilityReason: finalAnswerConsistency.issue
      ? "final answer contradicts the last supported derivation value"
      : finalAnswerConsistency.applicable
        ? "final answer and last supported derivation value were numerically comparable"
        : (finalAnswerConsistency.inconclusiveReason || "no safely comparable derivation value"),
    inputFields: ["result.finalAnswerLatex", "result.steps"],
    passed: !finalAnswerConsistency.issue,
    failureEvidence: finalAnswerConsistency.evidence || "",
  });

  const signAnalysis = analyzePositiveIntegralSign(problemText, result);
  phase2Diagnostics.signAnalysisResult = signAnalysis;
  rememberPhase2Failure(signAnalysis);
  if (signAnalysis.resourceLimit) {
    addResourceLimitRule(createResourceLimitDiagnostic({
      ...signAnalysis.resourceLimit,
      startedAt: validationStartedAt,
    }));
  }
  addValidationRule(evaluations, issues, options, {
    name: "positive_integral_sign_sanity",
    issue: signAnalysis.issue || "positive_integral_sign_sanity",
    domain: "definite real integral sign sanity",
    applicable: Boolean(signAnalysis.applicable || signAnalysis.issue),
    applicabilityReason: signAnalysis.issue
      ? "definite integral sign is contradicted by the proposed final value"
      : signAnalysis.applicable
        ? "integrand sign and proposed final-answer sign were conservatively comparable"
        : (signAnalysis.inconclusiveReason || "sign analysis was inconclusive"),
    inputFields: ["problem", "result.finalAnswerLatex"],
    passed: !signAnalysis.issue,
    failureEvidence: signAnalysis.issue
      ? `integrandSign=${signAnalysis.integrandSign}; orientation=${signAnalysis.orientation}; finalValue=${signAnalysis.finalValue}`
      : "",
  });

  const substitutionConsistency = analyzeSubstitutionConsistency(result, problemText);
  phase2Diagnostics.substitutionConsistencyResult = substitutionConsistency;
  rememberPhase2Failure(substitutionConsistency);
  if (substitutionConsistency.resourceLimit) {
    addResourceLimitRule(createResourceLimitDiagnostic({
      ...substitutionConsistency.resourceLimit,
      startedAt: validationStartedAt,
    }));
  }
  addValidationRule(evaluations, issues, options, {
    name: "substitution_local_consistency",
    issue: substitutionConsistency.issue || "substitution_local_consistency",
    domain: "parseable substitution steps",
    applicable: Boolean(substitutionConsistency.applicable || substitutionConsistency.issue),
    applicabilityReason: substitutionConsistency.issue
      ? "a parseable substitution step drops required algebraic factors"
      : substitutionConsistency.applicable
        ? "a guarded substitution pattern was checked"
        : (substitutionConsistency.inconclusiveReason || "no guarded substitution pattern found"),
    inputFields: ["problem", "result.steps"],
    passed: !substitutionConsistency.issue,
    failureEvidence: substitutionConsistency.evidence || "",
  });

  const identityVerification = verifyCriticalIdentities(result, problemText);
  phase2Diagnostics.identityVerificationResult = identityVerification;
  rememberPhase2Failure(identityVerification);
  if (identityVerification.resourceLimit) {
    addResourceLimitRule(createResourceLimitDiagnostic({
      ...identityVerification.resourceLimit,
      startedAt: validationStartedAt,
    }));
  }
  addValidationRule(evaluations, issues, options, {
    name: "critical_identity_verification",
    issue: identityVerification.issue || "critical_identity_verification",
    domain: "critical local identities",
    applicable: Boolean(identityVerification.applicable || identityVerification.issue),
    applicabilityReason: identityVerification.issue
      ? "a critical identity is unsupported or locally false"
      : identityVerification.applicable
        ? "parseable identity claims were checked"
        : "no parseable critical identity claim found",
    inputFields: ["problem", "result.steps", "result.finalAnswerLatex"],
    passed: !identityVerification.issue,
    failureEvidence: identityVerification.evidence || "",
  });

  const numericalCheck = numericalFinalAnswerCheck(problemText, result);
  phase2Diagnostics.numericalCrossCheckResult = numericalCheck;
  rememberPhase2Failure(numericalCheck);
  if (numericalCheck.resourceLimit) {
    addResourceLimitRule(createResourceLimitDiagnostic({
      ...numericalCheck.resourceLimit,
      startedAt: validationStartedAt,
    }));
  }
  addResourceLimitRule(elapsedResourceLimit("phase2_mathematical_validation"));
  addValidationRule(evaluations, issues, options, {
    name: "numerical_final_answer_cross_check",
    issue: numericalCheck.issue || "numerical_final_answer_cross_check",
    domain: "eligible one-dimensional definite real integrals",
    applicable: Boolean(numericalCheck.applicable || numericalCheck.issue),
    applicabilityReason: numericalCheck.issue
      ? "numerical cross-check confidently disagrees with the proposed final value"
      : numericalCheck.applicable
        ? "original integral and final answer were numerically comparable"
        : (numericalCheck.inconclusiveReason || "numerical cross-check was inconclusive"),
    inputFields: ["problem", "result.finalAnswerLatex"],
    passed: !numericalCheck.issue,
    failureEvidence: numericalCheck.issue
      ? `estimate=${numericalCheck.numericalEstimate}; proposed=${numericalCheck.proposedValue}; absDiff=${numericalCheck.absoluteDifference}; tolerance=${numericalCheck.tolerance}`
      : "",
  });

  const stokesReason = complexStokes
    ? "submitted problem contains Stokes/curl/surface-integral cues and vector-field/boundary cues"
    : "submitted problem lacks Stokes/curl/vector-field boundary cues";
  addValidationRule(evaluations, issues, options, {
    name: "too_few_steps",
    domain: "Stokes/Green vector-calculus solutions",
    applicable: complexStokes,
    applicabilityReason: stokesReason,
    inputFields: ["problem", "result.steps"],
    passed: steps.length > 1,
    failureEvidence: `stepCount=${steps.length}`,
  });
  addValidationRule(evaluations, issues, options, {
    name: "missing_stokes_theorem",
    domain: "Stokes/Green vector-calculus solutions",
    applicable: complexStokes,
    applicabilityReason: stokesReason,
    inputFields: ["problem", "result.steps", "result.summary"],
    passed: /(?:Stokes|\\oint|∮)/iu.test(compact),
    failureEvidence: "no Stokes theorem or boundary-integral statement found in solution",
  });
  addValidationRule(evaluations, issues, options, {
    name: "missing_boundary_or_parameterization",
    domain: "Stokes/Green vector-calculus solutions",
    applicable: complexStokes,
    applicabilityReason: stokesReason,
    inputFields: ["problem", "result.steps"],
    passed: mentionsBoundaryOrParameterization(compact),
    failureEvidence: "solution does not mention the boundary curve or a parameterization",
  });
  addValidationRule(evaluations, issues, options, {
    name: "missing_integral_setup",
    domain: "Stokes/Green vector-calculus solutions",
    applicable: complexStokes,
    applicabilityReason: stokesReason,
    inputFields: ["problem", "result.steps", "result.finalAnswer"],
    passed: mentionsIntegralSetup(compact),
    failureEvidence: "solution lacks an integral setup",
  });
  addValidationRule(evaluations, issues, options, {
    name: "missing_intermediate_simplification",
    domain: "Stokes/Green vector-calculus solutions",
    applicable: complexStokes,
    applicabilityReason: stokesReason,
    inputFields: ["problem", "result.steps"],
    passed: mentionsSimplification(compact),
    failureEvidence: "solution jumps without simplification/curl/Green/Jacobian discussion",
  });
  const positiveOrientationApplicable = complexStokes && /oriented upward|upper cap|upward oriented/iu.test(problemText);
  addValidationRule(evaluations, issues, options, {
    name: "missing_positive_boundary_orientation",
    domain: "upward-oriented Stokes boundary orientation",
    applicable: positiveOrientationApplicable,
    applicabilityReason: positiveOrientationApplicable
      ? "submitted Stokes problem specifies upward orientation"
      : "problem is not an upward-oriented Stokes boundary problem",
    inputFields: ["problem", "result.steps"],
    passed: /counterclockwise|positive orientation|positively oriented|viewed from above/iu.test(compact),
    failureEvidence: "solution does not state the induced positive boundary orientation",
  });
  addValidationRule(evaluations, issues, options, {
    name: "missing_green_disk_reduction",
    domain: "Stokes paraboloid/disk Green reduction",
    applicable: complexStokes,
    applicabilityReason: stokesReason,
    inputFields: ["problem", "result.steps"],
    passed: /(?:Green|\\iint_D|x\^2\s*\+\s*y\^2\s*\\le\s*9|x\^2\+y\^2\\le9)/iu.test(compact),
    failureEvidence: "solution does not reduce the boundary integral to a Green/disk-region integral",
  });

  const ellipseReason = ellipseGreenDomain
    ? "submitted Stokes/Green problem contains an ellipse/elliptic boundary"
    : "submitted problem is not a Stokes/Green ellipse-domain problem";
  addValidationRule(evaluations, issues, options, {
    name: "missing_ellipse_parameterization_x",
    domain: "Stokes/Green ellipse coordinate change",
    applicable: ellipseGreenDomain,
    applicabilityReason: ellipseReason,
    inputFields: ["problem", "result.steps"],
    passed: /(?:x\s*=\s*2r\\?cos|x=2r\\cos|2r\s*\\cos|2r\s*cos)/iu.test(compact),
    failureEvidence: "missing x=2r cos(theta) ellipse parameterization",
  });
  addValidationRule(evaluations, issues, options, {
    name: "missing_ellipse_parameterization_y",
    domain: "Stokes/Green ellipse coordinate change",
    applicable: ellipseGreenDomain,
    applicabilityReason: ellipseReason,
    inputFields: ["problem", "result.steps"],
    passed: /(?:y\s*=\s*3r\\?sin|y=3r\\sin|3r\s*\\sin|3r\s*sin)/iu.test(compact),
    failureEvidence: "missing y=3r sin(theta) ellipse parameterization",
  });
  addValidationRule(evaluations, issues, options, {
    name: "missing_ellipse_jacobian",
    domain: "Stokes/Green ellipse coordinate change",
    applicable: ellipseGreenDomain,
    applicabilityReason: ellipseReason,
    inputFields: ["problem", "result.steps"],
    passed: /(?:Jacobian|6r|6\s*r)/iu.test(compact),
    failureEvidence: "missing ellipse Jacobian 6r",
  });

  addValidationRule(evaluations, issues, options, {
    name: "coordinate_change_without_jacobian",
    domain: "multivariable integral coordinate changes",
    applicable: coordinateApplicability.applicable,
    applicabilityReason: coordinateApplicability.reason,
    inputFields: ["problem", "result.steps"],
    passed: /(?:Jacobian|6r|6\s*r|dA\s*=|\\,r\\,?d|\br\s*dr|r\\,d)/iu.test(compact),
    failureEvidence: "coordinate change appears without Jacobian/differential area factor",
  });

  finalIntegralApplicable = /\\int|∫|\\iint|∬/.test(finalAnswer) || /integral/i.test(finalAnswer);
  addValidationRule(evaluations, issues, options, {
    name: "final_integral_without_setup",
    domain: "solutions whose final answer remains an integral",
    applicable: finalIntegralApplicable,
    applicabilityReason: finalIntegralApplicable
      ? "final answer is an integral or describes an integral"
      : "final answer is not an integral",
    inputFields: ["result.finalAnswer", "result.finalAnswerLatex", "result.steps"],
    passed: mentionsIntegralSetup(compact),
    failureEvidence: "final answer is an integral but earlier steps do not set it up",
  });

  nonElementaryApplicable = hasNonPolynomialCosFraction(problemText) || /arctan\(x-y\)|\\arctan\(x-y\)/i.test(problemText);
  addValidationRule(evaluations, issues, options, {
    name: "non_elementary_integral_claimed_simplified",
    domain: "known non-elementary Stokes/vector-calculus integral patterns",
    applicable: nonElementaryApplicable,
    applicabilityReason: nonElementaryApplicable
      ? "submitted problem contains a known non-polynomial fraction/arctan pattern"
      : "submitted problem does not contain the guarded non-elementary vector-calculus pattern",
    inputFields: ["problem", "result.finalAnswer", "result.finalAnswerLatex", "result.steps"],
    passed: (/\\int|∫|\\iint|∬/.test(finalAnswer))
      || statesNonElementary(compact)
      || /(?:numeric|approx|≈|\\approx)/iu.test(finalAnswer),
    failureEvidence: "solution claims a closed-form simplification for guarded non-elementary pattern",
  });

  const perfectSquareTrinomial = parsePerfectSquareTrinomialEquation(problemText);
  perfectSquareApplicable = Boolean(perfectSquareTrinomial);
  const perfectSquareReason = perfectSquareApplicable
    ? "submitted problem is a parsed perfect-square trinomial equation"
    : "submitted problem is not a parsed perfect-square trinomial equation";
  addValidationRule(evaluations, issues, options, {
    name: "invalid_perfect_square_equality_chain",
    domain: "perfect-square trinomial equations",
    applicable: perfectSquareApplicable,
    applicabilityReason: perfectSquareReason,
    inputFields: ["problem", "result.steps"],
    passed: !hasInvalidPerfectSquareEqualityChain(solutionText, perfectSquareTrinomial),
    failureEvidence: perfectSquareTrinomial?.invalidChain || "",
  });
  addValidationRule(evaluations, issues, options, {
    name: "flattened_grouped_binomial_square",
    domain: "perfect-square trinomial equations",
    applicable: perfectSquareApplicable,
    applicabilityReason: perfectSquareReason,
    inputFields: ["problem", "result.steps"],
    passed: !hasFlattenedPerfectSquarePowerStep(solutionText, perfectSquareTrinomial),
    failureEvidence: perfectSquareTrinomial?.forbiddenFlattenedStep || "",
  });
  addValidationRule(evaluations, issues, options, {
    name: "missing_grouped_perfect_square_step",
    domain: "perfect-square trinomial equations",
    applicable: perfectSquareApplicable,
    applicabilityReason: perfectSquareReason,
    inputFields: ["problem", "result.steps"],
    passed: hasExpectedGroupedPerfectSquareStep(solutionText, perfectSquareTrinomial),
    failureEvidence: perfectSquareTrinomial?.expectedGroupedStep || "",
  });
  addValidationRule(evaluations, issues, options, {
    name: "missing_linear_perfect_square_step",
    domain: "perfect-square trinomial equations",
    applicable: perfectSquareApplicable,
    applicabilityReason: perfectSquareReason,
    inputFields: ["problem", "result.steps"],
    passed: hasExpectedLinearPerfectSquareStep(solutionText, perfectSquareTrinomial),
    failureEvidence: perfectSquareTrinomial?.expectedLinearStep || "",
  });
  addValidationRule(evaluations, issues, options, {
    name: "plus_minus_for_zero_perfect_square",
    domain: "perfect-square trinomial equations",
    applicable: perfectSquareApplicable,
    applicabilityReason: perfectSquareReason,
    inputFields: ["problem", "result.finalAnswer", "result.steps"],
    passed: !hasPlusMinusPerfectSquareZeroRoot(solutionText, perfectSquareTrinomial),
    failureEvidence: "solution uses plus-minus for a repeated zero root",
  });

  steps.forEach((step, index) => {
    const issue = validateStepHasRenderableContent(step, index, steps.length);
    if (issue) {
      addValidationRule(evaluations, issues, options, {
        name: "step_renderable_content",
        issue,
        domain: "all generated solution steps",
        applicable: true,
        applicabilityReason: "every displayed step must render content",
        inputFields: [`result.steps[${index}]`],
        global: true,
        passed: false,
        failureEvidence: `step ${index + 1}: ${issue}`,
      });
    }
  });

  if (includeQualityRules) {
    addValidationRule(evaluations, issues, options, {
      name: "generic_recognized_rule",
      domain: "all generated solutions",
      applicable: true,
      applicabilityReason: "generic local-rule fallback labels are never valid AI solution content",
      inputFields: ["result.steps", "result.summary"],
      global: true,
      passed: !/\bRecognized rule\b/i.test(compact),
      failureEvidence: "solution contains 'Recognized rule'",
    });

    addValidationRule(evaluations, issues, options, {
      name: "generic_symbolic_junk",
      domain: "all generated solutions",
      applicable: true,
      applicabilityReason: "generic symbolic junk is never valid solution content",
      inputFields: ["result.steps", "result.finalAnswer"],
      global: true,
      passed: !(/\bf\s*g\s*x\b/i.test(compact) || /\bf'g\s*\+\s*fg'\b/i.test(compact)),
      failureEvidence: "solution contains generic f g x / f'g+fg' pattern",
    });

    const uniqueMath = new Set(steps.map((step) => safeString(step.math || step.latex)).filter(Boolean));
    const repeatedStepsApplicable = steps.length > 1;
    addValidationRule(evaluations, issues, options, {
      name: "no_meaningful_transformation",
      domain: "multi-step generated solutions",
      applicable: repeatedStepsApplicable,
      applicabilityReason: repeatedStepsApplicable
        ? "solution contains multiple steps"
        : "single-step solutions are not checked for repeated transformations",
      inputFields: ["result.steps"],
      passed: uniqueMath.size > 1,
      failureEvidence: `uniqueMathCount=${uniqueMath.size}, stepCount=${steps.length}`,
    });

    const detachedRelation = findDetachedRelationLeadingFragment(result);
    addValidationRule(evaluations, issues, options, {
      name: "detached_relation_leading_fragment",
      domain: "rendered step math fragments",
      applicable: Boolean(detachedRelation),
      applicabilityReason: detachedRelation
        ? "a rendered math fragment starts with a relation operator outside an aligned derivation"
        : "no detached relation-leading math fragment was found",
      inputFields: ["result.steps[].math", "result.steps[].latex", "result.steps[].lines"],
      passed: !detachedRelation,
      failureEvidence: detachedRelation ? `step ${detachedRelation.stepIndex + 1}: ${detachedRelation.text}` : "",
    });

    const signInconsistency = findNamedSignInconsistency(result);
    addValidationRule(evaluations, issues, options, {
      name: "sign_inconsistent_named_quantity",
      domain: "named intermediate quantities",
      applicable: Boolean(signInconsistency),
      applicabilityReason: signInconsistency
        ? "solution derives a named quantity as a negative multiple of another named quantity but final answer drops the sign"
        : "no named negative-multiple relation is contradicted by the final answer",
      inputFields: ["result.finalAnswer", "result.finalAnswerLatex", "result.steps"],
      passed: !signInconsistency,
      failureEvidence: signInconsistency ? `${signInconsistency.relation}; final=${signInconsistency.finalAnswer}` : "",
    });

    const unsupportedIntegrationByParts = findUnsupportedIntegrationByPartsSetup(result);
    addValidationRule(evaluations, issues, options, {
      name: "unsupported_integration_by_parts_setup",
      domain: "integration-by-parts derivations",
      applicable: Boolean(unsupportedIntegrationByParts),
      applicabilityReason: unsupportedIntegrationByParts
        ? "solution declares integration by parts with u and dv but does not provide v or a recognized identity"
        : "no unsupported integration-by-parts declaration was found",
      inputFields: ["result.steps"],
      passed: !unsupportedIntegrationByParts,
      failureEvidence: unsupportedIntegrationByParts?.evidence || "",
    });

    const finalAnswerJump = findUnsupportedFinalAnswerJump(result);
    addValidationRule(evaluations, issues, options, {
      name: "unsupported_final_answer_jump",
      domain: "final answer derivation continuity",
      applicable: Boolean(finalAnswerJump),
      applicabilityReason: finalAnswerJump
        ? "final step introduces the final equality without a prior matching expression or bridge language"
        : "final answer is connected to earlier math or no unsupported jump was detected",
      inputFields: ["result.finalAnswer", "result.finalAnswerLatex", "result.steps"],
      passed: !finalAnswerJump,
      failureEvidence: finalAnswerJump ? `${finalAnswerJump.finalStep}; final=${finalAnswerJump.finalAnswer}` : "",
    });

    const unsupportedClaim = findUnsupportedTheoremOrSymmetryClaim(result, problemText);
    addValidationRule(evaluations, issues, options, {
      name: "unsupported_theorem_or_symmetry_claim",
      domain: "theorem and symmetry claims",
      applicable: Boolean(unsupportedClaim),
      applicabilityReason: unsupportedClaim
        ? "solution makes a theorem/symmetry claim without matching transformation or domain evidence"
        : "no unsupported theorem or symmetry claim was found",
      inputFields: ["problem", "result.steps"],
      passed: !unsupportedClaim,
      failureEvidence: unsupportedClaim?.evidence || "",
    });

    addValidationRule(evaluations, issues, options, {
      name: "wrong_simple_rule_for_curl_problem",
      domain: "Stokes/curl vector-calculus problems",
      applicable: complexStokes,
      applicabilityReason: stokesReason,
      inputFields: ["problem", "result.steps"],
      passed: !/power rule|product rule|chain rule/i.test(compact),
      failureEvidence: "solution applies a simple derivative rule to a curl/Stokes problem",
    });

    plainEquation = isPlainEquationProblem(problemText);
    addValidationRule(evaluations, issues, options, {
      name: "derivative_rule_for_plain_equation",
      domain: "plain algebraic equations",
      applicable: plainEquation,
      applicabilityReason: plainEquation
        ? "submitted problem is an equation without derivative instructions"
        : "submitted problem is not a plain algebraic equation",
      inputFields: ["problem", "result.steps", "result.finalAnswer"],
      passed: !isDerivativeOnlyRuleResponse(compact),
      failureEvidence: "solution gives only a derivative rule for a plain equation",
    });

    simplePowerEquation = parseSimpleAdditivePowerEquation(problemText);
    addValidationRule(evaluations, issues, options, {
      name: "incorrect_simple_power_equation_final",
      domain: "simple additive power equations",
      applicable: Boolean(simplePowerEquation),
      applicabilityReason: simplePowerEquation
        ? "submitted problem matches x+a^n=0"
        : "submitted problem is not a simple additive power equation",
      inputFields: ["problem", "result.finalAnswer", "result.finalAnswerLatex"],
      passed: !simplePowerEquation || finalAnswerMatchesSimplePowerEquation(finalAnswer, simplePowerEquation.expectedFinal),
      failureEvidence: simplePowerEquation ? `expected ${simplePowerEquation.expectedFinal}, got ${finalAnswer}` : "",
    });

    symmetryClaimed = /(?:odd|oscillat\w*|vanish|cancel)/iu.test(compact);
    addValidationRule(evaluations, issues, options, {
      name: "unsupported_symmetry_cancellation",
      domain: "Stokes non-polynomial cosine-fraction curl terms",
      applicable: nonPolynomialStokesFraction && symmetryClaimed,
      applicabilityReason: nonPolynomialStokesFraction
        ? (symmetryClaimed
          ? "submitted Stokes problem contains the guarded cosine fraction and solution claims cancellation"
          : "solution does not claim symmetry/oscillatory cancellation")
        : "submitted problem is not the guarded Stokes cosine-fraction domain",
      inputFields: ["problem", "result.steps"],
      passed: hasSupportedParityProof(compact),
      failureEvidence: "solution claims cancellation without a parity/symmetry transformation proof",
    });

    addValidationRule(evaluations, issues, options, {
      name: "dropped_nonpolynomial_fraction_derivative",
      domain: "Stokes non-polynomial cosine-fraction curl terms",
      applicable: nonPolynomialStokesFraction,
      applicabilityReason: nonPolynomialStokesFraction
        ? "submitted Stokes problem contains the guarded non-polynomial cosine fraction"
        : "submitted problem is not the guarded Stokes cosine-fraction domain",
      inputFields: ["problem", "result.steps"],
      passed: mentionsFractionDerivative(compact),
      failureEvidence: "solution does not show quotient/partial derivative evidence for the fraction term",
    });
  }

  return {
    issues: [...new Set(issues)],
    evaluations,
    context: createValidationContext({
      result,
      problemText,
      includeQualityRules,
      steps,
      finalAnswer,
      solutionText,
      compact,
      complexStokes,
      ellipseGreenDomain,
      nonPolynomialStokesFraction,
      coordinateApplicability,
      finalIntegralApplicable,
      nonElementaryApplicable,
      perfectSquareApplicable,
      plainEquation,
      simplePowerEquation,
      symmetryClaimed,
      phase2Diagnostics,
    }),
  };
}

export function evaluateSolutionQualityRules(result, { problem = "", includeQualityRules = true, onRuleEvaluation = null } = {}) {
  return buildSolutionRuleEvaluations(result, { problem, includeQualityRules, onRuleEvaluation });
}

export function findSolutionIntegrityIssues(result, { problem = "" } = {}) {
  return buildSolutionRuleEvaluations(result, { problem, includeQualityRules: false }).issues;
}

export function validateSolutionQuality(result, { problem = "", onRuleEvaluation = null } = {}) {
  const { issues, evaluations, context } = buildSolutionRuleEvaluations(result, {
    problem,
    includeQualityRules: true,
    onRuleEvaluation,
  });
  if (issues.length > 0) {
    const error = createInvalidSolutionError("Solution failed quality validation.", issues);
    error.solutionRuleEvaluations = evaluations;
    error.solutionValidationContext = context;
    throw error;
  }

  return true;
}
