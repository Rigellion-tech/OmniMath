import { collectGeneratedMath } from "./generatedMathCollector.js";

const GREEK_COMMANDS = new Set([
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "theta",
  "phi",
  "rho",
  "pi",
  "lambda",
  "mu",
  "sigma",
  "omega",
]);

const FUNCTION_OR_OPERATOR_COMMANDS = new Set([
  "sin",
  "cos",
  "tan",
  "sec",
  "csc",
  "cot",
  "ln",
  "log",
  "exp",
  "sqrt",
  "frac",
  "dfrac",
  "tfrac",
  "int",
  "iint",
  "iiint",
  "oint",
  "sum",
  "prod",
  "lim",
  "left",
  "right",
  "cdot",
  "times",
  "le",
  "ge",
  "lt",
  "gt",
  "approx",
  "sim",
  "to",
  "infty",
  "nabla",
  "partial",
  "quad",
  "qquad",
  "text",
  "mathrm",
]);

const STANDARD_SYMBOLS = new Set(["\\pi", "e", "i", "C", "\\infty"]);

function normalizeDifferentialNotation(value = "") {
  return String(value || "")
    .replace(/\\mathrm\s*\{\s*d\s*\}/giu, "d")
    .replace(/\\operatorname\s*\{\s*d\s*\}/giu, "d");
}

function stripTextCommands(value = "") {
  return normalizeDifferentialNotation(value).replace(/\\(?:text|mathrm)\s*\{([^{}]*)\}/g, " ");
}

function normalizeUnicodeSymbols(value = "") {
  return String(value || "")
    .replace(/π/g, "\\pi")
    .replace(/θ/g, "\\theta")
    .replace(/φ/g, "\\phi")
    .replace(/ρ/g, "\\rho")
    .replace(/δ/g, "\\delta")
    .replace(/α/g, "\\alpha")
    .replace(/β/g, "\\beta")
    .replace(/γ/g, "\\gamma")
    .replace(/λ/g, "\\lambda")
    .replace(/μ/g, "\\mu")
    .replace(/σ/g, "\\sigma")
    .replace(/ω/g, "\\omega")
    .replace(/∞/g, "\\infty");
}

function normalizeSymbolName(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const greek = text.match(/^\\?(alpha|beta|gamma|delta|epsilon|theta|phi|rho|pi|lambda|mu|sigma|omega)$/iu);
  if (greek) return `\\${greek[1].toLowerCase()}`;
  const styled = text.match(/^\\(?:mathbf|vec|hat|bar|mathcal)\s*\{?\s*([A-Za-z])\s*\}?$/u);
  if (styled) return styled[1];
  if (/^[A-Za-z]$/u.test(text)) return text;
  return text;
}

function isEscapedAt(text, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === "{" && !isEscapedAt(text, index)) depth += 1;
    else if (text[index] === "}" && !isEscapedAt(text, index)) {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function readOperatorScript(text, markerIndex) {
  let cursor = markerIndex + 1;
  while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
  if (text[cursor] === "{") {
    const end = findMatchingBrace(text, cursor);
    if (end < 0) return null;
    return {
      value: text.slice(cursor + 1, end),
      start: markerIndex,
      end: end + 1,
    };
  }
  if (text[cursor] === "\\") {
    const command = text.slice(cursor).match(/^\\[A-Za-z]+/u);
    if (!command) return null;
    return {
      value: command[0],
      start: markerIndex,
      end: cursor + command[0].length,
    };
  }
  const atom = text.slice(cursor).match(/^[^\s_^=,;]+/u);
  if (!atom) return null;
  return {
    value: atom[0],
    start: markerIndex,
    end: cursor + atom[0].length,
  };
}

function readOperatorScripts(text, cursor) {
  const scripts = {};
  let index = cursor;
  while (index < text.length) {
    while (index < text.length && /\s/u.test(text[index])) index += 1;
    const marker = text[index];
    if (marker !== "_" && marker !== "^") break;
    const script = readOperatorScript(text, index);
    if (!script) break;
    scripts[marker === "_" ? "lower" : "upper"] = script;
    index = script.end;
  }
  return { ...scripts, end: index };
}

function boundSymbolFromOperatorLower(command = "", lower = "") {
  const variable = String.raw`(\\?(?:alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)|[A-Za-z])`;
  const source = String(lower || "").trim();
  if (command === "sum" || command === "prod") {
    const match = source.match(new RegExp(String.raw`^\s*${variable}\s*=`, "iu"));
    return normalizeSymbolName(match?.[1] || "");
  }
  if (command === "lim") {
    const match = source.match(new RegExp(String.raw`^\s*${variable}\s*(?:\\to|\\rightarrow|\\longrightarrow|->)`, "iu"));
    return normalizeSymbolName(match?.[1] || "");
  }
  return "";
}

function topLevelOperatorScopeEnd(text, start) {
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && !isEscapedAt(text, index)) {
      const command = text.slice(index).match(/^\\[A-Za-z]+/u);
      if (command) {
        index += command[0].length - 1;
        continue;
      }
    }
    if (char === "{" && !isEscapedAt(text, index)) braceDepth += 1;
    else if (char === "}" && !isEscapedAt(text, index)) braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && /[;\n]/u.test(char)) {
      return index;
    }
  }
  return text.length;
}

function extractOperatorBoundSymbolProvenance(latex = "") {
  const source = normalizeDifferentialNotation(normalizeUnicodeSymbols(latex));
  const bindings = [];
  for (const match of source.matchAll(/\\(sum|prod|lim)(?![A-Za-z])/gu)) {
    const command = match[1];
    const operatorStart = match.index;
    const scripts = readOperatorScripts(source, operatorStart + match[0].length);
    if (!scripts.lower) continue;
    const symbol = boundSymbolFromOperatorLower(command, scripts.lower.value);
    if (!symbol) continue;
    bindings.push({
      command,
      symbol,
      lower: scripts.lower.value.trim(),
      upper: scripts.upper?.value?.trim() || "",
      scopeStart: operatorStart,
      scopeEnd: topLevelOperatorScopeEnd(source, operatorStart),
    });
  }
  return bindings;
}

function boundedEvidence(value = "", maximum = 160) {
  const compact = String(value || "").replace(/\s+/gu, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
}

export function extractBoundSymbolProvenance(latex = "") {
  const source = normalizeDifferentialNotation(normalizeUnicodeSymbols(latex));
  const bindings = extractOperatorBoundSymbolProvenance(source).map((binding) => ({
    ...binding,
    introductionType: `${binding.command}_index`,
    scope: "local_expression",
    persistent: false,
  }));

  const integralPattern = /\\(int|iint|iiint|oint)(?![A-Za-z])/gu;
  const differentialPattern = /(?:^|[^A-Za-z\\])d\s*(\\(?:mathbf|vec|hat|bar)\s*\{?\s*[A-Za-z]\s*\}?|\\?(?:alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)|[A-Za-z])(?![A-Za-z])/gu;
  for (const integral of source.matchAll(integralPattern)) {
    const scopeStart = integral.index ?? 0;
    const scopeLimit = topLevelOperatorScopeEnd(source, scopeStart);
    const tail = source.slice(scopeStart + integral[0].length, scopeLimit);
    const differentials = [...tail.matchAll(differentialPattern)];
    for (const differential of differentials) {
      const symbol = normalizeSymbolName(differential[1]);
      if (!symbol) continue;
      bindings.push({
        command: integral[1],
        symbol,
        lower: "",
        upper: "",
        scopeStart,
        scopeEnd: scopeStart + integral[0].length + (differential.index ?? 0) + differential[0].length,
        introductionType: "integral_variable",
        scope: "local_integral",
        persistent: false,
      });
    }
  }

  for (const differential of source.matchAll(differentialPattern)) {
    const occurrenceStart = differential.index ?? 0;
    const occurrenceEnd = occurrenceStart + differential[0].length;
    const alreadyIntegralBound = bindings.some((binding) => (
      /^(?:i?i?int|oint)$/u.test(binding.command)
      && occurrenceStart >= binding.scopeStart
      && occurrenceEnd <= binding.scopeEnd
    ));
    if (alreadyIntegralBound) continue;
    bindings.push({
      command: "differential",
      symbol: normalizeSymbolName(differential[1]),
      lower: "",
      upper: "",
      scopeStart: occurrenceStart,
      scopeEnd: occurrenceEnd,
      introductionType: "differential_variable",
      scope: "local_differential",
      persistent: false,
    });
  }

  for (const symbol of extractOrdinaryDerivativeSymbols(source)) {
    bindings.push({
      command: "derivative",
      symbol,
      lower: "",
      upper: "",
      scopeStart: 0,
      scopeEnd: source.length,
      introductionType: "derivative_variable",
      scope: "local_expression",
      persistent: false,
    });
  }

  const quantifierPattern = /\\(forall|exists)\s*(\\?(?:alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)|[A-Za-z])/gu;
  for (const match of source.matchAll(quantifierPattern)) {
    bindings.push({
      command: match[1],
      symbol: normalizeSymbolName(match[2]),
      lower: "",
      upper: "",
      scopeStart: match.index ?? 0,
      scopeEnd: topLevelOperatorScopeEnd(source, match.index ?? 0),
      introductionType: "quantified_variable",
      scope: "local_expression",
      persistent: false,
    });
  }

  const setBuilderPattern = /\\?\{\s*(\\?(?:alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)|[A-Za-z])\s*(?::|\\mid|\|)[\s\S]*?\\?\}/gu;
  for (const match of source.matchAll(setBuilderPattern)) {
    bindings.push({
      command: "set_builder",
      symbol: normalizeSymbolName(match[1]),
      lower: "",
      upper: "",
      scopeStart: match.index ?? 0,
      scopeEnd: (match.index ?? 0) + match[0].length,
      introductionType: "set_builder_variable",
      scope: "local_expression",
      persistent: false,
    });
  }

  const unique = new Map();
  for (const binding of bindings) {
    if (!binding.symbol) continue;
    const key = `${binding.command}:${binding.symbol}:${binding.scopeStart}:${binding.scopeEnd}`;
    unique.set(key, { ...binding, evidence: boundedEvidence(source.slice(binding.scopeStart, binding.scopeEnd)) });
  }
  return [...unique.values()];
}

function symbolOccurrencePattern(symbol = "") {
  if (/^\\[A-Za-z]+$/u.test(symbol)) {
    return new RegExp(`${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "gu");
  }
  if (/^[A-Za-z]$/u.test(symbol)) {
    return new RegExp(`(?<![A-Za-z])${symbol}(?![A-Za-z])`, "gu");
  }
  return null;
}

function maskScopedBoundOccurrences(source = "", bindings = []) {
  let output = String(source || "");
  for (const binding of bindings) {
    const pattern = symbolOccurrencePattern(binding.symbol);
    if (!pattern) continue;
    const start = Math.max(0, binding.scopeStart);
    const end = Math.min(output.length, binding.scopeEnd);
    const scoped = output.slice(start, end).replace(pattern, " ");
    output = `${output.slice(0, start)}${scoped}${output.slice(end)}`;
  }
  return output;
}

function collectCommandSymbols(source = "", symbols) {
  for (const match of source.matchAll(/\\([A-Za-z]+)(?:\s*\{([A-Za-z])\})?/g)) {
    const command = match[1];
    if (GREEK_COMMANDS.has(command)) {
      symbols.add(`\\${command}`);
      continue;
    }
    if (["mathbf", "vec", "hat", "bar", "mathcal"].includes(command) && match[2]) {
      symbols.add(match[2]);
    }
  }
  for (const match of source.matchAll(/\\mathcal\s+([A-Za-z])/gu)) {
    symbols.add(match[1]);
  }
}

function latexWithoutCommands(source = "") {
  return source
    .replace(/\\mathbb\s*(?:\{\s*[NZQRC]\s*\}|[NZQRC])/g, " ")
    .replace(/\\(?:mathbf|vec|hat|bar|mathcal)\s*(?:\{\s*([A-Za-z])\s*\}|([A-Za-z]))/g, "$1$2")
    .replace(/\\[A-Za-z]+/g, " ")
    .replace(/\\[,;! ]/g, " ");
}

const DERIVATIVE_SYMBOL_PATTERN = String.raw`(?:[A-Za-z]|alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)`;
const DERIVATIVE_ORDER_PATTERN = String.raw`(?:\s*\^\s*(?:\{\s*(?:\d+|[A-Za-z])\s*\}|(?:\d+|[A-Za-z])))?`;
const DERIVATIVE_VARIABLE_PATTERN = String.raw`\\?${DERIVATIVE_SYMBOL_PATTERN}`;
const ORDINARY_DERIVATIVE_FRACTION = new RegExp(
  String.raw`\\frac\s*\{\s*d${DERIVATIVE_ORDER_PATTERN}\s*${DERIVATIVE_VARIABLE_PATTERN}?\s*\}\s*\{\s*d\s*${DERIVATIVE_VARIABLE_PATTERN}${DERIVATIVE_ORDER_PATTERN}\s*\}`,
  "giu"
);
const PARTIAL_DERIVATIVE_DENOMINATOR = String.raw`(?:\\partial\s*${DERIVATIVE_VARIABLE_PATTERN}${DERIVATIVE_ORDER_PATTERN}\s*){1,4}`;
const PARTIAL_DERIVATIVE_FRACTION = new RegExp(
  String.raw`\\frac\s*\{\s*\\partial${DERIVATIVE_ORDER_PATTERN}\s*${DERIVATIVE_VARIABLE_PATTERN}?\s*\}\s*\{\s*${PARTIAL_DERIVATIVE_DENOMINATOR}\}`,
  "giu"
);
const ORDINARY_DERIVATIVE_SLASH = new RegExp(
  String.raw`(^|[^A-Za-z\\])d${DERIVATIVE_ORDER_PATTERN}\s*${DERIVATIVE_VARIABLE_PATTERN}?\s*\/\s*d\s*${DERIVATIVE_VARIABLE_PATTERN}${DERIVATIVE_ORDER_PATTERN}\b`,
  "giu"
);
const PARTIAL_DERIVATIVE_SLASH = new RegExp(
  String.raw`(^|[^A-Za-z\\])\\partial${DERIVATIVE_ORDER_PATTERN}\s*${DERIVATIVE_VARIABLE_PATTERN}?\s*\/\s*${PARTIAL_DERIVATIVE_DENOMINATOR}`,
  "giu"
);
const ORDINARY_DERIVATIVE_FRACTION_VARIABLE = new RegExp(
  String.raw`\\frac\s*\{\s*d${DERIVATIVE_ORDER_PATTERN}\s*${DERIVATIVE_VARIABLE_PATTERN}?\s*\}\s*\{\s*d\s*(${DERIVATIVE_VARIABLE_PATTERN})${DERIVATIVE_ORDER_PATTERN}\s*\}`,
  "giu"
);
const ORDINARY_DERIVATIVE_SLASH_VARIABLE = new RegExp(
  String.raw`(?:^|[^A-Za-z\\])d${DERIVATIVE_ORDER_PATTERN}\s*${DERIVATIVE_VARIABLE_PATTERN}?\s*\/\s*d\s*(${DERIVATIVE_VARIABLE_PATTERN})${DERIVATIVE_ORDER_PATTERN}\b`,
  "giu"
);
const DERIVATIVE_TEX_SPACING_PATTERN = String.raw`(?:\\(?:[,;!: ]|quad|qquad|enspace|thinspace|medspace|thickspace|negthinspace)\s*)*`;
const GROUPED_DERIVATIVE_FUNCTION = new RegExp(
  String.raw`(^|[^A-Za-z\\])d\s*${DERIVATIVE_TEX_SPACING_PATTERN}(?=(?:\\left\s*)?\(\s*\\?(?:ln|log|sin|cos|tan|sec|csc|cot|exp|sqrt)\b)`,
  "giu"
);
const GROUPED_DERIVATIVE_NAMED_FUNCTION = new RegExp(
  String.raw`(^|[^A-Za-z\\])d\s*${DERIVATIVE_TEX_SPACING_PATTERN}(?=(?:\\left\s*)?[\[(]\s*(?:\\operatorname\s*\{\s*[A-Za-z][A-Za-z0-9]*\s*\}|\\mathrm\s*\{\s*[A-Za-z][A-Za-z0-9]*\s*\}|\\(?:Gamma|zeta)\b))`,
  "giu"
);

function stripDerivativeOperators(source = "") {
  return String(source || "")
    .replace(ORDINARY_DERIVATIVE_FRACTION, " ")
    .replace(PARTIAL_DERIVATIVE_FRACTION, " ")
    .replace(ORDINARY_DERIVATIVE_SLASH, "$1 ")
    .replace(PARTIAL_DERIVATIVE_SLASH, "$1 ")
    .replace(GROUPED_DERIVATIVE_FUNCTION, "$1 ")
    .replace(GROUPED_DERIVATIVE_NAMED_FUNCTION, "$1 ")
    .replace(/\\partial\s*\/\s*\\partial\s*\\?(?:[A-Za-z]|alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)\b/giu, " ");
}

function extractOrdinaryDerivativeSymbols(latex = "") {
  const source = stripTextCommands(normalizeUnicodeSymbols(latex));
  const symbols = new Set();
  for (const pattern of [ORDINARY_DERIVATIVE_FRACTION_VARIABLE, ORDINARY_DERIVATIVE_SLASH_VARIABLE]) {
    for (const match of source.matchAll(pattern)) {
      symbols.add(normalizeSymbolName(match[1]));
    }
  }
  return symbols;
}

export function extractBoundSymbols(latex = "") {
  const normalizedSource = stripTextCommands(normalizeUnicodeSymbols(latex));
  const bound = extractOrdinaryDerivativeSymbols(normalizedSource);
  const source = stripDerivativeOperators(normalizedSource);
  for (const match of source.matchAll(/(?:^|[^A-Za-z\\])d\s*\\(?:mathbf|vec|hat|bar)\s*\{?([A-Za-z])\}?/gu)) {
    bound.add(normalizeSymbolName(match[1]));
  }
  for (const match of source.matchAll(/(?:^|[^A-Za-z\\])d\s*\\?([A-Za-z]|alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)\b/giu)) {
    bound.add(normalizeSymbolName(match[1]));
  }
  for (const match of source.matchAll(/\\partial\s*\/\s*\\partial\s*\\?([A-Za-z]|alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)\b/giu)) {
    bound.add(normalizeSymbolName(match[1]));
  }
  for (const binding of extractBoundSymbolProvenance(source)) bound.add(binding.symbol);
  return bound;
}

export function extractExplicitDefinitions(latex = "") {
  const definitions = new Set();
  const knownSymbols = new Set();
  for (const clause of splitSequentialClauses(normalizeUnicodeSymbols(latex))) {
    const localBindings = extractBoundSymbolProvenance(clause.value);
    const records = introductionRecordsForClause(clause.value, {
      knownSymbols,
      localSymbols: new Set(localBindings.map((binding) => binding.symbol)),
      localBindings,
      field: { rawValue: clause.value },
      allowPersistent: true,
    });
    for (const record of records) {
      if (!record.persistent) continue;
      definitions.add(record.symbol);
      knownSymbols.add(record.symbol);
    }
  }
  return definitions;
}

const POLYLOGARITHM_DEFINITION_PATTERN = /\\(?:operatorname|mathrm)\s*\{\s*Li\s*\}\s*_\s*(?:\{\s*[\w+-]+\s*\}|[\w+-]+)\s*(?:\\left\s*)?\(\s*([A-Za-z](?:\s*,\s*[A-Za-z])*)\s*(?:\\right\s*)?\)\s*(:=|=)/giu;
const POLYLOGARITHM_USAGE_PATTERN = /\\operatorname\s*\{\s*Li\s*\}|\\mathrm\s*\{\s*Li\s*\}|\\Li\b|\bLi_\s*\{?[\w+-]+\}?/iu;

function extractNamedSpecialFunctionDefinitionRecords(latex = "") {
  const source = String(latex || "");
  const records = [];
  for (const match of source.matchAll(POLYLOGARITHM_DEFINITION_PATTERN)) {
    const rhsStart = (match.index ?? 0) + match[0].length;
    const rhs = source.slice(rhsStart).split(/\\\\|[;\n]/u, 1)[0];
    records.push({
      specialFunction: "polylogarithm",
      parameters: match[1].split(",").map((parameter) => normalizeSymbolName(parameter)),
      assignment: match[2],
      definitionStart: match.index ?? 0,
      rhs,
    });
  }
  return records;
}

export function extractLeadingSpecialFunctionDefinitions(latex = "") {
  const source = String(latex || "");
  const definitions = new Set();
  for (const record of extractNamedSpecialFunctionDefinitionRecords(source)) {
    if (record.specialFunction !== "polylogarithm" || record.assignment !== ":=") continue;
    if (!/(?:\\sum|∑|\\int|∫)/u.test(record.rhs)) continue;
    if (POLYLOGARITHM_USAGE_PATTERN.test(source.slice(0, record.definitionStart))) continue;
    definitions.add(record.specialFunction);
  }
  return definitions;
}

function isUnarySubstitutionExpression(value = "", symbol = "") {
  const escapedSymbol = String(symbol || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escapedSymbol) return false;
  const functionPattern = String.raw`\\?(?:arcsin|arccos|arctan|sin|cos|tan|sec|csc|cot|ln|log|exp|sqrt)`;
  const argumentPattern = String.raw`(?:\{\s*${escapedSymbol}\s*\}|\(\s*${escapedSymbol}\s*\)|\s+${escapedSymbol}|${escapedSymbol})`;
  return new RegExp(String.raw`^\s*${functionPattern}\s*${argumentPattern}\s*$`, "iu").test(value);
}

function unionSets(...sets) {
  const result = new Set();
  for (const set of sets) {
    for (const item of set || []) result.add(item);
  }
  return result;
}

const FULL_STEP_MATH_SOURCE_TYPES = new Set(["math", "latex", "equationLatex"]);
const PRESENTATION_FRAGMENT_SOURCE_TYPES = new Set([
  "label",
  "title",
  "heading",
  "summary",
  "reasoning",
  "plainExplanation",
  "lines[].latex",
  "lines[].math",
  "lines[].equationLatex",
]);

function compactForContainment(value = "") {
  return String(value || "").replace(/\s+/g, "");
}

function canInheritBoundSymbolFromStepMath(fieldReport = {}, contextReport = {}, symbol = "") {
  if (!PRESENTATION_FRAGMENT_SOURCE_TYPES.has(fieldReport.sourceType)) return false;
  if (!FULL_STEP_MATH_SOURCE_TYPES.has(contextReport.sourceType)) return false;
  if (fieldReport.stepIndex === null || fieldReport.stepIndex !== contextReport.stepIndex) return false;
  if (contextReport.unexplainedSymbols.includes(symbol)) return false;
  if (!contextReport.symbols.some((item) => item.symbol === symbol && item.classification === "bound_locally")) {
    return false;
  }
  const fieldValue = compactForContainment(fieldReport.value);
  const contextValue = compactForContainment(contextReport.value);
  return Boolean(fieldValue && contextValue.includes(fieldValue));
}

function applyStepMathBoundContext(fieldReports = []) {
  const fullStepMathReports = fieldReports.filter((field) => FULL_STEP_MATH_SOURCE_TYPES.has(field.sourceType));
  for (const fieldReport of fieldReports) {
    if (!PRESENTATION_FRAGMENT_SOURCE_TYPES.has(fieldReport.sourceType)) continue;
    const unexplainedSymbols = new Set(fieldReport.unexplainedSymbols);
    if (unexplainedSymbols.size === 0) continue;
    for (const symbol of [...unexplainedSymbols]) {
      const context = fullStepMathReports.find((candidate) => (
        canInheritBoundSymbolFromStepMath(fieldReport, candidate, symbol)
      ));
      if (!context) continue;
      unexplainedSymbols.delete(symbol);
      fieldReport.symbols = fieldReport.symbols.map((item) => (
        item.symbol === symbol && item.classification === "unexplained"
          ? {
              ...item,
              classification: "bound_by_step_math_context",
              provenanceCategory: "bound_local",
              reason: "presentation fragment inherits a local binding from the containing step math",
              local: true,
              contextFieldPath: context.fieldPath,
            }
          : item
      ));
    }
    fieldReport.unexplainedSymbols = [...unexplainedSymbols];
  }
}

function applyStepMathIntroductionContext(fieldReports = []) {
  const fullStepMathReports = fieldReports.filter((field) => FULL_STEP_MATH_SOURCE_TYPES.has(field.sourceType));
  for (const fieldReport of fieldReports) {
    if (!PRESENTATION_FRAGMENT_SOURCE_TYPES.has(fieldReport.sourceType)) continue;
    const unexplainedSymbols = new Set(fieldReport.unexplainedSymbols);
    for (const symbol of [...unexplainedSymbols]) {
      const context = fullStepMathReports.find((candidate) => (
        candidate.stepIndex === fieldReport.stepIndex
        && candidate.introductions?.some((record) => record.symbol === symbol && record.persistent)
      ));
      if (!context) continue;
      const introduction = context.introductions.find((record) => record.symbol === symbol && record.persistent);
      unexplainedSymbols.delete(symbol);
      fieldReport.symbols = fieldReport.symbols.map((item) => (
        item.symbol === symbol && item.provenanceCategory === "undefined_free_symbol"
          ? {
              ...item,
              classification: "introduced_by_step_math_context",
              provenanceCategory: introduction.category,
              reason: "presentation label refers to a symbol introduced by this step's full math",
              introducedAt: introduction,
              scope: introduction.scope,
              contextFieldPath: context.fieldPath,
            }
          : item
      ));
    }
    fieldReport.unexplainedSymbols = [...unexplainedSymbols];
  }
}

function applyStepNamedConstantContext(fieldReports = []) {
  const namedConstants = fieldReports.flatMap((field) => (
    PRESENTATION_FRAGMENT_SOURCE_TYPES.has(field.sourceType)
      ? (field.introductions || [])
        .filter((record) => record.category === "constant_definition")
        .map((record) => ({ ...record, contextFieldPath: field.fieldPath }))
      : []
  ));
  for (const fieldReport of fieldReports) {
    const unexplainedSymbols = new Set(fieldReport.unexplainedSymbols);
    for (const symbol of [...unexplainedSymbols]) {
      const introduction = namedConstants.find((record) => (
        record.symbol === symbol && record.stepIndex === fieldReport.stepIndex
      ));
      if (!introduction) continue;
      unexplainedSymbols.delete(symbol);
      fieldReport.symbols = fieldReport.symbols.map((item) => (
        item.symbol === symbol && item.provenanceCategory === "undefined_free_symbol"
          ? {
              ...item,
              classification: "explicitly_introduced",
              provenanceCategory: "constant_definition",
              reason: "the same step explicitly names this constant in presentation prose",
              introducedAt: introduction,
              scope: "persistent",
              contextFieldPath: introduction.contextFieldPath,
            }
          : item
      ));
    }
    fieldReport.unexplainedSymbols = [...unexplainedSymbols];
  }
}

export function extractSymbolInventory(latex = "") {
  const source = stripDerivativeOperators(stripTextCommands(normalizeUnicodeSymbols(latex)));
  const sourceWithoutDifferentials = source
    .replace(/(^|[^A-Za-z\\])d\s*\\(?:mathbf|vec|hat|bar)\s*\{?[A-Za-z]\}?/gu, "$1 ")
    .replace(/(^|[^A-Za-z\\])d\s*\\?(?:[A-Za-z]|alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)\b/giu, "$1 ");
  const symbols = new Set();
  collectCommandSymbols(source, symbols);

  const commandless = latexWithoutCommands(sourceWithoutDifferentials)
    .replace(/\b(?:sin|cos|tan|sec|csc|cot|ln|log|exp|sqrt|frac|int|sum|lim)\b/giu, " ")
    .replace(/\b(?:dx|dy|dz|dt|du|dv|dw|dr|dV|dA|dS)\b/gu, " ");
  for (const match of commandless.matchAll(/(?<![A-Za-z])([A-Za-z])(?![A-Za-z])/gu)) {
    symbols.add(normalizeSymbolName(match[1]));
  }
  for (const symbol of extractBoundSymbols(source)) symbols.add(symbol);
  return symbols;
}

function extractFreeSymbolInventory(latex = "") {
  const source = stripDerivativeOperators(stripTextCommands(normalizeUnicodeSymbols(latex)));
  return extractSymbolInventory(maskScopedBoundOccurrences(source, extractBoundSymbolProvenance(source)));
}

function isContextualStandardSymbol(symbol = "", fieldValue = "") {
  if (!["P", "Q", "R"].includes(symbol)) return false;
  return /(?:\\nabla\s*\\times|curl|\\langle[\s\S]*(?:P|Q|R)_[xyz][\s\S]*\\rangle)/u.test(fieldValue);
}

function isIndexedSymbolOccurrence(symbol = "", fieldValue = "") {
  if (!/^[A-Za-z]$/u.test(symbol)) return false;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z])${escaped}\\s*_\\s*(?:\\{|[A-Za-z0-9]|\\\\[A-Za-z]+)`, "u")
    .test(fieldValue);
}

function isStandardSymbolInField(symbol = "", fieldValue = "") {
  if (!STANDARD_SYMBOLS.has(symbol)) return false;
  if (symbol === "C" && isIndexedSymbolOccurrence(symbol, fieldValue)) return false;
  return true;
}

const SYMBOL_BASE_PATTERN = String.raw`(?:\\?(?:alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega|Gamma)|\\(?:mathbf|vec|hat|bar|mathcal)\s*\{?\s*[A-Za-z]\s*\}?|[A-Za-z])`;
const SYMBOL_ATOM_PATTERN = String.raw`${SYMBOL_BASE_PATTERN}(?:\s*_\s*(?:\{[^{}]+\}|\\[A-Za-z]+|[A-Za-z0-9]))?(?:\s*')*`;

function normalizeSymbolToken(value = "") {
  const withoutDecoration = String(value || "")
    .trim()
    .replace(/(?:\s*')+$/gu, "")
    .replace(/\s*_\s*(?:\{[^{}]+\}|\\[A-Za-z]+|[A-Za-z0-9])\s*$/gu, "")
    .trim();
  return normalizeSymbolName(withoutDecoration);
}

function parseAtomicSymbolList(value = "") {
  const source = String(value || "").trim();
  if (!source) return [];
  const parts = source.split(/\s*,\s*/u);
  const atom = new RegExp(String.raw`^\s*(${SYMBOL_ATOM_PATTERN})\s*$`, "iu");
  const symbols = [];
  for (const part of parts) {
    const match = part.match(atom);
    if (!match) return [];
    const symbol = normalizeSymbolToken(match[1]);
    if (symbol) symbols.push(symbol);
  }
  return [...new Set(symbols)];
}

function splitSequentialClauses(value = "") {
  const source = normalizeUnicodeSymbols(value)
    .replace(/\\(?:begin|end)\s*\{[^{}]*\}/gu, " ")
    .replace(/\\(?:quad|qquad)\b/gu, " ")
    .replace(/&/gu, " ");
  const clauses = [];
  let start = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  const push = (end, nextStart = end + 1) => {
    const raw = source.slice(start, end);
    const leading = raw.search(/\S/u);
    if (leading >= 0) {
      const text = raw.trim();
      if (text) clauses.push({ value: text, start: start + leading, end });
    }
    start = nextStart;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{" && !isEscapedAt(source, index)) braceDepth += 1;
    else if (char === "}" && !isEscapedAt(source, index)) braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (braceDepth || parenDepth || bracketDepth) continue;

    if (char === ";" || char === "\n") {
      push(index);
      continue;
    }
    if (char === "\\" && source[index + 1] === "\\") {
      push(index);
      index += 1;
      start = index + 1;
      continue;
    }
    if (char === ",") {
      if (isEscapedAt(source, index)) continue;
      const tail = source.slice(index + 1);
      const current = source.slice(start, index);
      if (
        (topLevelAssignmentParts(current) || mathematicalDeclarationRecords(current).length > 0)
        && topLevelAssignmentParts(tail)
      ) push(index);
      continue;
    }
    if (source.startsWith(" and ", index)) {
      const tailStart = index + 5;
      if (
        topLevelAssignmentParts(source.slice(start, index))
        && topLevelAssignmentParts(source.slice(tailStart))
      ) {
        push(index, tailStart);
        index = tailStart - 1;
      }
    }
  }
  const remainder = source.slice(start);
  const leading = remainder.search(/\S/u);
  if (leading >= 0) clauses.push({ value: remainder.trim(), start: start + leading, end: source.length });
  return clauses;
}

function topLevelAssignmentParts(value = "") {
  const source = String(value || "");
  const parts = [];
  const operators = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if ("{([".includes(char)) depth += 1;
    else if ("})]".includes(char)) depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;

    let operator = "";
    if (source.startsWith("\\coloneqq", index)) operator = "\\coloneqq";
    else if (source.startsWith("\\equiv", index)) operator = "\\equiv";
    else if (source.startsWith(":=", index)) operator = ":=";
    else if (char === "=" && source[index - 1] !== ":" && !/[=<>!]/u.test(source[index + 1] || "")) operator = "=";
    if (!operator) continue;
    parts.push(source.slice(start, index).trim());
    operators.push(operator);
    index += operator.length - 1;
    start = index + 1;
  }
  if (operators.length === 0) return null;
  parts.push(source.slice(start).trim());
  if (parts.some((part) => !part)) return null;
  return { parts, operators };
}

function definitionCue(value = "") {
  const text = String(value || "");
  const definitional = /\b(?:define|defined|definition|denote|denotes|let|set|put|take|choose|fix|parameter|constant|root)\b/iu.test(text);
  const substitution = /\b(?:substitut(?:e|ion|ing)?|change\s+(?:of\s+)?var(?:iable)?s?|transform)\b/iu.test(text);
  return { definitional, substitution, any: definitional || substitution };
}

function stepProseContext(result = {}, stepIndex = null) {
  if (!Number.isInteger(stepIndex)) return "";
  const step = result?.steps?.[stepIndex] || {};
  return ["label", "title", "heading", "summary", "reasoning", "plainExplanation"]
    .map((key) => typeof step[key] === "string" ? step[key] : "")
    .filter(Boolean)
    .join(" ");
}

function parseFunctionLeft(value = "") {
  const source = String(value || "").trim();
  const simple = source.match(new RegExp(
    String.raw`^\s*(${SYMBOL_BASE_PATTERN})\s*(?:\\left\s*)?\(\s*([\s\S]*?)\s*(?:\\right\s*)?\)\s*$`,
    "iu"
  ));
  const named = source.match(/^\s*\\(?:operatorname|mathrm)\s*\{[^{}]+\}\s*(?:_\s*(?:\{[^{}]+\}|[^\s(]+))?\s*(?:\\left\s*)?\(\s*([\s\S]*?)\s*(?:\\right\s*)?\)\s*$/iu);
  const parameters = parseAtomicSymbolList(simple?.[2] || named?.[1] || "");
  if ((!simple && !named) || parameters.length === 0) return null;
  return {
    functionSymbol: simple ? normalizeSymbolToken(simple[1]) : "",
    parameters,
  };
}

function hasFreeOccurrenceOutsideBindings(value = "", symbol = "", bindings = []) {
  const pattern = symbolOccurrencePattern(symbol);
  if (!pattern) return true;
  const occurrences = [...String(value || "").matchAll(pattern)];
  if (occurrences.length === 0) return false;
  return occurrences.some((occurrence) => {
    const index = occurrence.index ?? -1;
    return !bindings.some((binding) => (
      binding.symbol === symbol && index >= binding.scopeStart && index < binding.scopeEnd
    ));
  });
}

function persistentKnown(symbol = "", knownSymbols = new Set(), fieldValue = "") {
  return knownSymbols.has(symbol)
    || isStandardSymbolInField(symbol, fieldValue)
    || FUNCTION_OR_OPERATOR_COMMANDS.has(symbol.replace(/^\\/u, ""))
    || isContextualStandardSymbol(symbol, fieldValue);
}

function countSymbolOccurrences(value = "", symbol = "") {
  const pattern = symbolOccurrencePattern(symbol);
  return pattern ? [...String(value || "").matchAll(pattern)].length : 0;
}

function isClearSubstitutionTransform(expression = "", symbol = "") {
  if (!symbol) return false;
  if (isUnarySubstitutionExpression(expression, symbol)) return true;
  const compact = String(expression || "").replace(/\s+/gu, "");
  const occurrences = countSymbolOccurrences(compact, symbol);
  const rationalTransform = occurrences >= 2 && /(?:\\frac|\/)/u.test(compact);
  const exponentialTransform = new RegExp(
    String.raw`(?:e|\\exp)\s*(?:\^|\().*${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "u"
  ).test(compact);
  return rationalTransform || exponentialTransform;
}

function contextNamesSubstitutionSymbol(value = "", symbol = "") {
  const escaped = String(symbol || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  const cue = String.raw`(?:substitut(?:e|ion|ing)?|change\s+(?:of\s+)?var(?:iable)?s?|set|put)`;
  return new RegExp(String.raw`(?:${cue}[\s\S]{0,48}${escaped}|${escaped}[\s\S]{0,48}${cue})`, "iu")
    .test(normalizeUnicodeSymbols(value));
}

function declarationRecordsFromContext(field = {}, clause = "") {
  const raw = normalizeUnicodeSymbols(field.rawValue || clause)
    .replace(/\\[()[\]]|\$/gu, " ")
    .replace(/\\(?:quad|qquad|,|;|!| )/gu, " ");
  const records = [];
  const addList = (value, introductionType, category = "declared_parameter") => {
    for (const symbol of parseAtomicSymbolList(value)) {
      records.push({ symbol, category, introductionType, scope: "persistent", persistent: true });
    }
  };
  const list = String.raw`(${SYMBOL_ATOM_PATTERN}(?:\s*,\s*${SYMBOL_ATOM_PATTERN})*)`;
  const declarationPatterns = [
    { pattern: new RegExp(String.raw`\b(?:let|take|choose|fix)\s+${list}\s*(?=(?:\\in\b|in\b|[<>]=?|\\(?:leq?|geq?|lt|gt)\b|be\b))`, "giu"), type: "prose_parameter_declaration" },
    { pattern: new RegExp(String.raw`\bfor\s+${list}\s*(?=(?:\\in\b|in\b|[<>]=?|\\(?:leq?|geq?|lt|gt)\b))`, "giu"), type: "prose_parameter_declaration" },
    { pattern: new RegExp(String.raw`\bwhere\s+${list}\s+(?:is|are|denotes?)\s+(?:[A-Za-z][A-Za-z' -]{0,60}\s+)?(?:constant|parameter|root)s?\b`, "giu"), type: "prose_named_declaration" },
    { pattern: new RegExp(String.raw`\b(?:[A-Za-z][A-Za-z' -]{0,60}\s+)?constant\s+${list}(?![A-Za-z])`, "giu"), type: "prose_named_constant" },
    { pattern: new RegExp(String.raw`${list}\s+\\text\s*\{\s*denotes?\b`, "giu"), type: "designation", category: "explicitly_defined" },
  ];
  for (const { pattern, type, category } of declarationPatterns) {
    for (const match of raw.matchAll(pattern)) {
      const isConstant = /constant/iu.test(match[0]);
      addList(match[1], type, category || (isConstant ? "constant_definition" : "declared_parameter"));
    }
  }
  if (field.extractionReason === "prose_parameter_declaration") {
    addList(clause, "prose_parameter_declaration");
  }
  return records;
}

function mathematicalDeclarationRecords(clause = "") {
  const source = stripTextCommands(normalizeUnicodeSymbols(clause))
    .replace(/\\(?:quad|qquad|,|;|!| )/gu, " ");
  const records = [];
  const add = (value, introductionType = "parameter_domain") => {
    for (const symbol of parseAtomicSymbolList(value)) {
      records.push({ symbol, category: "declared_parameter", introductionType, scope: "persistent", persistent: true });
    }
  };
  const list = String.raw`(${SYMBOL_ATOM_PATTERN}(?:\s*,\s*${SYMBOL_ATOM_PATTERN})*)`;
  const comparison = String.raw`(?:<=|>=|<|>|\\(?:leq?|geq?|lt|gt))`;
  const boundary = String.raw`(?:[+-]?\s*\d+(?:\.\d+)?|[+-]?\s*\\(?:pi|infty))`;
  const membership = new RegExp(String.raw`(?<![A-Za-z\\])${list}\s*\\in\s*\\mathbb\s*(?:\{\s*[NZQRC]\s*\}|[NZQRC])`, "giu");
  const comparisonDeclaration = new RegExp(String.raw`(?<![A-Za-z\\])${list}\s*${comparison}\s*${boundary}(?![A-Za-z])`, "giu");
  const chained = new RegExp(String.raw`${boundary}\s*${comparison}\s*(${SYMBOL_ATOM_PATTERN})\s*${comparison}\s*${boundary}(?![A-Za-z])`, "giu");
  for (const match of source.matchAll(membership)) add(match[1], "number_set_parameter");
  for (const match of source.matchAll(comparisonDeclaration)) add(match[1]);
  for (const match of source.matchAll(chained)) add(match[1]);
  return records;
}

function introductionRecordsForClause(clause = "", {
  knownSymbols = new Set(),
  localSymbols = new Set(),
  localBindings = [],
  field = {},
  context = "",
  allowPersistent = true,
} = {}) {
  const definitionClause = String(clause || "").replace(/^\s*\\text\s*\{\s*(?:let|set|take|define)\s*\}\s*/iu, "");
  const records = [];
  const cue = definitionCue(`${context} ${field.rawValue || ""}`);
  const add = (symbol, category, introductionType, persistent = true, scope = "persistent") => {
    if (!symbol || (!allowPersistent && persistent)) return;
    records.push({ symbol, category, introductionType, persistent, scope });
  };
  if (allowPersistent) {
    for (const record of declarationRecordsFromContext(field, clause)) add(
      record.symbol,
      record.category,
      record.introductionType,
      true
    );
    for (const record of mathematicalDeclarationRecords(clause)) {
      if (
        localSymbols.has(record.symbol)
        && !hasFreeOccurrenceOutsideBindings(clause, record.symbol, localBindings)
      ) continue;
      add(record.symbol, record.category, record.introductionType, true);
    }
  }

  const mapDefinition = definitionClause.match(new RegExp(
    String.raw`^\s*(${SYMBOL_ATOM_PATTERN})\s*:\s*(${SYMBOL_ATOM_PATTERN})\s*\\mapsto\s*([\s\S]+)$`,
    "iu"
  ));
  if (mapDefinition) {
    add(normalizeSymbolToken(mapDefinition[1]), "explicitly_defined", "function_map_definition");
    add(normalizeSymbolToken(mapDefinition[2]), "function_parameter", "function_parameter", false, "local_function_definition");
  }

  const labelledDefinitionPattern = new RegExp(
    String.raw`(?:^|,)\s*(${SYMBOL_ATOM_PATTERN})\s*:(?!=)\s*([^;,\n]+)`,
    "giu"
  );
  for (const labelledDefinition of definitionClause.matchAll(labelledDefinitionPattern)) {
    const symbol = normalizeSymbolToken(labelledDefinition[1]);
    const rhsSymbols = extractFreeSymbolInventory(labelledDefinition[2]);
    const unknownRhs = [...rhsSymbols].filter((candidate) => (
      candidate !== symbol
      && !localSymbols.has(candidate)
      && !persistentKnown(candidate, knownSymbols, field.rawValue || clause)
    ));
    if (unknownRhs.length === 0) {
      add(symbol, "explicitly_defined", "labelled_domain_definition");
    }
  }

  const assignment = topLevelAssignmentParts(definitionClause);
  if (assignment) {
    for (let index = 0; index < assignment.operators.length; index += 1) {
      const left = assignment.parts[index];
      const right = assignment.parts[index + 1];
      const operator = assignment.operators[index];
      const leftFunction = parseFunctionLeft(left);
      const definitionOperator = operator === ":=" || operator === "\\coloneqq";
      const equivalenceDefinition = operator === "\\equiv" && cue.any;

      if (leftFunction && (definitionOperator || equivalenceDefinition || cue.definitional || (
        leftFunction.functionSymbol && !knownSymbols.has(leftFunction.functionSymbol)
      ))) {
        if (leftFunction.functionSymbol) {
          add(leftFunction.functionSymbol, "explicitly_defined", "function_definition");
        }
        for (const parameter of leftFunction.parameters) {
          add(parameter, "function_parameter", "function_parameter", false, "local_function_definition");
        }
        continue;
      }

      const leftSymbols = parseAtomicSymbolList(left);
      const rightSymbols = parseAtomicSymbolList(right);
      if (leftSymbols.length > 0 && (operator !== "\\equiv" || equivalenceDefinition)) {
        for (const symbol of leftSymbols) {
          if (knownSymbols.has(symbol) && !definitionOperator && !equivalenceDefinition) continue;
          const substitution = cue.substitution;
          const category = symbol === "C"
            ? "constant_definition"
            : substitution ? "substitution_variable" : "explicitly_defined";
          add(symbol, category, substitution ? "direct_substitution" : definitionOperator ? "definition_operator" : "direct_assignment");
        }
      }

      const accepted = unionSets(knownSymbols, localSymbols, new Set(records.map((record) => record.symbol)));
      if (operator === "=" && leftSymbols.length === 0 && rightSymbols.length === 1) {
        const leftFree = extractFreeSymbolInventory(left);
        const unknownLeft = [...leftFree].filter((symbol) => !persistentKnown(symbol, accepted, left));
        if (unknownLeft.length === 0 && !knownSymbols.has(rightSymbols[0])) {
          add(rightSymbols[0], "substitution_variable", "reverse_assignment");
        }
      }

      if (operator === "=" && leftSymbols.length === 1 && knownSymbols.has(leftSymbols[0])) {
        const rightFree = extractFreeSymbolInventory(right);
        const unknownRight = [...rightFree].filter((symbol) => !persistentKnown(symbol, accepted, right));
        const contextualSubstitution = unknownRight.length === 1
          && cue.substitution
          && contextNamesSubstitutionSymbol(`${context} ${field.rawValue || ""}`, unknownRight[0]);
        if (
          unknownRight.length === 1
          && (contextualSubstitution || isClearSubstitutionTransform(right, unknownRight[0]))
        ) {
          add(unknownRight[0], "substitution_variable", contextualSubstitution ? "contextual_change_of_variable" : "structural_change_of_variable");
        }
      }
    }
  }

  const unique = new Map();
  for (const record of records) {
    const key = `${record.symbol}:${record.category}:${record.scope}`;
    if (!unique.has(key)) unique.set(key, record);
  }
  return [...unique.values()];
}

function proseDeclarationFields(result = {}, existingFields = []) {
  const existingPaths = new Set(existingFields.map((field) => field.fieldPath.replace(/#math\[\d+\]$/u, "")));
  const fields = [];
  const atomList = String.raw`(${SYMBOL_ATOM_PATTERN}(?:\s*,\s*${SYMBOL_ATOM_PATTERN})*)`;
  const patterns = [
    new RegExp(String.raw`\b(?:let|take|choose|fix)\s+${atomList}\s*(?=(?:\\in\b|in\b|[<>]=?|\\(?:leq?|geq?|lt|gt)\b|be\b))`, "giu"),
    new RegExp(String.raw`\bfor\s+${atomList}\s*(?=(?:\\in\b|in\b|[<>]=?|\\(?:leq?|geq?|lt|gt)\b))`, "giu"),
    new RegExp(String.raw`\bwhere\s+${atomList}\s+(?:is|are|denotes?)\s+(?:[A-Za-z][A-Za-z' -]{0,60}\s+)?(?:constant|parameter|root)s?\b`, "giu"),
  ];
  for (const [stepIndex, step] of (Array.isArray(result?.steps) ? result.steps : []).entries()) {
    for (const sourceType of ["label", "title", "heading", "summary", "reasoning", "plainExplanation"]) {
      const rawValue = typeof step?.[sourceType] === "string" ? step[sourceType] : "";
      const basePath = `steps[${stepIndex}].${sourceType}`;
      if (!rawValue || existingPaths.has(basePath)) continue;
      let fragmentIndex = 0;
      for (const pattern of patterns) {
        const declarationSource = normalizeUnicodeSymbols(rawValue).replace(/\\[()[\]]|\$/gu, " ");
        for (const match of declarationSource.matchAll(pattern)) {
          fields.push({
            fieldPath: `${basePath}#declaration[${fragmentIndex}]`,
            value: match[1],
            normalized: match[1],
            rawValue,
            sourceType,
            stepIndex,
            lineIndex: null,
            anchorIndex: null,
            finalAnswer: false,
            fragmentIndex,
            fragmentStart: match.index ?? null,
            fragmentEnd: (match.index ?? 0) + match[0].length,
            extractionReason: "prose_parameter_declaration",
          });
          fragmentIndex += 1;
        }
      }
    }
  }
  return fields;
}

function semanticFieldPriority(field = {}) {
  const priorities = {
    label: 0,
    title: 1,
    heading: 2,
    math: 3,
    latex: 3,
    equationLatex: 3,
    "lines[].latex": 4,
    "lines[].math": 4,
    "lines[].equationLatex": 4,
    summary: 5,
    reasoning: 6,
    plainExplanation: 7,
    "anchors[].latex": 8,
    "anchors[].targetLatex": 8,
    "anchors[].math": 8,
    finalAnswer: 9,
  };
  return priorities[field.sourceType] ?? 8;
}

function legacyClassification(category = "") {
  if (category === "original_problem_symbol") return "present_in_original_problem";
  if (category === "standard_symbol") return "standard_constant_or_operator";
  if (category === "bound_local" || category === "function_parameter") return "bound_locally";
  if (["explicitly_defined", "substitution_variable", "declared_parameter", "constant_definition"].includes(category)) {
    return "explicitly_introduced";
  }
  return "unexplained";
}

export function analyzeSymbolOrigins(problem = "", result = {}) {
  const originalSymbols = extractSymbolInventory(problem);
  const collectedFields = collectGeneratedMath(result);
  const fields = [...collectedFields, ...proseDeclarationFields(result, collectedFields)];
  const knownSymbols = new Set(originalSymbols);
  const allExplicitDefinitions = new Set();
  const generatedSymbols = new Set();
  const fieldReportByPath = new Map();
  const persistentIntroductions = new Map();
  const firstSeen = new Map();
  const stepState = new Map();
  const orderedFields = [...fields].sort((left, right) => {
    const leftStep = Number.isInteger(left.stepIndex) ? left.stepIndex : Number.MAX_SAFE_INTEGER;
    const rightStep = Number.isInteger(right.stepIndex) ? right.stepIndex : Number.MAX_SAFE_INTEGER;
    if (leftStep !== rightStep) return leftStep - rightStep;
    const priority = semanticFieldPriority(left) - semanticFieldPriority(right);
    if (priority !== 0) return priority;
    return fields.indexOf(left) - fields.indexOf(right);
  });

  for (const field of orderedFields) {
    const stepKey = Number.isInteger(field.stepIndex) ? field.stepIndex : "final_answer";
    if (!stepState.has(stepKey)) {
      stepState.set(stepKey, {
        stepIndex: field.stepIndex,
        knownBeforeStep: [...knownSymbols].sort(),
        introduced: new Map(),
        fieldPaths: [],
      });
    }
    const state = stepState.get(stepKey);
    state.fieldPaths.push(field.fieldPath);
    const context = stepProseContext(result, field.stepIndex);
    const clauses = splitSequentialClauses(field.value);
    const fieldItems = new Map();
    const fieldBindings = [];
    const fieldIntroductions = [];
    const fieldKnownBefore = [...knownSymbols].sort();

    for (const [clauseIndex, clause] of clauses.entries()) {
      let clauseBindings = extractBoundSymbolProvenance(clause.value).map((binding) => ({
        ...binding,
        scopeStart: binding.scopeStart + clause.start,
        scopeEnd: binding.scopeEnd + clause.start,
        clauseIndex,
      }));
      const bindingSymbols = new Set(clauseBindings.map((binding) => binding.symbol));
      const introductions = introductionRecordsForClause(clause.value, {
        knownSymbols,
        localSymbols: bindingSymbols,
        localBindings: clauseBindings.map((binding) => ({
          ...binding,
          scopeStart: binding.scopeStart - clause.start,
          scopeEnd: binding.scopeEnd - clause.start,
        })),
        field,
        context,
        allowPersistent: !field.finalAnswer,
      }).map((record) => ({
        ...record,
        fieldPath: field.fieldPath,
        sourceType: field.sourceType,
        stepIndex: field.stepIndex,
        clauseIndex,
        position: clause.start,
        evidence: boundedEvidence(clause.value),
      }));
      const functionBindings = introductions
        .filter((record) => !record.persistent)
        .map((record) => ({
          command: "function_definition",
          symbol: record.symbol,
          lower: "",
          upper: "",
          scopeStart: clause.start,
          scopeEnd: clause.end,
          introductionType: record.introductionType,
          scope: record.scope,
          persistent: false,
          clauseIndex,
          evidence: boundedEvidence(clause.value),
        }));
      clauseBindings = [...clauseBindings, ...functionBindings];
      fieldBindings.push(...clauseBindings);
      fieldIntroductions.push(...introductions.filter((record) => record.persistent));

      const localSymbols = new Set(clauseBindings.map((binding) => binding.symbol));
      const clauseRelativeBindings = clauseBindings.map((binding) => ({
        ...binding,
        scopeStart: binding.scopeStart - clause.start,
        scopeEnd: binding.scopeEnd - clause.start,
      }));
      const clauseSymbols = unionSets(
        extractSymbolInventory(clause.value),
        new Set(clauseBindings.map((binding) => binding.symbol))
      );
      const currentIntroductions = new Map(introductions.map((record) => [record.symbol, record]));

      for (const symbol of clauseSymbols) {
        generatedSymbols.add(symbol);
        if (!firstSeen.has(symbol)) {
          firstSeen.set(symbol, {
            fieldPath: field.fieldPath,
            sourceType: field.sourceType,
            stepIndex: field.stepIndex,
            clauseIndex,
            evidence: boundedEvidence(clause.value),
          });
        }
        let provenanceCategory = "undefined_free_symbol";
        let introducedAt = persistentIntroductions.get(symbol) || currentIntroductions.get(symbol) || null;
        let reason = "free symbol was not present in the problem, standard, locally bound, or introduced earlier";
        if (originalSymbols.has(symbol)) {
          provenanceCategory = "original_problem_symbol";
          introducedAt = null;
          reason = "symbol occurs in the original problem";
        } else if (currentIntroductions.has(symbol)) {
          provenanceCategory = currentIntroductions.get(symbol).category;
          reason = `symbol is introduced by ${currentIntroductions.get(symbol).introductionType}`;
        } else if (persistentIntroductions.has(symbol)) {
          provenanceCategory = persistentIntroductions.get(symbol).category;
          reason = `symbol was introduced earlier by ${persistentIntroductions.get(symbol).introductionType}`;
        } else if (
          isStandardSymbolInField(symbol, field.value)
          || FUNCTION_OR_OPERATOR_COMMANDS.has(symbol.replace(/^\\/u, ""))
          || isContextualStandardSymbol(symbol, field.value)
        ) {
          provenanceCategory = "standard_symbol";
          reason = "symbol is a standard constant or operator in this context";
        } else if (
          localSymbols.has(symbol)
          && !hasFreeOccurrenceOutsideBindings(clause.value, symbol, clauseRelativeBindings)
        ) {
          const localIntroduction = introductions.find((record) => record.symbol === symbol && !record.persistent);
          provenanceCategory = localIntroduction?.category || "bound_local";
          introducedAt = localIntroduction || clauseBindings.find((binding) => binding.symbol === symbol) || null;
          reason = `symbol is locally bound by ${introducedAt?.introductionType || introducedAt?.command || "notation"}`;
        }
        const item = {
          symbol,
          classification: legacyClassification(provenanceCategory),
          provenanceCategory,
          reason,
          firstSeen: firstSeen.get(symbol),
          introducedAt,
          scope: introducedAt?.scope || (provenanceCategory === "original_problem_symbol" ? "global_problem" : null),
          local: provenanceCategory === "bound_local" || provenanceCategory === "function_parameter",
        };
        const previous = fieldItems.get(symbol);
        if (!previous || item.provenanceCategory === "undefined_free_symbol") fieldItems.set(symbol, item);
      }

      for (const record of introductions.filter((item) => item.persistent)) {
        allExplicitDefinitions.add(record.symbol);
        if (!persistentIntroductions.has(record.symbol)) persistentIntroductions.set(record.symbol, record);
        knownSymbols.add(record.symbol);
        state.introduced.set(record.symbol, record);
      }
    }

    const symbols = [...fieldItems.values()];
    fieldReportByPath.set(field.fieldPath, {
      ...field,
      knownBeforeStep: state.knownBeforeStep,
      knownBeforeField: fieldKnownBefore,
      localBoundSymbols: [...new Set(fieldBindings.map((binding) => binding.symbol))].sort(),
      symbolsIntroducedByCurrentStep: [...state.introduced.keys()].sort(),
      introductions: fieldIntroductions,
      boundSymbolProvenance: fieldBindings,
      symbols,
      unexplainedSymbols: symbols
        .filter((item) => item.provenanceCategory === "undefined_free_symbol")
        .map((item) => item.symbol),
    });
  }

  const fieldReports = fields.map((field) => fieldReportByPath.get(field.fieldPath)).filter(Boolean);
  for (const [stepKey, state] of stepState) {
    const knownAfterStep = stepKey === "final_answer"
      ? [...knownSymbols].sort()
      : unionSets(new Set(state.knownBeforeStep), new Set(state.introduced.keys()));
    state.knownAfterStep = [...knownAfterStep].sort();
    for (const report of fieldReports.filter((item) => (
      Number.isInteger(item.stepIndex) ? item.stepIndex === stepKey : stepKey === "final_answer"
    ))) {
      report.symbolsIntroducedByCurrentStep = [...state.introduced.keys()].sort();
      report.knownAfterStep = state.knownAfterStep;
    }
  }

  // Presentation slices can lose a binder or introduction that remains visible
  // in the same step's full math. Inheritance is limited to that containing
  // step context; it never creates a new introduction or crosses step order.
  applyStepMathBoundContext(fieldReports);
  applyStepMathIntroductionContext(fieldReports);
  applyStepNamedConstantContext(fieldReports);

  const newlyIntroducedSymbols = [...generatedSymbols].filter((symbol) => !originalSymbols.has(symbol));
  const unexplainedSymbols = [...new Set(fieldReports.flatMap((field) => field.unexplainedSymbols))];
  const provenanceDiagnostics = [...generatedSymbols].sort().map((symbol) => {
    const introduction = persistentIntroductions.get(symbol) || null;
    const unexplainedAt = fieldReports.find((field) => field.unexplainedSymbols.includes(symbol));
    let provenanceCategory = introduction?.category || null;
    if (originalSymbols.has(symbol)) provenanceCategory = "original_problem_symbol";
    else if (unexplainedAt) provenanceCategory = "undefined_free_symbol";
    else if (!provenanceCategory && fieldReports.some((field) => field.symbols.some((item) => (
      item.symbol === symbol && item.provenanceCategory === "standard_symbol"
    )))) provenanceCategory = "standard_symbol";
    else if (!provenanceCategory) provenanceCategory = "bound_local";
    return {
      symbol,
      provenanceCategory,
      firstSeen: firstSeen.get(symbol) || null,
      introducedAt: introduction,
      scope: introduction?.scope || (originalSymbols.has(symbol) ? "global_problem" : provenanceCategory === "bound_local" ? "local_expression" : null),
      local: provenanceCategory === "bound_local" || provenanceCategory === "function_parameter",
      unexplainedAt: unexplainedAt ? {
        fieldPath: unexplainedAt.fieldPath,
        sourceType: unexplainedAt.sourceType,
        stepIndex: unexplainedAt.stepIndex,
        reason: unexplainedAt.symbols.find((item) => item.symbol === symbol)?.reason || "unknown provenance",
      } : null,
    };
  });

  return {
    originalSymbols: [...originalSymbols].sort(),
    generatedSymbols: [...generatedSymbols].sort(),
    newlyIntroducedSymbols: newlyIntroducedSymbols.sort(),
    explicitDefinitions: [...allExplicitDefinitions].sort(),
    fieldReports,
    stepReports: [...stepState.values()].map((state) => ({
      stepIndex: state.stepIndex,
      fieldPaths: state.fieldPaths,
      knownBeforeStep: state.knownBeforeStep,
      symbolsIntroducedByCurrentStep: [...state.introduced.keys()].sort(),
      knownAfterStep: state.knownAfterStep,
    })),
    provenanceDiagnostics,
    boundSymbolProvenance: fieldReports.flatMap((field) => (
      field.boundSymbolProvenance.map((binding) => ({
        ...binding,
        fieldPath: field.fieldPath,
      }))
    )),
    unexplainedSymbols: unexplainedSymbols.sort(),
  };
}
